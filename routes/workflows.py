from __future__ import annotations

import json
import queue
import threading
import time
from pathlib import Path

from flask import Blueprint, Response, jsonify, render_template, request, stream_with_context

from helpers import _prepare_workflow_export_paths, _write_execution_report
from webapp_state import (
    WORKFLOWS_DIR,
    _end_manual_run,
    _try_begin_manual_run,
    engine,
)

from src.adbflow.adb_client import ADBError
from src.adbflow.engine import ExecutionResult, WorkflowFormatError
from src.adbflow.nodes import NodeExecutionError, WorkflowCancelledError

workflows_bp = Blueprint("workflows", __name__)


@workflows_bp.get("/")
def index():
    return render_template("index.html")


@workflows_bp.post("/api/run")
def run_workflow():
    ok_to_run, deny_msg, cancel_event = _try_begin_manual_run()
    if not ok_to_run:
        return jsonify({"ok": False, "error": deny_msg}), 409

    payload = request.get_json(silent=True) or {}
    workflow = payload.get("workflow")
    if not workflow:
        _end_manual_run()
        return jsonify({"ok": False, "error": "请求体中缺少工作流配置"}), 400
    prepared_workflow = _prepare_workflow_export_paths(workflow, trigger="manual")

    started = time.time()
    try:
        result = engine.run(prepared_workflow, cancel_event=cancel_event)
        report_path = _write_execution_report(
            workflow=prepared_workflow,
            result=result,
            started_at=started,
            trigger="manual",
            ok=True,
            error="",
        )
    except WorkflowCancelledError as exc:
        _write_execution_report(
            workflow=prepared_workflow,
            result=None,
            started_at=started,
            trigger="manual",
            ok=False,
            error=str(exc),
        )
        return jsonify({"ok": False, "error": str(exc), "cancelled": True}), 409
    except (WorkflowFormatError, NodeExecutionError, ADBError, ValueError) as exc:
        _write_execution_report(
            workflow=prepared_workflow,
            result=None,
            started_at=started,
            trigger="manual",
            ok=False,
            error=str(exc),
        )
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        _write_execution_report(
            workflow=prepared_workflow,
            result=None,
            started_at=started,
            trigger="manual",
            ok=False,
            error=f"未预期异常：{exc}",
        )
        return jsonify({"ok": False, "error": f"未预期异常：{exc}"}), 500
    finally:
        _end_manual_run()

    return jsonify({"ok": True, "logs": result.logs, "outputs": result.outputs, "report_path": str(report_path)})


@workflows_bp.post("/api/run-stream")
def run_workflow_stream():
    ok_to_run, deny_msg, cancel_event = _try_begin_manual_run()
    if not ok_to_run:
        return jsonify({"ok": False, "error": deny_msg}), 409

    payload = request.get_json(silent=True) or {}
    workflow = payload.get("workflow")
    if not workflow:
        _end_manual_run()
        return jsonify({"ok": False, "error": "请求体中缺少工作流配置"}), 400
    prepared_workflow = _prepare_workflow_export_paths(workflow, trigger="manual")

    event_queue: queue.Queue[dict[str, object] | None] = queue.Queue()
    result_holder: dict[str, ExecutionResult] = {}
    error_holder: dict[str, str] = {}

    def on_log(line: str) -> None:
        event_queue.put({"type": "log", "line": line})

    def on_event(evt: dict[str, object]) -> None:
        event_queue.put({"type": "event", **evt})

    started = time.time()

    def worker() -> None:
        try:
            result = engine.run(
                prepared_workflow,
                on_log=on_log,
                on_event=on_event,
                cancel_event=cancel_event,
            )
            result_holder["result"] = result
            result_holder["report_path"] = str(
                _write_execution_report(
                    workflow=prepared_workflow,
                    result=result,
                    started_at=started,
                    trigger="manual",
                    ok=True,
                    error="",
                )
            )
        except WorkflowCancelledError as exc:
            error_holder["error"] = str(exc)
            _write_execution_report(
                workflow=prepared_workflow,
                result=None,
                started_at=started,
                trigger="manual",
                ok=False,
                error=str(exc),
            )
        except (WorkflowFormatError, NodeExecutionError, ADBError, ValueError) as exc:
            error_holder["error"] = str(exc)
            _write_execution_report(
                workflow=prepared_workflow,
                result=None,
                started_at=started,
                trigger="manual",
                ok=False,
                error=str(exc),
            )
        except Exception as exc:  # noqa: BLE001
            error_holder["error"] = f"未预期异常：{exc}"
            _write_execution_report(
                workflow=prepared_workflow,
                result=None,
                started_at=started,
                trigger="manual",
                ok=False,
                error=f"未预期异常：{exc}",
            )
        finally:
            _end_manual_run()
            event_queue.put(None)

    threading.Thread(target=worker, daemon=True).start()

    @stream_with_context
    def generate():
        while True:
            item = event_queue.get()
            if item is None:
                break
            yield json.dumps(item, ensure_ascii=False) + "\n"

        if "error" in error_holder:
            yield json.dumps({"type": "error", "error": error_holder["error"]}, ensure_ascii=False) + "\n"
            return

        result = result_holder.get("result")
        if result is None:
            yield json.dumps({"type": "error", "error": "执行结果为空"}, ensure_ascii=False) + "\n"
            return

        yield json.dumps(
            {
                "type": "result",
                "outputs": result.outputs,
                "logs": result.logs,
                "report_path": result_holder.get("report_path", ""),
            },
            ensure_ascii=False,
        ) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


@workflows_bp.get("/api/workflow/default")
def default_workflow():
    workflow_path = WORKFLOWS_DIR / "example_workflow.json"
    if not workflow_path.exists():
        return jsonify({"ok": False, "error": f"默认工作流不存在：{workflow_path.resolve()}"}), 404
    try:
        with workflow_path.open("r", encoding="utf-8") as f:
            workflow = json.load(f)
    except Exception as exc:
        return jsonify({"ok": False, "error": f"读取默认工作流失败：{exc}"}), 500
    return jsonify({"ok": True, "workflow": workflow, "path": str(workflow_path.resolve())})


@workflows_bp.get("/api/workflows")
def list_workflows():
    if not WORKFLOWS_DIR.exists():
        return jsonify({"ok": False, "error": f"工作流目录不存在：{WORKFLOWS_DIR}"}), 404
    files = sorted([p.name for p in WORKFLOWS_DIR.glob("*.json") if p.is_file()])
    return jsonify({"ok": True, "dir": str(WORKFLOWS_DIR), "files": files})


@workflows_bp.get("/api/workflow/load")
def load_workflow():
    name = str(request.args.get("name", "")).strip()
    if not name:
        return jsonify({"ok": False, "error": "缺少工作流文件名参数 name"}), 400

    safe_name = Path(name).name
    if safe_name != name or not safe_name.lower().endswith(".json"):
        return jsonify({"ok": False, "error": "工作流文件名不合法"}), 400

    workflow_path = (WORKFLOWS_DIR / safe_name).resolve()
    if workflow_path.parent != WORKFLOWS_DIR:
        return jsonify({"ok": False, "error": "工作流路径不合法"}), 400
    if not workflow_path.exists():
        return jsonify({"ok": False, "error": f"工作流不存在：{safe_name}"}), 404

    try:
        with workflow_path.open("r", encoding="utf-8") as f:
            workflow = json.load(f)
    except Exception as exc:
        return jsonify({"ok": False, "error": f"读取工作流失败：{exc}"}), 500
    return jsonify({"ok": True, "workflow": workflow, "name": safe_name, "path": str(workflow_path)})
