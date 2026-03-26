from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, stream_with_context

from src.adbflow.adb_client import ADBClient, ADBError
from src.adbflow.engine import ExecutionResult, WorkflowEngine, WorkflowFormatError
from src.adbflow.nodes import NodeExecutionError

app = Flask(__name__, template_folder="web", static_folder="web")
adb = ADBClient()
engine = WorkflowEngine(adb=adb)
WORKFLOWS_DIR = Path("workflows").resolve()


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/devices")
def list_devices():
    try:
        return jsonify({"ok": True, "devices": adb.list_devices()})
    except ADBError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.post("/api/run")
def run_workflow():
    payload = request.get_json(silent=True) or {}
    workflow = payload.get("workflow")
    if not workflow:
        return jsonify({"ok": False, "error": "请求体中缺少工作流配置"}), 400

    try:
        result = engine.run(workflow)
    except (WorkflowFormatError, NodeExecutionError, ADBError, ValueError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"ok": False, "error": f"未预期异常：{exc}"}), 500

    return jsonify({"ok": True, "logs": result.logs, "outputs": result.outputs})


@app.post("/api/run-stream")
def run_workflow_stream():
    payload = request.get_json(silent=True) or {}
    workflow = payload.get("workflow")
    if not workflow:
        return jsonify({"ok": False, "error": "请求体中缺少工作流配置"}), 400

    event_queue: queue.Queue[dict[str, object] | None] = queue.Queue()
    result_holder: dict[str, ExecutionResult] = {}
    error_holder: dict[str, str] = {}

    def on_log(line: str) -> None:
        event_queue.put({"type": "log", "line": line})

    def on_event(evt: dict[str, object]) -> None:
        event_queue.put({"type": "event", **evt})

    def worker() -> None:
        try:
            result = engine.run(workflow, on_log=on_log, on_event=on_event)
            result_holder["result"] = result
        except (WorkflowFormatError, NodeExecutionError, ADBError, ValueError) as exc:
            error_holder["error"] = str(exc)
        except Exception as exc:  # noqa: BLE001
            error_holder["error"] = f"未预期异常：{exc}"
        finally:
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
            },
            ensure_ascii=False,
        ) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


@app.get("/api/workflow/default")
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


@app.get("/api/workflows")
def list_workflows():
    if not WORKFLOWS_DIR.exists():
        return jsonify({"ok": False, "error": f"工作流目录不存在：{WORKFLOWS_DIR}"}), 404
    files = sorted([p.name for p in WORKFLOWS_DIR.glob("*.json") if p.is_file()])
    return jsonify({"ok": True, "dir": str(WORKFLOWS_DIR), "files": files})


@app.get("/api/workflow/load")
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


@app.post("/api/open-location")
def open_location():
    payload = request.get_json(silent=True) or {}
    raw_path = str(payload.get("path", "")).strip()
    if not raw_path:
        return jsonify({"ok": False, "error": "缺少路径参数 path"}), 400

    target = Path(raw_path).expanduser()
    if not target.is_absolute():
        target = (Path.cwd() / target).resolve()
    else:
        target = target.resolve()

    open_dir: Path
    select_file: Path | None = None

    if target.exists():
        if target.is_dir():
            open_dir = target
        else:
            open_dir = target.parent
            select_file = target
    else:
        # 路径不存在时，若看起来像文件路径则打开其父目录；否则按目录处理
        suffix = target.suffix.lower()
        if suffix in {".xlsx", ".xls", ".csv"}:
            open_dir = target.parent
            select_file = target if target.parent.exists() else None
        else:
            open_dir = target

    if not open_dir.exists():
        return jsonify({"ok": False, "error": f"目录不存在：{open_dir}"}), 404

    try:
        _open_in_file_manager(open_dir, select_file=select_file)
    except Exception as exc:
        return jsonify({"ok": False, "error": f"打开目录失败：{exc}"}), 500

    return jsonify(
        {
            "ok": True,
            "opened_dir": str(open_dir),
            "selected_file": str(select_file) if select_file else "",
        }
    )


def _open_in_file_manager(open_dir: Path, select_file: Path | None = None) -> None:
    if sys.platform.startswith("win"):
        if select_file and select_file.exists():
            subprocess.run(
                ["explorer", "/select,", str(select_file)],
                check=False,
                capture_output=True,
            )
        else:
            os.startfile(str(open_dir))  # type: ignore[attr-defined]
        return

    if sys.platform == "darwin":
        if select_file and select_file.exists():
            subprocess.run(["open", "-R", str(select_file)], check=True, capture_output=True)
        else:
            subprocess.run(["open", str(open_dir)], check=True, capture_output=True)
        return

    # 兜底（Linux 等）
    subprocess.run(["xdg-open", str(open_dir)], check=True, capture_output=True)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=7860, debug=True)
