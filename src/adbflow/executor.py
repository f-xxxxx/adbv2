from __future__ import annotations

import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from .engine import ExecutionResult, WorkflowEngine, WorkflowFormatError
from .nodes import WorkflowCancelledError


class QueueBusyError(RuntimeError):
    pass


class CircuitOpenError(RuntimeError):
    pass


class DuplicateExecutionError(RuntimeError):
    pass


class ExecutionTimeoutError(TimeoutError):
    pass


@dataclass
class ExecutionTask:
    workflow: dict[str, Any]
    on_log: Callable[[str], None] | None = None
    on_event: Callable[[dict[str, Any]], None] | None = None
    cancel_event: threading.Event | None = None
    trigger: str = "manual"
    dedupe_key: str = ""
    timeout_sec: float = 0.0
    max_retries: int = 0
    task_id: str = field(default_factory=lambda: f"task_{uuid.uuid4().hex[:10]}")
    created_at: float = field(default_factory=time.time)
    started_at: float = 0.0
    ended_at: float = 0.0
    result: ExecutionResult | None = None
    error: Exception | None = None
    done_event: threading.Event = field(default_factory=threading.Event)


class ExecutionQueue:
    def __init__(
        self,
        engine: WorkflowEngine,
        *,
        default_timeout_sec: float = 180.0,
        default_max_retries: int = 1,
        retry_backoff_sec: float = 0.6,
        circuit_fail_threshold: int = 3,
        circuit_open_sec: float = 30.0,
        max_queue_size: int = 0,
    ) -> None:
        self._engine = engine
        self._queue: queue.Queue[ExecutionTask] = queue.Queue(maxsize=max(0, int(max_queue_size)))
        self._lock = threading.Lock()
        self._running_task_id: str = ""
        self._started = False
        self._submitted = 0
        self._finished = 0
        self._default_timeout_sec = max(0.0, float(default_timeout_sec))
        self._default_max_retries = max(0, int(default_max_retries))
        self._retry_backoff_sec = max(0.0, float(retry_backoff_sec))
        self._circuit_fail_threshold = max(1, int(circuit_fail_threshold))
        self._circuit_open_sec = max(1.0, float(circuit_open_sec))
        self._circuit_fail_count = 0
        self._circuit_open_until = 0.0
        self._circuit_last_error = ""
        self._active_dedupe_keys: set[str] = set()

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
            threading.Thread(target=self._worker_loop, daemon=True, name="adbflow-execution-queue").start()

    def submit(
        self,
        workflow: dict[str, Any],
        *,
        on_log: Callable[[str], None] | None = None,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        cancel_event: threading.Event | None = None,
        trigger: str = "manual",
        timeout_sec: float | None = None,
        max_retries: int | None = None,
        dedupe_key: str = "",
    ) -> ExecutionTask:
        self.start()
        normalized_key = str(dedupe_key or "").strip()
        with self._lock:
            now = time.time()
            if self._circuit_open_until > now:
                left_sec = round(self._circuit_open_until - now, 2)
                raise CircuitOpenError(f"执行熔断中，请 {left_sec}s 后重试")
            if normalized_key and normalized_key in self._active_dedupe_keys:
                raise DuplicateExecutionError(f"重复执行请求已被拦截，dedupe_key={normalized_key}")
            if self._queue.full():
                raise QueueBusyError("执行队列已满，请稍后重试")
            if normalized_key:
                self._active_dedupe_keys.add(normalized_key)
            self._submitted += 1
        task = ExecutionTask(
            workflow=workflow,
            on_log=on_log,
            on_event=on_event,
            cancel_event=cancel_event or threading.Event(),
            trigger=trigger,
            dedupe_key=normalized_key,
            timeout_sec=self._default_timeout_sec if timeout_sec is None else max(0.0, float(timeout_sec)),
            max_retries=self._default_max_retries if max_retries is None else max(0, int(max_retries)),
        )
        self._queue.put(task)
        return task

    def run(
        self,
        workflow: dict[str, Any],
        *,
        on_log: Callable[[str], None] | None = None,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        cancel_event: threading.Event | None = None,
        trigger: str = "manual",
        timeout: float | None = None,
        timeout_sec: float | None = None,
        max_retries: int | None = None,
        dedupe_key: str = "",
    ) -> ExecutionResult:
        wait_timeout = timeout
        if wait_timeout is None and timeout_sec is not None and timeout_sec > 0:
            wait_timeout = max(float(timeout_sec) + 5.0, float(timeout_sec))
        task = self.submit(
            workflow,
            on_log=on_log,
            on_event=on_event,
            cancel_event=cancel_event,
            trigger=trigger,
            timeout_sec=timeout_sec,
            max_retries=max_retries,
            dedupe_key=dedupe_key,
        )
        finished = task.done_event.wait(timeout=wait_timeout)
        if not finished:
            if task.cancel_event is not None:
                task.cancel_event.set()
            raise TimeoutError(f"执行等待超时，task_id={task.task_id}")
        if task.error is not None:
            raise task.error
        if task.result is None:
            raise RuntimeError(f"执行结果为空，task_id={task.task_id}")
        return task.result

    def stats(self) -> dict[str, int | str | float]:
        with self._lock:
            running = self._running_task_id
            submitted = self._submitted
            finished = self._finished
            now = time.time()
            circuit_open_sec_left = max(0.0, self._circuit_open_until - now)
            circuit_last_error = self._circuit_last_error
            circuit_fail_count = self._circuit_fail_count
        return {
            "queue_size": self._queue.qsize(),
            "running_task_id": running,
            "submitted": submitted,
            "finished": finished,
            "circuit_open_sec_left": round(circuit_open_sec_left, 2),
            "circuit_fail_count": circuit_fail_count,
            "circuit_last_error": circuit_last_error,
        }

    def _worker_loop(self) -> None:
        while True:
            task = self._queue.get()
            try:
                with self._lock:
                    self._running_task_id = task.task_id
                task.started_at = time.time()
                task.result = self._run_task_with_retry(task)
                self._mark_success()
            except Exception as exc:  # noqa: BLE001
                task.error = exc
                self._mark_failure(exc)
            finally:
                task.ended_at = time.time()
                task.done_event.set()
                with self._lock:
                    self._running_task_id = ""
                    self._finished += 1
                    if task.dedupe_key:
                        self._active_dedupe_keys.discard(task.dedupe_key)
                self._queue.task_done()

    def _run_task_with_retry(self, task: ExecutionTask) -> ExecutionResult:
        attempts = max(1, int(task.max_retries) + 1)
        last_exc: Exception | None = None
        for attempt_idx in range(attempts):
            if task.cancel_event is not None and task.cancel_event.is_set():
                raise WorkflowCancelledError("执行已取消")
            try:
                return self._run_with_timeout(task)
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if not self._is_retryable(exc):
                    raise
                if attempt_idx >= attempts - 1:
                    raise
                if task.on_log:
                    task.on_log(
                        f"[执行队列] 第 {attempt_idx + 1}/{attempts} 次失败：{exc}，将重试"
                    )
                backoff = self._retry_backoff_sec * (attempt_idx + 1)
                if backoff > 0:
                    time.sleep(backoff)
        if last_exc is not None:
            raise last_exc
        raise RuntimeError("执行队列重试失败：未知错误")

    def _run_with_timeout(self, task: ExecutionTask) -> ExecutionResult:
        timeout_sec = float(task.timeout_sec or 0.0)
        timed_out = False
        timer: threading.Timer | None = None

        if timeout_sec > 0:
            def _on_timeout() -> None:
                nonlocal timed_out
                timed_out = True
                if task.cancel_event is not None:
                    task.cancel_event.set()

            timer = threading.Timer(timeout_sec, _on_timeout)
            timer.daemon = True
            timer.start()

        try:
            result = self._engine.run(
                task.workflow,
                on_log=task.on_log,
                on_event=task.on_event,
                cancel_event=task.cancel_event,
            )
        except WorkflowCancelledError as exc:
            if timed_out:
                raise ExecutionTimeoutError(f"执行超时（>{timeout_sec:.1f}s）") from exc
            raise
        finally:
            if timer is not None:
                timer.cancel()

        if timed_out:
            raise ExecutionTimeoutError(f"执行超时（>{timeout_sec:.1f}s）")
        return result

    @staticmethod
    def _is_retryable(exc: Exception) -> bool:
        if isinstance(exc, (WorkflowCancelledError, WorkflowFormatError, ExecutionTimeoutError)):
            return False
        return True

    def _mark_success(self) -> None:
        with self._lock:
            self._circuit_fail_count = 0
            self._circuit_open_until = 0.0
            self._circuit_last_error = ""

    def _mark_failure(self, exc: Exception) -> None:
        if isinstance(exc, (WorkflowCancelledError, WorkflowFormatError, DuplicateExecutionError)):
            return
        with self._lock:
            self._circuit_fail_count += 1
            self._circuit_last_error = str(exc)
            if self._circuit_fail_count >= self._circuit_fail_threshold:
                self._circuit_open_until = time.time() + self._circuit_open_sec
