from __future__ import annotations

import json
import queue
import threading
import time
from pathlib import Path

from flask import Blueprint, Response, jsonify, render_template, request, stream_with_context

from routes.api_response import err
from helpers import _prepare_workflow_export_paths, _write_execution_report
from webapp_state import (
    MANUAL_RUN_TIMEOUT_SEC,
    WORKFLOWS_DIR,
    _end_manual_run,
    _try_begin_manual_run,
    execution_queue,
)

from src.adbflow.adb_client import ADBError
from src.adbflow.engine import ExecutionResult, WorkflowFormatError
from src.adbflow.error_codes import ErrorCode
from src.adbflow.executor import CircuitOpenError, DuplicateExecutionError, ExecutionTimeoutError, QueueBusyError
from src.adbflow.nodes import NodeExecutionError, WorkflowCancelledError
from src.adbflow.observability import log_event, new_run_id
from src.adbflow.persistence import insert_node_event, insert_run
from src.adbflow.workflow_contract import normalize_workflow, schema_public

workflows_bp = Blueprint("workflows", __name__)


class _RunEventCtx:
    def __init__(self) -> None:
        self._start_by_node: dict[str, float] = {}
        self._lock = threading.Lock()

    def mark_start(self, node_id: str, ts: float) -> None:
        with self._lock:
            self._start_by_node[str(node_id)] = float(ts)

    def pop_start(self, node_id: str) -> float | None:
        with self._lock:
            return self._start_by_node.pop(str(node_id), None)


def _record_engine_event(run_id: str, evt: dict[str, object], event_ctx: _RunEventCtx) -> None:
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

    insert_node_event(
        run_id=run_id,
        node_id=node_id,
        class_type=class_type,
        event=event_name or "unknown",
        ts=now,
        duration_ms=duration_ms,
        payload={k: v for k, v in evt.items() if k != "event"},
    )
    log_event(
        "workflow_node_event",
        run_id=run_id,
        node_id=node_id,
        class_type=class_type,
        node_event=event_name,
        duration_ms=round(duration_ms, 2) if duration_ms is not None else None,
    )


@workflows_bp.get("/")
def index():
    return render_template("index.html")


@workflows_bp.post("/api/run")
def run_workflow():
    ok_to_run, deny_msg, cancel_event = _try_begin_manual_run()
    if not ok_to_run:
        return err(deny_msg, ErrorCode.CONFLICT, 409)

    payload = request.get_json(silent=True) or {}
    workflow = payload.get("workflow")
    if not workflow:
        _end_manual_run()
        return err("请求体中缺少工作流配置", ErrorCode.BAD_REQUEST, 400)
    try:
        normalized_workflow, migration_warnings = normalize_workflow(workflow)
    except ValueError as exc:
        _end_manual_run()
        return err(str(exc), ErrorCode.WORKFLOW_INVALID, 400)
    prepared_workflow = _prepare_workflow_export_paths(normalized_workflow, trigger="manual")
    run_id = new_run_id("man")

    started = time.time()
    insert_run(
        run_id=run_id,
        trigger="manual",
        started_at=started,
        workflow_node_count=len(prepared_workflow or {}),
    )
    event_ctx = _RunEventCtx()

    def on_event(evt: dict[str, object]) -> None:
        _record_engine_event(run_id=run_id, evt=evt, event_ctx=event_ctx)

    try:
        result = execution_queue.run(
            prepared_workflow,
            cancel_event=cancel_event,
            on_event=on_event,
            trigger="manual",
            timeout_sec=MANUAL_RUN_TIMEOUT_SEC,
            dedupe_key="manual:run",
        )
        report_path = _write_execution_report(
            workflow=prepared_workflow,
            result=result,
            started_at=started,
            trigger="manual",
            ok=True,
            error="",
            run_id=run_id,
        )
        log_event("manual_run_finish", run_id=run_id, ok=True)
    except WorkflowCancelledError as exc:
        _write_execution_report(
            workflow=prepared_workflow,
            result=None,
            started_at=started,
            trigger="manual",
            ok=False,
            error=str(exc),
            run_id=run_id,
            error_code=ErrorCode.WORKFLOW_CANCELLED,
        )
        return err(str(exc), ErrorCode.WORKFLOW_CANCELLED, 409, cancelled=True)
    except (ExecutionTimeoutError, TimeoutError) as exc:
        _write_execution_report(
            workflow=prepared_workflow,
            result=None,
            started_at=started,
            trigger="manual",
            ok=False,
            error=str(exc),
            run_id=run_id,
            error_code=ErrorCode.RUN_TIMEOUT,
        )
        return err(str(exc), ErrorCode.RUN_TIMEOUT, 408)
    except CircuitOpenError as exc:
        return err(str(exc), ErrorCode.CIRCUIT_OPEN, 429)
    except (QueueBusyError, DuplicateExecutionError) as exc:
        return err(str(exc), ErrorCode.DUPLICATE_EXECUTION, 409)
    except (WorkflowFormatError, NodeExecutionError, ADBError, ValueError) as exc:
        _write_execution_report(
            workflow=prepared_workflow,
            result=None,
            started_at=started,
            trigger="manual",
            ok=False,
            error=str(exc),
            run_id=run_id,
            error_code=ErrorCode.WORKFLOW_INVALID,
        )
        return err(str(exc), ErrorCode.WORKFLOW_INVALID, 400)
    except Exception as exc:
        _write_execution_report(
            workflow=prepared_workflow,
            result=None,
            started_at=started,
            trigger="manual",
            ok=False,
            error=f"未预期异常：{exc}",
            run_id=run_id,
            error_code=ErrorCode.INTERNAL_ERROR,
        )
        return err(f"未预期异常：{exc}", ErrorCode.INTERNAL_ERROR, 500)
    finally:
        _end_manual_run()

    return jsonify(
        {
            "ok": True,
            "logs": result.logs,
            "outputs": result.outputs,
            "report_path": str(report_path),
            "run_id": run_id,
            "migration_warnings": migration_warnings,
        }
    )


@workflows_bp.post("/api/run-stream")
def run_workflow_stream():
    ok_to_run, deny_msg, cancel_event = _try_begin_manual_run()
    if not ok_to_run:
        return err(deny_msg, ErrorCode.CONFLICT, 409)

    payload = request.get_json(silent=True) or {}
    workflow = payload.get("workflow")
    if not workflow:
        _end_manual_run()
        return err("请求体中缺少工作流配置", ErrorCode.BAD_REQUEST, 400)
    try:
        normalized_workflow, migration_warnings = normalize_workflow(workflow)
    except ValueError as exc:
        _end_manual_run()
        return err(str(exc), ErrorCode.WORKFLOW_INVALID, 400)
    prepared_workflow = _prepare_workflow_export_paths(normalized_workflow, trigger="manual")
    run_id = new_run_id("man")

    event_queue: queue.Queue[dict[str, object] | None] = queue.Queue()
    result_holder: dict[str, ExecutionResult] = {}
    error_holder: dict[str, str] = {}

    def on_log(line: str) -> None:
        event_queue.put({"type": "log", "line": line})

    event_ctx = _RunEventCtx()

    def on_event(evt: dict[str, object]) -> None:
        _record_engine_event(run_id=run_id, evt=evt, event_ctx=event_ctx)
        event_queue.put({"type": "event", **evt})

    started = time.time()
    insert_run(
        run_id=run_id,
        trigger="manual",
        started_at=started,
        workflow_node_count=len(prepared_workflow or {}),
    )

    def worker() -> None:
        try:
            result = execution_queue.run(
                prepared_workflow,
                on_log=on_log,
                on_event=on_event,
                cancel_event=cancel_event,
                trigger="manual",
                timeout_sec=MANUAL_RUN_TIMEOUT_SEC,
                dedupe_key="manual:run",
            )
            result_holder["result"] = result
            result_holder["run_id"] = run_id
            result_holder["report_path"] = str(
                _write_execution_report(
                    workflow=prepared_workflow,
                    result=result,
                    started_at=started,
                    trigger="manual",
                    ok=True,
                    error="",
                    run_id=run_id,
                )
            )
        except (ExecutionTimeoutError, TimeoutError) as exc:
            error_holder["error"] = str(exc)
            error_holder["error_code"] = ErrorCode.RUN_TIMEOUT
            _write_execution_report(
                workflow=prepared_workflow,
                result=None,
                started_at=started,
                trigger="manual",
                ok=False,
                error=str(exc),
                run_id=run_id,
                error_code=ErrorCode.RUN_TIMEOUT,
            )
        except CircuitOpenError as exc:
            error_holder["error"] = str(exc)
            error_holder["error_code"] = ErrorCode.CIRCUIT_OPEN
        except (QueueBusyError, DuplicateExecutionError) as exc:
            error_holder["error"] = str(exc)
            error_holder["error_code"] = ErrorCode.DUPLICATE_EXECUTION
        except WorkflowCancelledError as exc:
            error_holder["error"] = str(exc)
            error_holder["error_code"] = ErrorCode.WORKFLOW_CANCELLED
            _write_execution_report(
                workflow=prepared_workflow,
                result=None,
                started_at=started,
                trigger="manual",
                ok=False,
                error=str(exc),
                run_id=run_id,
                error_code=ErrorCode.WORKFLOW_CANCELLED,
            )
        except (WorkflowFormatError, NodeExecutionError, ADBError, ValueError) as exc:
            error_holder["error"] = str(exc)
            error_holder["error_code"] = ErrorCode.WORKFLOW_INVALID
            _write_execution_report(
                workflow=prepared_workflow,
                result=None,
                started_at=started,
                trigger="manual",
                ok=False,
                error=str(exc),
                run_id=run_id,
                error_code=ErrorCode.WORKFLOW_INVALID,
            )
        except Exception as exc:  # noqa: BLE001
            error_holder["error"] = f"未预期异常：{exc}"
            error_holder["error_code"] = ErrorCode.INTERNAL_ERROR
            _write_execution_report(
                workflow=prepared_workflow,
                result=None,
                started_at=started,
                trigger="manual",
                ok=False,
                error=f"未预期异常：{exc}",
                run_id=run_id,
                error_code=ErrorCode.INTERNAL_ERROR,
            )
        finally:
            _end_manual_run()
            event_queue.put(None)

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
            if result is None:
                yield json.dumps(
                    {"type": "error", "error": "执行结果为空", "error_code": ErrorCode.INTERNAL_ERROR},
                    ensure_ascii=False,
                ) + "\n"
                return

            yield json.dumps(
                {
                    "type": "result",
                    "outputs": result.outputs,
                    "logs": result.logs,
                    "report_path": result_holder.get("report_path", ""),
                    "run_id": result_holder.get("run_id", run_id),
                    "migration_warnings": migration_warnings,
                },
                ensure_ascii=False,
            ) + "\n"
        except GeneratorExit:
            cancel_event.set()
            raise

    return Response(generate(), mimetype="application/x-ndjson")


@workflows_bp.get("/api/workflow/default")
def default_workflow():
    workflow_path = WORKFLOWS_DIR / "example_workflow.json"
    if not workflow_path.exists():
        return err(f"默认工作流不存在：{workflow_path.resolve()}", ErrorCode.NOT_FOUND, 404)
    try:
        with workflow_path.open("r", encoding="utf-8") as f:
            workflow = json.load(f)
    except Exception as exc:
        return err(f"读取默认工作流失败：{exc}", ErrorCode.INTERNAL_ERROR, 500)
    try:
        workflow, migration_warnings = normalize_workflow(workflow)
    except ValueError as exc:
        return err(f"默认工作流无效：{exc}", ErrorCode.WORKFLOW_INVALID, 500)
    return jsonify(
        {
            "ok": True,
            "workflow": workflow,
            "path": str(workflow_path.resolve()),
            "migration_warnings": migration_warnings,
        }
    )


@workflows_bp.get("/api/workflows")
def list_workflows():
    if not WORKFLOWS_DIR.exists():
        return err(f"工作流目录不存在：{WORKFLOWS_DIR}", ErrorCode.NOT_FOUND, 404)
    files = sorted([p.name for p in WORKFLOWS_DIR.glob("*.json") if p.is_file()])
    return jsonify({"ok": True, "dir": str(WORKFLOWS_DIR), "files": files})


@workflows_bp.get("/api/workflow/load")
def load_workflow():
    name = str(request.args.get("name", "")).strip()
    if not name:
        return err("缺少工作流文件名参数 name", ErrorCode.BAD_REQUEST, 400)

    safe_name = Path(name).name
    if safe_name != name or not safe_name.lower().endswith(".json"):
        return err("工作流文件名不合法", ErrorCode.BAD_REQUEST, 400)

    workflow_path = (WORKFLOWS_DIR / safe_name).resolve()
    if workflow_path.parent != WORKFLOWS_DIR:
        return err("工作流路径不合法", ErrorCode.BAD_REQUEST, 400)
    if not workflow_path.exists():
        return err(f"工作流不存在：{safe_name}", ErrorCode.NOT_FOUND, 404)

    try:
        with workflow_path.open("r", encoding="utf-8") as f:
            workflow = json.load(f)
    except Exception as exc:
        return err(f"读取工作流失败：{exc}", ErrorCode.INTERNAL_ERROR, 500)
    try:
        workflow, migration_warnings = normalize_workflow(workflow)
    except ValueError as exc:
        return err(f"工作流无效：{exc}", ErrorCode.WORKFLOW_INVALID, 400)
    return jsonify(
        {
            "ok": True,
            "workflow": workflow,
            "name": safe_name,
            "path": str(workflow_path),
            "migration_warnings": migration_warnings,
        }
    )


@workflows_bp.get("/api/workflow/schema")
def workflow_schema():
    return jsonify({"ok": True, "schema": schema_public()})


@workflows_bp.post("/api/workflow/normalize")
def normalize_workflow_api():
    payload = request.get_json(silent=True) or {}
    workflow = payload.get("workflow")
    if not workflow:
        return err("请求体中缺少工作流配置", ErrorCode.BAD_REQUEST, 400)
    try:
        normalized, warnings = normalize_workflow(workflow)
    except ValueError as exc:
        return err(str(exc), ErrorCode.WORKFLOW_INVALID, 400)
    return jsonify({"ok": True, "workflow": normalized, "migration_warnings": warnings})
