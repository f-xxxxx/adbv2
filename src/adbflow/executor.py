from __future__ import annotations

import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from .engine import ExecutionResult, WorkflowEngine


@dataclass
class ExecutionTask:
    workflow: dict[str, Any]
    on_log: Callable[[str], None] | None = None
    on_event: Callable[[dict[str, Any]], None] | None = None
    cancel_event: threading.Event | None = None
    trigger: str = "manual"
    task_id: str = field(default_factory=lambda: f"task_{uuid.uuid4().hex[:10]}")
    created_at: float = field(default_factory=time.time)
    started_at: float = 0.0
    ended_at: float = 0.0
    result: ExecutionResult | None = None
    error: Exception | None = None
    done_event: threading.Event = field(default_factory=threading.Event)


class ExecutionQueue:
    def __init__(self, engine: WorkflowEngine) -> None:
        self._engine = engine
        self._queue: queue.Queue[ExecutionTask] = queue.Queue()
        self._lock = threading.Lock()
        self._running_task_id: str = ""
        self._started = False
        self._submitted = 0
        self._finished = 0

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
    ) -> ExecutionTask:
        self.start()
        task = ExecutionTask(
            workflow=workflow,
            on_log=on_log,
            on_event=on_event,
            cancel_event=cancel_event,
            trigger=trigger,
        )
        with self._lock:
            self._submitted += 1
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
    ) -> ExecutionResult:
        task = self.submit(
            workflow,
            on_log=on_log,
            on_event=on_event,
            cancel_event=cancel_event,
            trigger=trigger,
        )
        finished = task.done_event.wait(timeout=timeout)
        if not finished:
            raise TimeoutError(f"执行超时，task_id={task.task_id}")
        if task.error is not None:
            raise task.error
        if task.result is None:
            raise RuntimeError(f"执行结果为空，task_id={task.task_id}")
        return task.result

    def stats(self) -> dict[str, int | str]:
        with self._lock:
            running = self._running_task_id
            submitted = self._submitted
            finished = self._finished
        return {
            "queue_size": self._queue.qsize(),
            "running_task_id": running,
            "submitted": submitted,
            "finished": finished,
        }

    def _worker_loop(self) -> None:
        while True:
            task = self._queue.get()
            try:
                with self._lock:
                    self._running_task_id = task.task_id
                task.started_at = time.time()
                task.result = self._engine.run(
                    task.workflow,
                    on_log=task.on_log,
                    on_event=task.on_event,
                    cancel_event=task.cancel_event,
                )
            except Exception as exc:  # noqa: BLE001
                task.error = exc
            finally:
                task.ended_at = time.time()
                task.done_event.set()
                with self._lock:
                    self._running_task_id = ""
                    self._finished += 1
                self._queue.task_done()
