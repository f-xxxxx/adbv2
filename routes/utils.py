from __future__ import annotations

import base64
import io
import json
import secrets
import threading
import time
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
from PIL import Image

utils_bp = Blueprint("utils", __name__)
_TAP_PICKER_TEMP_LOCK = threading.Lock()
_TAP_PICKER_TEMP: dict[str, dict[str, str | float]] = {}
_TAP_PICKER_TMP_DIR = (Path("outputs/tmp/tap_picker")).resolve()
_TAP_PICKER_TMP_DIR.mkdir(parents=True, exist_ok=True)
_PROJECT_ROOT = Path.cwd().resolve()


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


@utils_bp.get("/api/image/thumb")
def image_thumb():
    raw_path = str(request.args.get("path", "")).strip()
    if not raw_path:
        return err("缺少 path 参数", ErrorCode.BAD_REQUEST, 400)
    try:
        max_side = int(request.args.get("max_side", 360) or 360)
    except Exception:
        return err("max_side 必须是整数", ErrorCode.BAD_REQUEST, 400)
    max_side = max(80, min(1200, max_side))

    target = Path(raw_path).expanduser()
    if not target.is_absolute():
        target = (_PROJECT_ROOT / target).resolve()
    else:
        target = target.resolve()

    try:
        if not target.is_relative_to(_PROJECT_ROOT):
            return err("仅支持读取项目目录下图片", ErrorCode.BAD_REQUEST, 400)
    except Exception:
        return err("图片路径不合法", ErrorCode.BAD_REQUEST, 400)

    if not target.exists() or not target.is_file():
        return err(f"图片不存在：{target}", ErrorCode.NOT_FOUND, 404)

    ext = target.suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}:
        return err("不支持的图片格式", ErrorCode.BAD_REQUEST, 400)

    try:
        with Image.open(target) as raw_img:
            img = raw_img.convert("RGB")
        w, h = img.size
        scale = min(max_side / max(1, w), max_side / max(1, h), 1.0)
        if scale < 1.0:
            nw = max(1, int(w * scale))
            nh = max(1, int(h * scale))
            resized = img.resize((nw, nh), Image.Resampling.LANCZOS)
            img.close()
            img = resized
        buff = io.BytesIO()
        img.save(buff, format="JPEG", quality=88, optimize=True)
        img.close()
        b64 = base64.b64encode(buff.getvalue()).decode("ascii")
    except Exception as exc:
        return err(f"生成缩略图失败：{exc}", ErrorCode.INTERNAL_ERROR, 500)

    return jsonify({"ok": True, "path": str(target), "data_url": f"data:image/jpeg;base64,{b64}"})


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


@utils_bp.post("/api/tap-picker/capture-screen")
def tap_picker_capture_screen():
    payload = request.get_json(silent=True) or {}
    requested = str(payload.get("device_id", "")).strip()
    try:
        devices = adb.list_devices()
    except ADBError as exc:
        return err(str(exc), ErrorCode.DEVICE_ERROR, 500)

    if not devices:
        return err("未找到在线设备，请先连接手机", ErrorCode.DEVICE_ERROR, 400)

    device_id = requested
    if device_id:
        if device_id not in devices:
            return err(f"指定设备不在线：{device_id}", ErrorCode.DEVICE_ERROR, 400)
    else:
        if len(devices) > 1:
            return err("检测到多台设备，请在开始节点中明确设置设备编号", ErrorCode.BAD_REQUEST, 400)
        device_id = devices[0]

    token = secrets.token_hex(8)
    local_path = (_TAP_PICKER_TMP_DIR / f"tap_picker_{token}.png").resolve()
    remote_path = f"/sdcard/adbflow/tap_picker_{token}.png"

    try:
        adb.mkdir(device_id, "/sdcard/adbflow")
        adb.screenshot_to_remote(device_id, remote_path)
        adb.pull(device_id, remote_path, str(local_path))
    except ADBError as exc:
        return err(f"抓取手机屏幕失败：{exc}", ErrorCode.DEVICE_ERROR, 500)
    finally:
        try:
            adb.remove_remote_files(device_id, [remote_path])
        except Exception:
            pass

    try:
        image_b64 = base64.b64encode(local_path.read_bytes()).decode("ascii")
    except Exception as exc:
        try:
            local_path.unlink(missing_ok=True)
        except Exception:
            pass
        return err(f"读取截图失败：{exc}", ErrorCode.INTERNAL_ERROR, 500)

    now_ts = time.time()
    with _TAP_PICKER_TEMP_LOCK:
        _TAP_PICKER_TEMP[token] = {"path": str(local_path), "created_at": now_ts}
        expired = [
            tk
            for tk, meta in _TAP_PICKER_TEMP.items()
            if now_ts - float(meta.get("created_at", now_ts)) > 600.0
        ]
        for tk in expired:
            meta = _TAP_PICKER_TEMP.pop(tk, None)
            stale_path = str(meta.get("path", "")).strip() if isinstance(meta, dict) else ""
            if stale_path:
                try:
                    Path(stale_path).unlink(missing_ok=True)
                except Exception:
                    pass

    return jsonify(
        {
            "ok": True,
            "device_id": device_id,
            "token": token,
            "image_name": local_path.name,
            "image_data_url": f"data:image/png;base64,{image_b64}",
        }
    )


@utils_bp.post("/api/tap-picker/cleanup-screen")
def tap_picker_cleanup_screen():
    payload = request.get_json(silent=True) or {}
    token = str(payload.get("token", "")).strip()
    if not token:
        return jsonify({"ok": True, "removed": False})

    local_path = ""
    with _TAP_PICKER_TEMP_LOCK:
        meta = _TAP_PICKER_TEMP.pop(token, None)
        if isinstance(meta, dict):
            local_path = str(meta.get("path", "")).strip()
    if local_path:
        try:
            Path(local_path).unlink(missing_ok=True)
        except Exception:
            pass
    return jsonify({"ok": True, "removed": bool(local_path)})
