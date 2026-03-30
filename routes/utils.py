from __future__ import annotations

import json
from pathlib import Path

from flask import Blueprint, jsonify, request

from routes.api_response import err
from helpers import _open_in_file_manager
from webapp_state import (
    REPORTS_DIR,
    _MANUAL_RUN_LOCK,
    _MANUAL_RUN_STATE,
    _get_schedule_cancel_event,
    _is_scheduler_running,
    adb,
    execution_queue,
)

from src.adbflow.adb_client import ADBError
from src.adbflow.error_codes import ErrorCode
from src.adbflow.persistence import (
    get_run_timeline,
    get_run_timeline_by_report_path,
    health_summary,
    metrics_summary,
)

utils_bp = Blueprint("utils", __name__)


@utils_bp.get("/api/devices")
def list_devices():
    try:
        return jsonify({"ok": True, "devices": adb.list_devices()})
    except ADBError as exc:
        return err(str(exc), ErrorCode.DEVICE_ERROR, 500)


@utils_bp.get("/api/runtime-status")
def runtime_status():
    with _MANUAL_RUN_LOCK:
        manual_running = bool(_MANUAL_RUN_STATE.get("running"))
    q = execution_queue.stats()
    return jsonify(
        {
            "ok": True,
            "manual_running": manual_running,
            "scheduler_running": _is_scheduler_running(),
            "execution_queue": q,
        }
    )


@utils_bp.post("/api/run-cancel")
def cancel_workflow_run():
    import threading

    # Try cancelling manual run first
    with _MANUAL_RUN_LOCK:
        running = bool(_MANUAL_RUN_STATE.get("running"))
        cancel_event = _MANUAL_RUN_STATE.get("cancel_event")
        if running and isinstance(cancel_event, threading.Event):
            cancel_event.set()
            return jsonify({"ok": True, "message": "已发送停止信号"})

    # Try cancelling schedule run
    schedule_cancel = _get_schedule_cancel_event()
    if schedule_cancel is not None:
        schedule_cancel.set()
        return jsonify({"ok": True, "message": "已发送停止信号"})

    return err("当前没有可取消的执行任务", ErrorCode.BAD_REQUEST, 400)


@utils_bp.get("/health")
def health():
    data = health_summary()
    return jsonify({"ok": True, **data})


@utils_bp.get("/metrics")
def metrics():
    try:
        top_n = int(request.args.get("top_n", 5) or 5)
    except Exception:
        return err("top_n 必须是整数", ErrorCode.BAD_REQUEST, 400)
    data = metrics_summary(top_n=top_n)
    return jsonify({"ok": True, **data})


@utils_bp.get("/api/run/timeline")
def run_timeline():
    run_id = str(request.args.get("run_id", "")).strip()
    report_path = str(request.args.get("report_path", "")).strip()
    if not run_id and not report_path:
        return err("缺少 run_id 或 report_path 参数", ErrorCode.BAD_REQUEST, 400)

    timeline: dict[str, object] | None = None
    if run_id:
        timeline = get_run_timeline(run_id)
    elif report_path:
        target = Path(report_path).expanduser()
        if not target.is_absolute():
            target = (Path.cwd() / target).resolve()
        else:
            target = target.resolve()
        try:
            if not target.is_relative_to(REPORTS_DIR):
                return err("仅支持查询 outputs/reports 目录下的报告", ErrorCode.BAD_REQUEST, 400)
        except Exception:
            return err("报告路径不合法", ErrorCode.BAD_REQUEST, 400)
        timeline = get_run_timeline_by_report_path(str(target))

    if not timeline:
        return err("未找到对应执行回放数据", ErrorCode.NOT_FOUND, 404)
    return jsonify({"ok": True, "timeline": timeline})


@utils_bp.get("/api/report/read")
def read_report():
    raw_path = str(request.args.get("path", "")).strip()
    if not raw_path:
        return err("缺少 path 参数", ErrorCode.BAD_REQUEST, 400)

    target = Path(raw_path).expanduser()
    if not target.is_absolute():
        target = (Path.cwd() / target).resolve()
    else:
        target = target.resolve()

    try:
        if not target.is_relative_to(REPORTS_DIR):
            return err("仅支持读取 outputs/reports 目录下的报告", ErrorCode.BAD_REQUEST, 400)
    except Exception:
        return err("报告路径不合法", ErrorCode.BAD_REQUEST, 400)

    if not target.exists() or not target.is_file():
        return err(f"报告不存在：{target}", ErrorCode.NOT_FOUND, 404)

    try:
        with target.open("r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as exc:
        return err(f"读取报告失败：{exc}", ErrorCode.INTERNAL_ERROR, 500)
    return jsonify({"ok": True, "path": str(target), "report": payload})


@utils_bp.post("/api/open-location")
def open_location():
    payload = request.get_json(silent=True) or {}
    raw_path = str(payload.get("path", "")).strip()
    if not raw_path:
        return err("缺少路径参数 path", ErrorCode.BAD_REQUEST, 400)

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
        suffix = target.suffix.lower()
        if suffix in {".xlsx", ".xls", ".csv"}:
            open_dir = target.parent
            select_file = target if target.parent.exists() else None
        else:
            open_dir = target

    if not open_dir.exists():
        return err(f"目录不存在：{open_dir}", ErrorCode.NOT_FOUND, 404)

    try:
        _open_in_file_manager(open_dir, select_file=select_file)
    except Exception as exc:
        return err(f"打开目录失败：{exc}", ErrorCode.INTERNAL_ERROR, 500)

    return jsonify(
        {
            "ok": True,
            "opened_dir": str(open_dir),
            "selected_file": str(select_file) if select_file else "",
        }
    )
