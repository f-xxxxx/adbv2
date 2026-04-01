from __future__ import annotations

import json
import queue
import threading
import time
import uuid
from copy import deepcopy
from pathlib import Path

from flask import Blueprint, Response, jsonify, request, stream_with_context
import webapp_state as state
from routes.api_response import err

from helpers import (
    _collect_schedule_export_dirs,
    _prepare_workflow_export_paths,
    _resolve_report_path,
    _write_execution_report,
)
from webapp_state import (
    WORKFLOWS_DIR,
    _MANUAL_RUN_LOCK,
    _MANUAL_RUN_STATE,
    _SCHEDULER_LOCK,
    _SCHEDULES,
    _decrement_schedule_running,
    _get_schedule_cancel_event,
    _increment_schedule_running,
    _is_scheduler_running_locked,
    _mark_scheduler_started,
    _set_schedule_cancel_event,
    execution_queue,
)

from src.adbflow.engine import ExecutionResult
from src.adbflow.error_codes import ErrorCode
from src.adbflow.executor import CircuitOpenError, DuplicateExecutionError, ExecutionTimeoutError, QueueBusyError
from src.adbflow.observability import log_event, new_run_id
from src.adbflow.persistence import (
    insert_run,
    load_schedules as db_load_schedules,
    replace_schedules as db_replace_schedules,
)
from src.adbflow.workflow_contract import normalize_workflow

schedules_bp = Blueprint("schedules", __name__)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@schedules_bp.get("/api/schedules")
def list_schedules():
    _ensure_scheduler_started()
    with _SCHEDULER_LOCK:
        items = sorted(
            _SCHEDULES.values(),
            key=lambda x: float(x.get("created_at", 0.0) or 0.0),
            reverse=True,
        )
    return jsonify({"ok": True, "items": items})


@schedules_bp.post("/api/schedules")
def create_schedule():
    _ensure_scheduler_started()
    payload = request.get_json(silent=True) or {}
    workflow_name = str(payload.get("workflow_name", "")).strip()
    workflow_data = payload.get("workflow")
    interval_default = max(10, int(state.SCHEDULE_DEFAULT_INTERVAL_SEC))
    max_runs_default = max(0, int(state.SCHEDULE_DEFAULT_MAX_RUNS))
    interval_sec = int(payload.get("interval_sec", interval_default) or interval_default)
    max_runs = max(0, int(payload.get("max_runs", max_runs_default) or max_runs_default))
    task_name = str(payload.get("task_name", "")).strip()
    run_now = bool(payload.get("run_now", bool(state.SCHEDULE_AUTO_RUN_ON_CREATE)))
    if interval_sec < 10:
        interval_sec = 10

    workflow_snapshot: dict[str, object] = {}
    source_name = ""
    if isinstance(workflow_data, dict) and workflow_data:
        workflow_snapshot = workflow_data
        source_name = "工作区工作流"
    elif workflow_name:
        workflow_path = (WORKFLOWS_DIR / Path(workflow_name).name).resolve()
        if workflow_path.parent != WORKFLOWS_DIR or not workflow_path.exists():
            return err("工作流文件不存在", ErrorCode.NOT_FOUND, 404)
        with workflow_path.open("r", encoding="utf-8") as f:
            loaded = json.load(f)
        if not isinstance(loaded, dict) or not loaded:
            return err("工作流文件内容无效", ErrorCode.WORKFLOW_INVALID, 400)
        workflow_snapshot = loaded
        source_name = workflow_path.name
    else:
        return err("缺少 workflow（当前工作区工作流）", ErrorCode.BAD_REQUEST, 400)

    try:
        workflow_snapshot, migration_warnings = normalize_workflow(workflow_snapshot)
    except ValueError as exc:
        return err(f"工作流无效：{exc}", ErrorCode.WORKFLOW_INVALID, 400)

    schedule_id = uuid.uuid4().hex[:10]
    now = time.time()
    if not task_name:
        task_name = f"调度任务-{schedule_id[:6]}"
    export_dirs = _collect_schedule_export_dirs(workflow_snapshot, schedule_id)
    item: dict[str, object] = {
        "id": schedule_id,
        "task_name": task_name[:120],
        "created_at": now,
        "workflow_name": source_name,
        "workflow_data": workflow_snapshot,
        "export_dirs": export_dirs,
        "interval_sec": interval_sec,
        "max_runs": max_runs,
        "run_count": 0,
        "enabled": True,
        "next_run_at": now + interval_sec,
        "last_run_at": 0.0,
        "last_status": "",
        "last_error": "",
        "last_report_path": "",
        "last_run_id": "",
    }
    with _SCHEDULER_LOCK:
        if run_now and _is_scheduler_running_locked():
            return err("已有调度任务执行中，请稍后再试", ErrorCode.CONFLICT, 409)
        _SCHEDULES[schedule_id] = item
        if run_now:
            item["last_status"] = "running"
            item["next_run_at"] = time.time() + interval_sec
        _save_schedules_locked()
    if run_now:
        _trigger_schedule_run_now(schedule_id)
    return jsonify({"ok": True, "item": item, "migration_warnings": migration_warnings})


@schedules_bp.post("/api/schedules/toggle")
def toggle_schedule():
    _ensure_scheduler_started()
    payload = request.get_json(silent=True) or {}
    schedule_id = str(payload.get("id", "")).strip()
    enabled = bool(payload.get("enabled", True))
    run_now = payload.get("run_now") is True
    if not schedule_id:
        return err("缺少 id", ErrorCode.BAD_REQUEST, 400)
    with _SCHEDULER_LOCK:
        item = _SCHEDULES.get(schedule_id)
        if not item:
            return err("任务不存在", ErrorCode.NOT_FOUND, 404)
        if enabled and run_now and _is_scheduler_running_locked():
            return err("已有调度任务执行中，请稍后再试", ErrorCode.CONFLICT, 409)
        item["enabled"] = enabled
        if enabled:
            interval_sec = max(10, int(item.get("interval_sec", 300)))
            item["next_run_at"] = time.time() + interval_sec
            if run_now:
                item["last_status"] = "running"
                item["last_error"] = ""
        _save_schedules_locked()
        result_item = dict(item)
    if enabled and run_now:
        _trigger_schedule_run_now(schedule_id)
    return jsonify({"ok": True, "item": result_item})


@schedules_bp.post("/api/schedules/run-now")
def run_schedule_now():
    _ensure_scheduler_started()
    payload = request.get_json(silent=True) or {}
    schedule_id = str(payload.get("id", "")).strip()
    if not schedule_id:
        return err("缺少 id", ErrorCode.BAD_REQUEST, 400)

    with _MANUAL_RUN_LOCK:
        if bool(_MANUAL_RUN_STATE.get("running")):
            return err("已有手动执行任务正在运行，请稍后再试", ErrorCode.CONFLICT, 409)

        with _SCHEDULER_LOCK:
            item = _SCHEDULES.get(schedule_id)
            if not item:
                return err("任务不存在", ErrorCode.NOT_FOUND, 404)
            if _is_scheduler_running_locked():
                return err("已有调度任务执行中，请稍后再试", ErrorCode.CONFLICT, 409)

            export_dirs_raw = item.get("export_dirs")
            export_dirs = [str(x).strip() for x in export_dirs_raw] if isinstance(export_dirs_raw, list) else []
            item["run_count"] = 0
            item["last_run_at"] = 0.0
            item["last_status"] = "running"
            item["last_error"] = ""
            item["last_report_path"] = ""
            item["last_run_id"] = ""
            _save_schedules_locked()
            result_item = dict(item)

    _clear_schedule_outputs(schedule_id, export_dirs)
    _trigger_schedule_run_now(schedule_id)
    return jsonify({"ok": True, "item": result_item})


@schedules_bp.post("/api/schedules/run-now-stream")
def run_schedule_now_stream():
    _ensure_scheduler_started()
    payload = request.get_json(silent=True) or {}
    schedule_id = str(payload.get("id", "")).strip()
    if not schedule_id:
        return err("缺少 id", ErrorCode.BAD_REQUEST, 400)

    with _MANUAL_RUN_LOCK:
        if bool(_MANUAL_RUN_STATE.get("running")):
            return err("已有手动执行任务正在运行，请稍后再试", ErrorCode.CONFLICT, 409)

        with _SCHEDULER_LOCK:
            item = _SCHEDULES.get(schedule_id)
            if not item:
                return err("任务不存在", ErrorCode.NOT_FOUND, 404)
            if _is_scheduler_running_locked():
                return err("已有调度任务执行中，请稍后再试", ErrorCode.CONFLICT, 409)

            export_dirs_raw = item.get("export_dirs")
            export_dirs = [str(x).strip() for x in export_dirs_raw] if isinstance(export_dirs_raw, list) else []
            workflow_name = str(item.get("workflow_name", "")).strip()
            workflow_data = deepcopy(item.get("workflow_data")) if isinstance(item.get("workflow_data"), dict) else {}
            max_runs = max(0, int(item.get("max_runs", 0) or 0))
            interval_sec = max(10, int(item.get("interval_sec", 300) or 300))

            item["run_count"] = 0
            item["last_run_at"] = 0.0
            item["last_status"] = "running"
            item["last_error"] = ""
            item["last_report_path"] = ""
            item["last_run_id"] = ""
            item["next_run_at"] = time.time() + interval_sec
            _increment_schedule_running()
            _save_schedules_locked()

    _clear_schedule_outputs(schedule_id, export_dirs)

    cancel_event = threading.Event()
    _set_schedule_cancel_event(cancel_event)

    event_queue: queue.Queue[dict[str, object] | None] = queue.Queue(
        maxsize=max(1, int(state.STREAM_EVENT_QUEUE_SIZE))
    )
    result_holder: dict[str, object] = {}
    error_holder: dict[str, str] = {}
    dropped_events: dict[str, int] = {"log": 0, "event": 0}

    event_ctx = _RunEventCtx()

    def _queue_put_nowait_safe(
        item: dict[str, object] | None,
        *,
        drop_key: str = "event",
    ) -> bool:
        try:
            event_queue.put_nowait(item)
            return True
        except queue.Full:
            dropped_events[drop_key] = int(dropped_events.get(drop_key, 0)) + 1
            return False

    def _queue_force_close_signal() -> None:
        while True:
            if _queue_put_nowait_safe(None):
                return
            try:
                event_queue.get_nowait()
            except queue.Empty:
                continue

    def on_log(line: str) -> None:
        _queue_put_nowait_safe({"type": "log", "line": line}, drop_key="log")

    def on_event(evt: dict[str, object], run_id: str) -> None:
        _record_engine_event(
            run_id=run_id,
            schedule_id=schedule_id,
            evt=evt,
            event_ctx=event_ctx,
        )
        _queue_put_nowait_safe({"type": "event", **evt}, drop_key="event")

    def _run_single_batch(batch_no: int) -> tuple[bool, str, str, ExecutionResult | None, str, str]:
        """Run one batch and return (ok, err, err_code, result, report_path, run_id)."""
        b_ok = False
        b_err = ""
        b_err_code = ""
        b_result: ExecutionResult | None = None
        prepared_workflow: dict[str, object] = {}
        batch_started_at = time.time()
        run_id = new_run_id("sch")

        if isinstance(workflow_data, dict) and workflow_data:
            try:
                normalized_workflow, _mw = normalize_workflow(workflow_data)
                prepared_workflow = _prepare_workflow_export_paths(
                    normalized_workflow,
                    trigger="schedule",
                    schedule_id=schedule_id,
                    schedule_batch=batch_no,
                )
            except Exception as exc:  # noqa: BLE001
                b_err = str(exc)
                b_err_code = ErrorCode.WORKFLOW_INVALID
        else:
            wf_path = (WORKFLOWS_DIR / Path(workflow_name).name).resolve()
            if wf_path.parent != WORKFLOWS_DIR or not wf_path.exists():
                b_err = f"调度工作流不存在：{workflow_name}"
            else:
                try:
                    with wf_path.open("r", encoding="utf-8") as f:
                        loaded = json.load(f)
                    loaded, _mw = normalize_workflow(loaded)
                    prepared_workflow = _prepare_workflow_export_paths(
                        loaded,
                        trigger="schedule",
                        schedule_id=schedule_id,
                        schedule_batch=batch_no,
                    )
                except Exception as exc:  # noqa: BLE001
                    b_err = str(exc)
                    b_err_code = ErrorCode.WORKFLOW_INVALID

        insert_run(
            run_id=run_id,
            trigger=f"schedule:{schedule_id}:batch:{batch_no}",
            schedule_id=schedule_id,
            started_at=batch_started_at,
            workflow_node_count=len(prepared_workflow or {}),
        )
        if not b_err:
            try:
                b_result = execution_queue.run(
                    prepared_workflow,
                    on_log=on_log,
                    on_event=lambda evt: on_event(evt, run_id),
                    cancel_event=cancel_event,
                    trigger=f"schedule:{schedule_id}:batch:{batch_no}",
                    timeout_sec=state.SCHEDULE_RUN_TIMEOUT_SEC,
                    dedupe_key=f"schedule:{schedule_id}",
                )
                b_ok = True
            except (ExecutionTimeoutError, TimeoutError) as exc:
                b_err = str(exc)
                b_err_code = ErrorCode.RUN_TIMEOUT
            except CircuitOpenError as exc:
                b_err = str(exc)
                b_err_code = ErrorCode.CIRCUIT_OPEN
            except (QueueBusyError, DuplicateExecutionError) as exc:
                b_err = str(exc)
                b_err_code = ErrorCode.DUPLICATE_EXECUTION
            except Exception as exc:  # noqa: BLE001
                b_err = str(exc)
                b_err_code = ErrorCode.RUN_FAILED
            finally:
                _flush_run_events(event_ctx)

        rp = _write_execution_report(
            workflow=prepared_workflow if b_ok else {},
            result=b_result,
            started_at=batch_started_at,
            trigger=f"schedule:{schedule_id}:batch:{batch_no}",
            ok=b_ok,
            error=b_err,
            run_id=run_id,
            schedule_id=schedule_id,
            error_code=b_err_code,
        )
        log_event(
            "schedule_batch_finish",
            run_id=run_id,
            schedule_id=schedule_id,
            batch_no=batch_no,
            ok=b_ok,
            error=b_err,
            error_code=b_err_code,
        )
        return b_ok, b_err, b_err_code, b_result, str(rp), run_id

    def worker() -> None:
        total_batches = max(1, max_runs) if max_runs > 0 else 0
        last_ok = False
        last_err = ""
        last_err_code = ""
        last_result: ExecutionResult | None = None
        last_report = ""
        last_run_id = ""
        batch_no = 0
        cancelled = False

        if total_batches > 0:
            batch_range = range(1, total_batches + 1)
        else:
            # max_runs == 0 means unlimited; but for stream mode run once
            batch_range = range(1, 2)

        for batch_no in batch_range:
            if cancel_event.is_set():
                on_log("--- 调度任务已被用户中止 ---")
                last_err = "执行已取消"
                cancelled = True
                break

            on_log(f"--- 第 {batch_no}/{total_batches or '∞'} 批次开始 ---")
            last_ok, last_err, last_err_code, last_result, last_report, last_run_id = _run_single_batch(batch_no)

            with _SCHEDULER_LOCK:
                saved_item = _SCHEDULES.get(schedule_id)
                if saved_item:
                    saved_item["last_run_at"] = time.time()
                    saved_item["run_count"] = batch_no
                    saved_item["last_error"] = last_err
                    saved_item["last_report_path"] = last_report
                    saved_item["last_run_id"] = last_run_id
                    if not last_ok:
                        saved_item["last_status"] = "error"
                    elif total_batches > 0 and batch_no < total_batches:
                        saved_item["last_status"] = "running"
                    else:
                        saved_item["last_status"] = "ok"
                    _save_schedules_locked()

            if not last_ok:
                # Check if it was a cancellation
                if cancel_event.is_set() or "已取消" in last_err:
                    on_log(f"--- 第 {batch_no} 批次已中止 ---")
                    cancelled = True
                else:
                    on_log(f"--- 第 {batch_no} 批次失败，停止后续执行 ---")
                break

            if total_batches > 0 and batch_no >= total_batches:
                break

            # Wait interval between batches (interruptible)
            on_log(f"--- 等待 {interval_sec} 秒后执行下一批次 ---")
            if _sleep_with_cancel(cancel_event, interval_sec):
                on_log("--- 调度任务已被用户中止 ---")
                last_err = "执行已取消"
                cancelled = True
                break

        # Final state update
        _set_schedule_cancel_event(None)
        with _SCHEDULER_LOCK:
            _decrement_schedule_running()
            saved_item = _SCHEDULES.get(schedule_id)
            if saved_item:
                if cancelled:
                    saved_item["last_status"] = "cancelled"
                    saved_item["last_error"] = "执行已取消"
                elif last_ok and total_batches > 0 and batch_no >= total_batches:
                    saved_item["last_status"] = "done"
                    saved_item["enabled"] = False
                    saved_item["next_run_at"] = 0.0
                elif not last_ok:
                    saved_item["last_status"] = "error"
                else:
                    saved_item["last_status"] = "ok"
                _save_schedules_locked()
            else:
                _save_schedules_locked()

        if cancelled:
            error_holder["error"] = "执行已取消"
            error_holder["error_code"] = ErrorCode.WORKFLOW_CANCELLED
        elif last_ok and last_result is not None:
            result_holder["result"] = last_result
            result_holder["report_path"] = last_report
            result_holder["run_id"] = last_run_id
        else:
            error_holder["error"] = last_err or "执行失败"
            error_holder["error_code"] = last_err_code or ErrorCode.RUN_FAILED
        _flush_run_events(event_ctx)
        dropped_log = int(dropped_events.get("log", 0))
        dropped_evt = int(dropped_events.get("event", 0))
        dropped_total = dropped_log + dropped_evt
        if dropped_total > 0 and dropped_total >= max(0, int(state.STREAM_DROP_WARN_THRESHOLD)):
            _queue_put_nowait_safe(
                {
                    "type": "log",
                    "line": f"[流式输出] 队列拥塞，已丢弃日志 {dropped_log} 条、事件 {dropped_evt} 条",
                },
                drop_key="log",
            )
            log_event(
                "schedule_stream_queue_dropped",
                schedule_id=schedule_id,
                dropped_log=dropped_log,
                dropped_event=dropped_evt,
            )
        _queue_force_close_signal()

    threading.Thread(target=worker, daemon=True).start()

    @stream_with_context
    def generate():
        try:
            while True:
                try:
                    item = event_queue.get(timeout=1.0)
                except queue.Empty:
                    continue
                if item is None:
                    break
                yield json.dumps(item, ensure_ascii=False) + "\n"

            if "error" in error_holder:
                yield json.dumps(
                    {
                        "type": "error",
                        "error": error_holder["error"],
                        "error_code": error_holder.get("error_code", ErrorCode.RUN_FAILED),
                    },
                    ensure_ascii=False,
                ) + "\n"
                return

            result = result_holder.get("result")
            if isinstance(result, ExecutionResult):
                yield json.dumps(
                    {
                        "type": "result",
                        "outputs": result.outputs,
                        "logs": result.logs,
                        "report_path": result_holder.get("report_path", ""),
                        "run_id": result_holder.get("run_id", ""),
                    },
                    ensure_ascii=False,
                ) + "\n"
                return

            yield json.dumps(
                {"type": "error", "error": "执行流未返回结果", "error_code": ErrorCode.INTERNAL_ERROR},
                ensure_ascii=False,
            ) + "\n"
        except GeneratorExit:
            cancel_event.set()
            raise

    return Response(generate(), mimetype="application/x-ndjson")


@schedules_bp.delete("/api/schedules/<schedule_id>")
def delete_schedule(schedule_id: str):
    _ensure_scheduler_started()
    sid = str(schedule_id).strip()
    with _SCHEDULER_LOCK:
        existed = _SCHEDULES.pop(sid, None)
        _save_schedules_locked()
    if not existed:
        return err("任务不存在", ErrorCode.NOT_FOUND, 404)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Scheduler internals
# ---------------------------------------------------------------------------


class _RunEventCtx:
    def __init__(self) -> None:
        self._start_by_node: dict[str, float] = {}
        self._pending_events: list[dict[str, object]] = []
        self._last_flush_at = time.time()
        self._lock = threading.Lock()

    def mark_start(self, node_id: str, ts: float) -> None:
        with self._lock:
            self._start_by_node[str(node_id)] = float(ts)

    def pop_start(self, node_id: str) -> float | None:
        with self._lock:
            return self._start_by_node.pop(str(node_id), None)

    def append_event(self, item: dict[str, object]) -> int:
        with self._lock:
            self._pending_events.append(item)
            return len(self._pending_events)

    def should_flush_by_time(self, interval_sec: float = 1.0) -> bool:
        with self._lock:
            return (time.time() - self._last_flush_at) >= max(0.1, float(interval_sec))

    def pop_pending_events(self) -> list[dict[str, object]]:
        with self._lock:
            if not self._pending_events:
                self._last_flush_at = time.time()
                return []
            events = self._pending_events
            self._pending_events = []
            self._last_flush_at = time.time()
            return events


def _record_engine_event(
    run_id: str,
    schedule_id: str,
    evt: dict[str, object],
    event_ctx: _RunEventCtx,
) -> None:
    event_name = str(evt.get("event", "")).strip()
    node_id = str(evt.get("node_id", "")).strip()
    class_type = str(evt.get("class_type", "")).strip()
    now = time.time()
    duration_ms: float | None = None

    if event_name == "node_start" and node_id:
        event_ctx.mark_start(node_id, now)
    elif event_name == "node_done" and node_id:
        started = event_ctx.pop_start(node_id)
        if started is not None:
            duration_ms = max(0.0, (now - started) * 1000.0)

    pending_size = event_ctx.append_event(
        {
            "run_id": run_id,
            "schedule_id": schedule_id,
            "node_id": node_id,
            "class_type": class_type,
            "event": event_name or "unknown",
            "ts": now,
            "duration_ms": duration_ms,
            "payload": {k: v for k, v in evt.items() if k != "event"},
        }
    )
    if pending_size >= 30 or event_ctx.should_flush_by_time(1.0):
        _flush_run_events(event_ctx)
    log_event(
        "workflow_node_event",
        run_id=run_id,
        schedule_id=schedule_id,
        node_id=node_id,
        class_type=class_type,
        node_event=event_name,
        duration_ms=round(duration_ms, 2) if duration_ms is not None else None,
    )


def _flush_run_events(event_ctx: _RunEventCtx) -> None:
    from src.adbflow.persistence import insert_node_events_bulk

    pending = event_ctx.pop_pending_events()
    if not pending:
        return
    insert_node_events_bulk(pending)


def _sleep_with_cancel(cancel_event: threading.Event, seconds: float) -> bool:
    """Sleep for *seconds*, checking cancel_event every 0.5s. Returns True if cancelled."""
    remaining = max(0.0, float(seconds))
    while remaining > 0:
        if cancel_event.is_set():
            return True
        chunk = min(0.5, remaining)
        time.sleep(chunk)
        remaining -= chunk
    return cancel_event.is_set()


def _load_schedules() -> dict[str, dict[str, object]]:
    data = db_load_schedules()
    result: dict[str, dict[str, object]] = {}
    for sid, raw in data.items():
        if not isinstance(raw, dict):
            continue
        sid_text = str(sid).strip()
        if not sid_text:
            continue
        item = dict(raw)
        item["id"] = sid_text
        item["workflow_name"] = str(item.get("workflow_name", "")).strip()
        task_name = str(item.get("task_name", "")).strip()
        if not task_name:
            task_name = f"调度任务-{sid_text[:6]}"
        item["task_name"] = task_name[:120]
        created_at_val = float(item.get("created_at", 0.0) or 0.0)
        if created_at_val <= 0:
            created_at_val = time.time()
        item["created_at"] = created_at_val
        workflow_data = item.get("workflow_data")
        if isinstance(workflow_data, dict):
            try:
                normalized_wf, _warnings = normalize_workflow(workflow_data)
            except ValueError:
                normalized_wf = {}
            item["workflow_data"] = normalized_wf
        else:
            item["workflow_data"] = {}
        export_dirs = item.get("export_dirs")
        if isinstance(export_dirs, list):
            item["export_dirs"] = [str(x).strip() for x in export_dirs if str(x).strip()]
        else:
            item["export_dirs"] = _collect_schedule_export_dirs(item["workflow_data"], sid_text)
        item["interval_sec"] = max(10, int(item.get("interval_sec", 300) or 300))
        item["max_runs"] = max(0, int(item.get("max_runs", 0) or 0))
        item["run_count"] = max(0, int(item.get("run_count", 0) or 0))
        item["enabled"] = bool(item.get("enabled", True))
        item["next_run_at"] = float(item.get("next_run_at", time.time() + item["interval_sec"]))
        item["last_run_at"] = float(item.get("last_run_at", 0.0))
        item["last_status"] = str(item.get("last_status", ""))
        item["last_error"] = str(item.get("last_error", ""))
        item["last_report_path"] = str(item.get("last_report_path", ""))
        item["last_run_id"] = str(item.get("last_run_id", ""))
        result[sid_text] = item
    return result


def _save_schedules_locked() -> None:
    data = {sid: item for sid, item in _SCHEDULES.items()}
    db_replace_schedules(data)


def _ensure_scheduler_started() -> None:
    with _SCHEDULER_LOCK:
        if state._SCHEDULER_STARTED:
            return
        _SCHEDULES.clear()
        _SCHEDULES.update(_load_schedules())
        thread = threading.Thread(target=_scheduler_loop, daemon=True, name="adbflow-scheduler")
        thread.start()
        _mark_scheduler_started()


def _trigger_schedule_run_now(schedule_id: str) -> None:
    sid = str(schedule_id).strip()
    if not sid:
        return
    threading.Thread(
        target=_run_schedule_once,
        args=(sid,),
        kwargs={"force": True},
        daemon=True,
        name=f"adbflow-schedule-run-now-{sid}",
    ).start()


def _clear_schedule_outputs(schedule_id: str, export_dirs: list[str]) -> None:
    report_path = _resolve_report_path(f"schedule:{schedule_id}:batch:0")
    try:
        report_path.unlink(missing_ok=True)
    except Exception:
        pass

    for raw_dir in export_dirs:
        dir_text = str(raw_dir or "").strip()
        if not dir_text:
            continue
        try:
            p = Path(dir_text).expanduser()
            if not p.is_absolute():
                p = (Path.cwd() / p).resolve()
            else:
                p = p.resolve()
            if not p.exists() or not p.is_dir():
                continue
            for child in p.iterdir():
                if not child.is_file():
                    continue
                if child.suffix.lower() not in {".xlsx", ".xls", ".csv"}:
                    continue
                child.unlink(missing_ok=True)
        except Exception:
            continue


def _scheduler_loop() -> None:
    while True:
        now = time.time()
        due_ids: list[str] = []
        with _SCHEDULER_LOCK:
            for sid, item in _SCHEDULES.items():
                if not bool(item.get("enabled", True)):
                    continue
                if float(item.get("next_run_at", 0)) <= now:
                    due_ids.append(sid)

        for sid in due_ids:
            _run_schedule_once(sid)

        time.sleep(1.0)


def _run_schedule_once(schedule_id: str, force: bool = False) -> None:
    with _MANUAL_RUN_LOCK:
        manual_running = bool(_MANUAL_RUN_STATE.get("running"))
        with _SCHEDULER_LOCK:
            item = _SCHEDULES.get(schedule_id)
            if not item:
                return
            if not force and not bool(item.get("enabled", True)):
                return
            if manual_running:
                item["last_status"] = "busy"
                item["last_error"] = "已有手动执行任务正在运行，本次调度已跳过"
                _save_schedules_locked()
                return
            if _is_scheduler_running_locked():
                item["last_status"] = "busy"
                item["last_error"] = "已有调度任务执行中，本次触发已跳过"
                _save_schedules_locked()
                return
            workflow_name = str(item.get("workflow_name", "")).strip()
            workflow_data = item.get("workflow_data")
            max_runs = max(0, int(item.get("max_runs", 0) or 0))
            run_count = max(0, int(item.get("run_count", 0) or 0))
            batch_no = run_count + 1
            if max_runs > 0 and run_count >= max_runs:
                item["enabled"] = False
                item["next_run_at"] = 0.0
                item["last_status"] = "done"
                item["last_error"] = ""
                _save_schedules_locked()
                return
            interval_sec = max(10, int(item.get("interval_sec", 300) or 300))
            item["next_run_at"] = time.time() + interval_sec
            item["last_status"] = "running"
            item["last_error"] = ""
            item["last_run_id"] = ""
            if not item.get("export_dirs"):
                item["export_dirs"] = _collect_schedule_export_dirs(
                    item.get("workflow_data") if isinstance(item.get("workflow_data"), dict) else {},
                    schedule_id,
                )
            _increment_schedule_running()
            _save_schedules_locked()

    started = time.time()
    run_id = new_run_id("sch")
    ok = False
    err = ""
    err_code = ""
    result: ExecutionResult | None = None
    workflow: dict[str, object] = {}
    if isinstance(workflow_data, dict) and workflow_data:
        try:
            normalized_workflow, _mw = normalize_workflow(workflow_data)
            workflow = _prepare_workflow_export_paths(
                normalized_workflow,
                trigger="schedule",
                schedule_id=schedule_id,
                schedule_batch=batch_no,
            )
        except Exception as exc:  # noqa: BLE001
            err = str(exc)
            err_code = ErrorCode.WORKFLOW_INVALID
    else:
        workflow_path = (WORKFLOWS_DIR / Path(workflow_name).name).resolve()
        if workflow_path.parent != WORKFLOWS_DIR or not workflow_path.exists():
            err = f"调度工作流不存在：{workflow_name}"
        else:
            try:
                with workflow_path.open("r", encoding="utf-8") as f:
                    loaded = json.load(f)
                loaded, _mw = normalize_workflow(loaded)
                workflow = _prepare_workflow_export_paths(
                    loaded,
                    trigger="schedule",
                    schedule_id=schedule_id,
                    schedule_batch=batch_no,
                )
            except Exception as exc:  # noqa: BLE001
                err = str(exc)
                err_code = ErrorCode.WORKFLOW_INVALID

    insert_run(
        run_id=run_id,
        trigger=f"schedule:{schedule_id}:batch:{batch_no}",
        schedule_id=schedule_id,
        started_at=started,
        workflow_node_count=len(workflow or {}),
    )
    event_ctx = _RunEventCtx()

    if not err:
        try:
            result = execution_queue.run(
                workflow,
                on_event=lambda evt: _record_engine_event(
                    run_id=run_id,
                    schedule_id=schedule_id,
                    evt=evt,
                event_ctx=event_ctx,
            ),
            trigger=f"schedule:{schedule_id}:batch:{batch_no}",
            timeout_sec=state.SCHEDULE_RUN_TIMEOUT_SEC,
            dedupe_key=f"schedule:{schedule_id}",
        )
            ok = True
        except (ExecutionTimeoutError, TimeoutError) as exc:
            err = str(exc)
            err_code = ErrorCode.RUN_TIMEOUT
        except CircuitOpenError as exc:
            err = str(exc)
            err_code = ErrorCode.CIRCUIT_OPEN
        except (QueueBusyError, DuplicateExecutionError) as exc:
            err = str(exc)
            err_code = ErrorCode.DUPLICATE_EXECUTION
        except Exception as exc:  # noqa: BLE001
            err = str(exc)
            err_code = ErrorCode.RUN_FAILED
        finally:
            _flush_run_events(event_ctx)

    report_path = _write_execution_report(
        workflow=workflow if ok else {},
        result=result,
        started_at=started,
        trigger=f"schedule:{schedule_id}:batch:{batch_no}",
        ok=ok,
        error=err,
        run_id=run_id,
        schedule_id=schedule_id,
        error_code=err_code,
    )
    log_event(
        "schedule_run_finish",
        run_id=run_id,
        schedule_id=schedule_id,
        batch_no=batch_no,
        ok=ok,
        error=err,
        error_code=err_code,
    )

    with _SCHEDULER_LOCK:
        _decrement_schedule_running()
        item = _SCHEDULES.get(schedule_id)
        if not item:
            _save_schedules_locked()
            return
        item["last_run_at"] = time.time()
        next_run_count = max(0, int(item.get("run_count", 0) or 0)) + 1
        item["run_count"] = next_run_count
        item["last_error"] = err
        item["last_report_path"] = str(report_path)
        item["last_run_id"] = run_id
        max_runs = max(0, int(item.get("max_runs", 0) or 0))
        if not ok:
            item["last_status"] = "error"
        elif max_runs > 0 and next_run_count < max_runs:
            item["last_status"] = "running"
        else:
            item["last_status"] = "ok"
        if max_runs > 0 and next_run_count >= max_runs:
            item["enabled"] = False
            item["next_run_at"] = 0.0
            if ok:
                item["last_status"] = "done"
        _save_schedules_locked()
