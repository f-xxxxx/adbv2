from __future__ import annotations

import json
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from src.adbflow.adb_client import ADBClient, ADBError
from src.adbflow.engine import WorkflowEngine, WorkflowFormatError
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


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=7860, debug=True)
