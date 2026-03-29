from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, stream_with_context

from src.adbflow.adb_client import ADBClient, ADBError
from src.adbflow.engine import ExecutionResult, WorkflowEngine, WorkflowFormatError
from src.adbflow.nodes import NodeExecutionError

app = Flask(__name__, template_folder="web", static_folder="web")
adb = ADBClient()
engine = WorkflowEngine(adb=adb)
WORKFLOWS_DIR = Path("workflows").resolve()
OUTPUTS_DIR = Path("outputs").resolve()
DOCS_DIR = (OUTPUTS_DIR / "docs").resolve()
REPORTS_DIR = Path("outputs/reports").resolve()
SCHEDULES_DIR = Path("schedules").resolve()
SCHEDULES_PATH = (SCHEDULES_DIR / "schedules.json").resolve()
LEGACY_SCHEDULES_PATH = (OUTPUTS_DIR / "schedules.json").resolve()
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
DOCS_DIR.mkdir(parents=True, exist_ok=True)
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
SCHEDULES_DIR.mkdir(parents=True, exist_ok=True)

_SCHEDULER_LOCK = threading.Lock()
_SCHEDULES: dict[str, dict[str, object]] = {}
_SCHEDULER_STARTED = False


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
    prepared_workflow = _prepare_workflow_export_paths(workflow, trigger="manual")

    started = time.time()
    try:
        result = engine.run(prepared_workflow)
        report_path = _write_execution_report(
            workflow=prepared_workflow,
            result=result,
            started_at=started,
            trigger="manual",
            ok=True,
            error="",
        )
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

    return jsonify({"ok": True, "logs": result.logs, "outputs": result.outputs, "report_path": str(report_path)})


@app.post("/api/run-stream")
def run_workflow_stream():
    payload = request.get_json(silent=True) or {}
    workflow = payload.get("workflow")
    if not workflow:
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
            result = engine.run(prepared_workflow, on_log=on_log, on_event=on_event)
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


@app.get("/api/schedules")
def list_schedules():
    _ensure_scheduler_started()
    with _SCHEDULER_LOCK:
        items = list(_SCHEDULES.values())
    return jsonify({"ok": True, "items": items})


@app.post("/api/schedules")
def create_schedule():
    _ensure_scheduler_started()
    payload = request.get_json(silent=True) or {}
    workflow_name = str(payload.get("workflow_name", "")).strip()
    workflow_data = payload.get("workflow")
    interval_sec = int(payload.get("interval_sec", 300) or 300)
    max_runs = max(0, int(payload.get("max_runs", 0) or 0))
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
            return jsonify({"ok": False, "error": "工作流文件不存在"}), 404
        with workflow_path.open("r", encoding="utf-8") as f:
            loaded = json.load(f)
        if not isinstance(loaded, dict) or not loaded:
            return jsonify({"ok": False, "error": "工作流文件内容无效"}), 400
        workflow_snapshot = loaded
        source_name = workflow_path.name
    else:
        return jsonify({"ok": False, "error": "缺少 workflow（当前工作区工作流）"}), 400

    schedule_id = uuid.uuid4().hex[:10]
    now = time.time()
    export_dirs = _collect_schedule_export_dirs(workflow_snapshot, schedule_id)
    item: dict[str, object] = {
        "id": schedule_id,
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
    }
    with _SCHEDULER_LOCK:
        _SCHEDULES[schedule_id] = item
        _save_schedules_locked()
    return jsonify({"ok": True, "item": item})


@app.post("/api/schedules/toggle")
def toggle_schedule():
    _ensure_scheduler_started()
    payload = request.get_json(silent=True) or {}
    schedule_id = str(payload.get("id", "")).strip()
    enabled = bool(payload.get("enabled", True))
    if not schedule_id:
        return jsonify({"ok": False, "error": "缺少 id"}), 400
    with _SCHEDULER_LOCK:
        item = _SCHEDULES.get(schedule_id)
        if not item:
            return jsonify({"ok": False, "error": "任务不存在"}), 404
        item["enabled"] = enabled
        if enabled:
            item["next_run_at"] = time.time() + max(10, int(item.get("interval_sec", 300)))
        _save_schedules_locked()
        return jsonify({"ok": True, "item": item})


@app.delete("/api/schedules/<schedule_id>")
def delete_schedule(schedule_id: str):
    _ensure_scheduler_started()
    sid = str(schedule_id).strip()
    with _SCHEDULER_LOCK:
        existed = _SCHEDULES.pop(sid, None)
        _save_schedules_locked()
    if not existed:
        return jsonify({"ok": False, "error": "任务不存在"}), 404
    return jsonify({"ok": True})


@app.get("/api/report/read")
def read_report():
    raw_path = str(request.args.get("path", "")).strip()
    if not raw_path:
        return jsonify({"ok": False, "error": "缺少 path 参数"}), 400

    target = Path(raw_path).expanduser()
    if not target.is_absolute():
        target = (Path.cwd() / target).resolve()
    else:
        target = target.resolve()

    try:
        if not target.is_relative_to(REPORTS_DIR):
            return jsonify({"ok": False, "error": "仅支持读取 outputs/reports 目录下的报告"}), 400
    except Exception:
        return jsonify({"ok": False, "error": "报告路径不合法"}), 400

    if not target.exists() or not target.is_file():
        return jsonify({"ok": False, "error": f"报告不存在：{target}"}), 404

    try:
        with target.open("r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as exc:
        return jsonify({"ok": False, "error": f"读取报告失败：{exc}"}), 500
    return jsonify({"ok": True, "path": str(target), "report": payload})


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


def _write_execution_report(
    workflow: dict[str, object],
    result: ExecutionResult | None,
    started_at: float,
    trigger: str,
    ok: bool,
    error: str,
) -> Path:
    ended_at = time.time()
    ts = datetime.fromtimestamp(ended_at).strftime("%Y%m%d_%H%M%S")
    report_path = REPORTS_DIR / f"run_{ts}_{uuid.uuid4().hex[:6]}.json"
    payload = {
        "ok": ok,
        "trigger": trigger,
        "started_at": datetime.fromtimestamp(started_at).strftime("%Y-%m-%d %H:%M:%S"),
        "ended_at": datetime.fromtimestamp(ended_at).strftime("%Y-%m-%d %H:%M:%S"),
        "elapsed_sec": round(max(0.0, ended_at - started_at), 3),
        "error": error,
        "log_count": len(result.logs) if result else 0,
        "output_node_count": len(result.outputs) if result else 0,
        "outputs": result.outputs if result else {},
        "logs": result.logs if result else [],
        "workflow_node_count": len(workflow or {}),
    }
    with report_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return report_path


def _prepare_workflow_export_paths(
    workflow: dict[str, object],
    trigger: str,
    schedule_id: str = "",
    schedule_batch: int = 0,
) -> dict[str, object]:
    if not isinstance(workflow, dict):
        return {}
    copied = deepcopy(workflow)
    export_node_ids = [nid for nid, node in copied.items() if _is_export_node(node)]
    export_node_ids.sort(key=lambda x: int(x) if str(x).isdigit() else str(x))
    non_append_counter = 0

    for node_id in export_node_ids:
        node = copied.get(node_id)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            inputs = {}
            node["inputs"] = inputs

        append_mode = _as_bool(inputs.get("append_mode"))
        old_output_path = str(inputs.get("output_path", "")).strip()
        requested_output = _normalize_export_output_path(old_output_path)
        old_name = requested_output.name
        base_dir = requested_output.parent

        if trigger == "schedule":
            safe_schedule_id = "".join(ch for ch in str(schedule_id) if ch.isalnum() or ch in {"-", "_"}) or "schedule"
            folder = (base_dir / safe_schedule_id).resolve()
            folder.mkdir(parents=True, exist_ok=True)
            if append_mode:
                filename = f"{safe_schedule_id}.xlsx"
            else:
                non_append_counter += 1
                filename = f"{safe_schedule_id}-{max(1, int(schedule_batch or 1))}.xlsx"
                if non_append_counter > 1:
                    filename = f"{safe_schedule_id}-{max(1, int(schedule_batch or 1))}-{non_append_counter}.xlsx"
            inputs["output_path"] = str((folder / filename).resolve())
        else:
            inputs["output_path"] = str((base_dir / old_name).resolve())

    return copied


def _is_export_node(node: object) -> bool:
    if not isinstance(node, dict):
        return False
    return str(node.get("class_type", "")).strip() == "ExportExcel"


def _as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return False


def _normalize_export_output_path(raw_output_path: str) -> Path:
    raw = str(raw_output_path or "").strip()
    if not raw:
        return (DOCS_DIR / "ocr_result.xlsx").resolve()

    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = (Path.cwd() / candidate).resolve()
    else:
        candidate = candidate.resolve()

    if candidate.suffix.lower() != ".xlsx":
        if raw.endswith(("/", "\\")) or candidate.suffix == "":
            candidate = candidate / "ocr_result.xlsx"
        else:
            candidate = candidate.with_suffix(".xlsx")
    return candidate.resolve()


def _collect_schedule_export_dirs(workflow: dict[str, object], schedule_id: str) -> list[str]:
    safe_schedule_id = "".join(ch for ch in str(schedule_id) if ch.isalnum() or ch in {"-", "_"}) or "schedule"
    dirs: list[str] = []
    seen: set[str] = set()
    if not isinstance(workflow, dict):
        return dirs
    for node in workflow.values():
        if not _is_export_node(node):
            continue
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            inputs = {}
        raw_output_path = str(inputs.get("output_path", "")).strip()
        out_path = _normalize_export_output_path(raw_output_path)
        schedule_dir = str((out_path.parent / safe_schedule_id).resolve())
        if schedule_dir in seen:
            continue
        seen.add(schedule_dir)
        dirs.append(schedule_dir)
    if not dirs:
        fallback = str((DOCS_DIR / safe_schedule_id).resolve())
        dirs.append(fallback)
    return dirs


def _migrate_legacy_schedules_file() -> None:
    if SCHEDULES_PATH.exists() or not LEGACY_SCHEDULES_PATH.exists():
        return
    try:
        SCHEDULES_DIR.mkdir(parents=True, exist_ok=True)
        LEGACY_SCHEDULES_PATH.replace(SCHEDULES_PATH)
    except Exception:
        return


def _load_schedules() -> dict[str, dict[str, object]]:
    _migrate_legacy_schedules_file()
    if not SCHEDULES_PATH.exists():
        return {}
    try:
        with SCHEDULES_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
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
        workflow_data = item.get("workflow_data")
        if isinstance(workflow_data, dict):
            item["workflow_data"] = workflow_data
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
        result[sid_text] = item
    return result


def _save_schedules_locked() -> None:
    data = {sid: item for sid, item in _SCHEDULES.items()}
    with SCHEDULES_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _ensure_scheduler_started() -> None:
    global _SCHEDULER_STARTED
    with _SCHEDULER_LOCK:
        if _SCHEDULER_STARTED:
            return
        _SCHEDULES.clear()
        _SCHEDULES.update(_load_schedules())
        thread = threading.Thread(target=_scheduler_loop, daemon=True, name="adbflow-scheduler")
        thread.start()
        _SCHEDULER_STARTED = True


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


def _run_schedule_once(schedule_id: str) -> None:
    with _SCHEDULER_LOCK:
        item = _SCHEDULES.get(schedule_id)
        if not item:
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
        if not item.get("export_dirs"):
            item["export_dirs"] = _collect_schedule_export_dirs(
                item.get("workflow_data") if isinstance(item.get("workflow_data"), dict) else {},
                schedule_id,
            )
        _save_schedules_locked()

    started = time.time()
    ok = False
    err = ""
    result: ExecutionResult | None = None
    workflow: dict[str, object] = {}
    if isinstance(workflow_data, dict) and workflow_data:
        workflow = _prepare_workflow_export_paths(
            workflow_data,
            trigger="schedule",
            schedule_id=schedule_id,
            schedule_batch=batch_no,
        )
    else:
        workflow_path = (WORKFLOWS_DIR / Path(workflow_name).name).resolve()
        if workflow_path.parent != WORKFLOWS_DIR or not workflow_path.exists():
            err = f"调度工作流不存在：{workflow_name}"
        else:
            try:
                with workflow_path.open("r", encoding="utf-8") as f:
                    loaded = json.load(f)
                workflow = _prepare_workflow_export_paths(
                    loaded,
                    trigger="schedule",
                    schedule_id=schedule_id,
                    schedule_batch=batch_no,
                )
            except Exception as exc:  # noqa: BLE001
                err = str(exc)

    if not err:
        try:
            result = engine.run(workflow)
            ok = True
        except Exception as exc:  # noqa: BLE001
            err = str(exc)

    report_path = _write_execution_report(
        workflow=workflow if ok else {},
        result=result,
        started_at=started,
        trigger=f"schedule:{schedule_id}:batch:{batch_no}",
        ok=ok,
        error=err,
    )

    with _SCHEDULER_LOCK:
        item = _SCHEDULES.get(schedule_id)
        if not item:
            return
        item["last_run_at"] = time.time()
        item["run_count"] = max(0, int(item.get("run_count", 0) or 0)) + 1
        item["last_status"] = "ok" if ok else "error"
        item["last_error"] = err
        item["last_report_path"] = str(report_path)
        max_runs = max(0, int(item.get("max_runs", 0) or 0))
        if max_runs > 0 and int(item.get("run_count", 0) or 0) >= max_runs:
            item["enabled"] = False
            item["next_run_at"] = 0.0
            if ok:
                item["last_status"] = "done"
        _save_schedules_locked()


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


_ensure_scheduler_started()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=7860, debug=True, use_reloader=False)
