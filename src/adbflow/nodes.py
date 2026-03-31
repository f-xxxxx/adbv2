from __future__ import annotations

import ast
import base64
import io
import json
import secrets
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import easyocr
import numpy as np
import pandas as pd
from PIL import Image

from .adb_client import ADBClient, ADBError


class NodeExecutionError(RuntimeError):
    pass


class WorkflowCancelledError(RuntimeError):
    pass


@dataclass
class NodeContext:
    adb: ADBClient
    logs: list[str]
    on_log: Callable[[str], None] | None = None
    on_event: Callable[[dict[str, Any]], None] | None = None
    cancel_event: threading.Event | None = None

    def log(self, text: str) -> None:
        self.logs.append(text)
        if self.on_log is not None:
            try:
                self.on_log(text)
            except Exception:
                pass

    def event(self, event_type: str, **payload: Any) -> None:
        if self.on_event is None:
            return
        try:
            self.on_event({"event": event_type, **payload})
        except Exception:
            pass

    def ensure_not_cancelled(self) -> None:
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise WorkflowCancelledError("执行已取消")


class BaseNode:
    class_type = "BaseNode"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        raise NotImplementedError

    @staticmethod
    def _as_int(value: Any, default: int) -> int:
        if value is None:
            return default
        return int(value)

    @staticmethod
    def _as_float(value: Any, default: float) -> float:
        if value is None:
            return default
        return float(value)

    @staticmethod
    def _as_bool(value: Any, default: bool) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "y", "on"}
        return default

    @staticmethod
    def _input_payload(inputs: dict[str, Any]) -> dict[str, Any]:
        payload = inputs.get("input")
        if not isinstance(payload, dict):
            raise NodeExecutionError("未找到上游节点输出数据")
        return payload

    @staticmethod
    def _device_id(payload: dict[str, Any]) -> str:
        device_id = payload.get("device_id")
        if not device_id:
            raise NodeExecutionError("上游节点数据中缺少设备编号")
        return str(device_id)

    @staticmethod
    def _sleep_with_cancel(ctx: NodeContext, duration_sec: float) -> None:
        remaining = max(0.0, float(duration_sec))
        if remaining <= 0:
            return
        step = 0.2
        while remaining > 0:
            ctx.ensure_not_cancelled()
            chunk = min(step, remaining)
            time.sleep(chunk)
            remaining -= chunk


class StartDeviceNode(BaseNode):
    class_type = "StartDevice"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        requested = str(inputs.get("device_id", "")).strip()
        devices = ctx.adb.list_devices()
        if not devices:
            raise NodeExecutionError("未找到安卓设备，请确认 `adb devices` 至少有一台在线设备。")

        if requested:
            if requested not in devices:
                raise NodeExecutionError(
                    f"指定设备 `{requested}` 不在线，当前在线设备：{devices}"
                )
            device_id = requested
        else:
            if len(devices) > 1:
                raise NodeExecutionError(f"检测到多台设备 {devices}，请在开始节点中明确设置设备编号。")
            device_id = devices[0]

        ctx.log(f"[开始节点] 已选择设备：{device_id}")
        return {"device_id": device_id, "connected_devices": devices}


class TapNode(BaseNode):
    class_type = "Tap"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = self._input_payload(inputs)
        device_id = self._device_id(payload)
        x = self._as_int(inputs.get("x"), 540)
        y = self._as_int(inputs.get("y"), 960)
        ctx.adb.tap(device_id, x, y)
        ctx.log(f"[点击节点] 设备={device_id}，坐标=({x},{y})")
        return {**payload, "last_action": "tap", "tap": {"x": x, "y": y}}


class SwipeNode(BaseNode):
    class_type = "Swipe"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = self._input_payload(inputs)
        device_id = self._device_id(payload)
        direction = _normalize_swipe_direction(inputs.get("direction"), default="up")
        duration_ms = self._as_int(inputs.get("duration_ms"), 350)
        distance_px = max(1, self._as_int(inputs.get("distance_px"), 420))

        x1 = inputs.get("x1")
        y1 = inputs.get("y1")
        x2 = inputs.get("x2")
        y2 = inputs.get("y2")
        if None not in (x1, y1, x2, y2):
            sx1, sy1, sx2, sy2 = int(x1), int(y1), int(x2), int(y2)
            mode_text = "坐标模式"
        else:
            sx1, sy1, sx2, sy2 = _direction_swipe_coords_by_distance(
                adb=ctx.adb,
                device_id=device_id,
                direction=direction,
                distance_px=distance_px,
                x=inputs.get("x"),
                y=inputs.get("y"),
            )
            mode_text = f"方向模式，位移={distance_px}px"

        direction_label = "下滑" if direction == "down" else "上滑"
        ctx.adb.swipe(device_id, sx1, sy1, sx2, sy2, duration_ms=duration_ms)
        ctx.log(
            f"[滑动节点] 设备={device_id}，方向={direction_label}，({sx1},{sy1})->({sx2},{sy2})，"
            f"时长={duration_ms}ms，{mode_text}"
        )
        return {
            **payload,
            "last_action": "swipe",
            "swipe": {
                "x1": sx1,
                "y1": sy1,
                "x2": sx2,
                "y2": sy2,
                "duration_ms": duration_ms,
                "distance_px": distance_px,
            },
        }


class WaitNode(BaseNode):
    class_type = "Wait"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = self._input_payload(inputs)
        duration_sec = max(
            0.0,
            self._as_float(
                inputs.get("duration_sec", inputs.get("seconds", inputs.get("sec", 0.5))),
                0.5,
            ),
        )
        if duration_sec > 0:
            self._sleep_with_cancel(ctx, duration_sec)
        ctx.log(f"[等待节点] 等待 {duration_sec:.2f} 秒")
        return {**payload, "last_action": "wait", "wait_sec": duration_sec}


class InputFillNode(BaseNode):
    class_type = "InputFill"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = self._input_payload(inputs)
        device_id = self._device_id(payload)
        text = str(inputs.get("text", ""))
        if not text.strip():
            raise NodeExecutionError("输入内容为空，请先填写 text。")

        text_channel = str(inputs.get("text_channel", "clipboard")).strip().lower() or "clipboard"
        input_method = ""
        fallback_used = False
        try:
            input_method = ctx.adb.input_text_by_channel(device_id, text, channel=text_channel)
        except ADBError as exc:
            if text_channel in {"auto", "adb_keyboard"}:
                ctx.log(f"[输入节点] 首选通道失败：{exc}")
                try:
                    input_method = ctx.adb.input_text_by_channel(device_id, text, channel="clipboard")
                    fallback_used = True
                except ADBError as fallback_exc:
                    raise NodeExecutionError(
                        f"文本输入失败：ADB Keyboard 与剪贴板通道都不可用。"
                        f"首选错误：{exc}；降级错误：{fallback_exc}"
                    ) from fallback_exc
            else:
                raise NodeExecutionError(f"文本输入失败：{exc}") from exc

        ctx.log(
            f"[输入节点] 设备={device_id}，通道={text_channel}{'->clipboard' if fallback_used else ''}，方式={input_method}"
        )
        return {
            **payload,
            "last_action": "input_text",
            "input_text": text,
            "text_channel": text_channel,
            "input_method": input_method,
            "fallback_used": fallback_used,
        }


class ScreenshotNode(BaseNode):
    class_type = "Screenshot"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = self._input_payload(inputs)
        device_id = self._device_id(payload)
        remote_dir = str(inputs.get("remote_dir", "/sdcard/adbflow")).strip()
        prefix = str(inputs.get("prefix", "shot")).strip()
        if not prefix:
            prefix = "shot"
        loop_iteration = _payload_loop_iteration(payload)
        ctx.adb.mkdir(device_id, remote_dir)

        remote_paths: list[str] = list(payload.get("remote_paths") or [])
        ctx.ensure_not_cancelled()
        ts_ms = int(time.time() * 1000)
        rand_suffix = secrets.token_hex(3)
        name = f"{prefix}_{ts_ms}_{rand_suffix}_r{loop_iteration}_s1.png"
        remote_path = f"{remote_dir.rstrip('/')}/{name}"
        ctx.adb.screenshot_to_remote(device_id, remote_path)
        remote_paths.append(remote_path)

        ctx.log(
            f"[截图节点] 设备={device_id}，张数=1，轮次=r{loop_iteration}，手机目录={remote_dir}"
        )
        return {
            **payload,
            "device_id": device_id,
            "remote_paths": remote_paths,
            "remote_dir": remote_dir,
        }


class LoopStartNode(BaseNode):
    class_type = "LoopStart"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = self._input_payload(inputs)
        loop_count = max(1, self._as_int(inputs.get("loop_count"), 1))
        loop_start_wait_sec = max(0.0, self._as_float(inputs.get("loop_start_wait_sec"), 0.0))
        ctx.log(f"[循环开始节点] 循环次数={loop_count}，轮次间等待={loop_start_wait_sec:.2f}秒")
        return {
            **payload,
            "loop_iteration": 1,
            "loop_count": loop_count,
        }


class LoopEndNode(BaseNode):
    class_type = "LoopEnd"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = self._input_payload(inputs)
        ctx.log("[循环结束节点] 循环区间执行完成")
        return {**payload}


class PullToPcNode(BaseNode):
    class_type = "PullToPC"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = self._input_payload(inputs)
        device_id = self._device_id(payload)
        remote_paths = payload.get("remote_paths") or []
        if not remote_paths:
            raise NodeExecutionError("未找到截图文件列表，请确认截图节点已连接到回传节点。")

        save_dir = Path(str(inputs.get("save_dir", "outputs/screenshots"))).resolve()
        save_dir.mkdir(parents=True, exist_ok=True)
        clear_save_dir = self._as_bool(inputs.get("clear_save_dir"), False)
        if clear_save_dir:
            _clear_local_dir_contents(save_dir)
            ctx.log(f"[回传节点] 已清空截图目录：{save_dir}")
        else:
            ctx.log(f"[回传节点] 保留目录历史文件：{save_dir}")
        cleanup_remote = self._as_bool(inputs.get("cleanup_remote"), False)

        local_paths: list[str] = []
        for remote_path in remote_paths:
            ctx.ensure_not_cancelled()
            local_path = save_dir / Path(remote_path).name
            ctx.adb.pull(device_id, remote_path, str(local_path))
            local_paths.append(str(local_path))

        if cleanup_remote:
            ctx.adb.remove_remote_files(device_id, remote_paths)
            ctx.log("[回传节点] 已清理手机临时截图")

        ctx.log(f"[回传节点] 已回传 {len(local_paths)} 张图片到 {save_dir}")
        return {
            **payload,
            "device_id": device_id,
            "local_paths": local_paths,
            "save_dir": str(save_dir),
            "clear_save_dir": clear_save_dir,
            "_preview_dir_hint": str(save_dir),
            "_preview_dir_hint_source": "PullToPC",
        }


_OCR_READER_CACHE: dict[tuple[tuple[str, ...], bool], easyocr.Reader] = {}
_OCR_READER_LOCK = threading.Lock()


def get_ocr_reader(langs: list[str], gpu: bool) -> easyocr.Reader:
    key = (tuple(langs), gpu)
    reader = _OCR_READER_CACHE.get(key)
    if reader is not None:
        return reader
    with _OCR_READER_LOCK:
        reader = _OCR_READER_CACHE.get(key)
        if reader is None:
            reader = easyocr.Reader(langs, gpu=gpu)
            _OCR_READER_CACHE[key] = reader
    return reader


class EasyOCRNode(BaseNode):
    class_type = "EasyOCR"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = inputs.get("input") if isinstance(inputs.get("input"), dict) else {}
        local_paths = list(payload.get("local_paths") or [])
        image_dir = str(inputs.get("image_dir", "")).strip()

        if image_dir:
            image_paths = _collect_images_from_dir(image_dir)
            ctx.log(f"[文字识别节点] 从图片文件夹读取：{image_dir}，找到 {len(image_paths)} 张")
        else:
            image_paths = local_paths

        if not image_paths:
            raise NodeExecutionError("未找到可识别图片，请确认已连接回传节点或设置图片文件夹。")

        langs = _parse_langs(inputs.get("languages", "ch_sim,en"))
        gpu = self._as_bool(inputs.get("gpu"), False)
        regions = _parse_regions(inputs.get("regions"))
        region_names = _extract_region_names(regions)
        reader = get_ocr_reader(langs, gpu=gpu)

        rows: list[dict[str, Any]] = []
        for image_path in image_paths:
            ctx.ensure_not_cancelled()
            with Image.open(image_path) as raw_img:
                img = raw_img.convert("RGB")
            try:
                img_w, img_h = img.size
                targets = regions or [{"name": "full", "x": 0, "y": 0, "w": img_w, "h": img_h}]

                for region in targets:
                    x, y, w, h = _normalize_region(region, img_w, img_h)
                    crop = img.crop((x, y, x + w, y + h))
                    try:
                        result = reader.readtext(np.array(crop), detail=1, paragraph=True)
                    finally:
                        crop.close()
                    texts, confidences = _extract_easyocr_entries(result)
                    text = "\n".join(texts).strip()
                    confidence = round(float(np.mean(confidences)) if confidences else 0.0, 4)
                    rows.append(
                        {
                            "image_path": image_path,
                            "region_name": region.get("name", "region"),
                            "x": x,
                            "y": y,
                            "w": w,
                            "h": h,
                            "text": text,
                            "confidence": confidence,
                        }
                    )
            finally:
                img.close()

        ctx.log(f"[文字识别节点] 图片数={len(image_paths)}，每图区域数={len(regions) if regions else 1}")
        ocr_image_dir = str(Path(image_paths[0]).parent) if image_paths else ""
        return {
            **payload,
            "ocr_rows": rows,
            "ocr_region_names": region_names,
            "ocr_image_paths": image_paths,
            "ocr_image_dir": ocr_image_dir,
            "_preview_dir_hint": ocr_image_dir,
            "_preview_dir_hint_source": "EasyOCR",
        }


class ExportExcelNode(BaseNode):
    class_type = "ExportExcel"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = self._input_payload(inputs)
        rows = list(payload.get("ocr_rows") or [])
        region_names = [str(x) for x in (payload.get("ocr_region_names") or []) if str(x).strip()]
        output_path = Path(str(inputs.get("output_path", "outputs/docs/ocr_result.xlsx"))).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        append_mode = self._as_bool(inputs.get("append_mode"), False)
        dedup_keys = _parse_dedup_keys(inputs.get("dedup_keys"))
        invalid_data_key = str(inputs.get("invalid_data_key", "") or "").strip()

        if not region_names:
            seen_names: set[str] = set()
            for row in rows:
                name = str(row.get("region_name", "")).strip()
                if not name:
                    continue
                if name in seen_names:
                    continue
                seen_names.add(name)
                region_names.append(name)

        table_rows = _build_export_rows(rows, region_names)
        filtered_invalid_count = 0
        invalid_filter_applied = False
        invalid_filter_key_exists = invalid_data_key in {"图片", *region_names} if invalid_data_key else False
        if invalid_data_key and invalid_filter_key_exists:
            invalid_filter_applied = True
            kept_rows: list[dict[str, Any]] = []
            for row in table_rows:
                if _has_effective_value(row.get(invalid_data_key)):
                    kept_rows.append(row)
            filtered_invalid_count = max(0, len(table_rows) - len(kept_rows))
            table_rows = kept_rows
        columns = ["序号", "图片", *region_names]
        if table_rows:
            df = pd.DataFrame(table_rows)
            for col in columns:
                if col not in df.columns:
                    df[col] = ""
            df = df[columns]
        else:
            df = pd.DataFrame(columns=columns)

        before_count = 0
        effective_dedup_subset: list[str] = []
        if append_mode and output_path.exists():
            try:
                old_df = pd.read_excel(output_path)
                before_count = len(old_df)
            except Exception:
                old_df = pd.DataFrame(columns=df.columns)
            merged = pd.concat([old_df, df], ignore_index=True, sort=False)
            for col in columns:
                if col not in merged.columns:
                    merged[col] = ""

            if "序号" in merged.columns:
                merged["序号"] = np.arange(1, len(merged) + 1)
            df = merged[columns]

        effective_dedup_subset = [k for k in dedup_keys if k in df.columns]
        if effective_dedup_subset:
            df = df.drop_duplicates(subset=effective_dedup_subset, keep="first", ignore_index=True)
        else:
            df = df.drop_duplicates(keep="first", ignore_index=True)

        if "序号" in df.columns:
            df["序号"] = np.arange(1, len(df) + 1)

        preview_limit = 10
        preview_df = df.head(preview_limit)
        preview_columns = [str(c) for c in preview_df.columns.tolist()]
        preview_rows = [
            {str(k): _preview_cell_value(v) for k, v in row.items()}
            for row in preview_df.to_dict(orient="records")
        ]

        df.to_excel(output_path, index=False)
        append_text = "增量" if append_mode else "覆盖"
        dedup_text = ",".join(dedup_keys) if dedup_keys else "整行"
        effective_dedup_text = ",".join(effective_dedup_subset) if effective_dedup_subset else "整行"
        if not invalid_data_key:
            invalid_text = "未设置"
        elif not invalid_filter_key_exists:
            invalid_text = f"{invalid_data_key}(未命中列)"
        else:
            invalid_text = invalid_data_key
        ctx.log(
            f"[导出表格节点] 文件={output_path}，模式={append_text}，去重键={dedup_text}，生效键={effective_dedup_text}，"
            f"无效主键={invalid_text}，过滤已启用={'是' if invalid_filter_applied else '否'}，过滤空值={filtered_invalid_count}，"
            f"新增={len(table_rows)}，合并前={before_count}，最终={len(df)}"
        )
        return {
            **payload,
            "excel_path": str(output_path),
            "row_count": len(df),
            "preview_columns": preview_columns,
            "preview_rows": preview_rows,
            "preview_limit": preview_limit,
            "preview_total_rows": int(len(df)),
        }


class PreviewExcelNode(BaseNode):
    class_type = "PreviewExcel"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = self._input_payload(inputs)
        excel_path = str(payload.get("excel_path", "")).strip()
        if not excel_path:
            raise NodeExecutionError("未找到导出的 Excel 路径，请先执行导出表格节点。")

        path = Path(excel_path)
        if not path.exists():
            raise NodeExecutionError(f"Excel 文件不存在：{path}")

        max_rows = max(1, self._as_int(inputs.get("max_rows"), 10))
        df = pd.read_excel(path)
        total_rows = int(len(df))
        df = df.head(max_rows)

        columns = [str(c) for c in df.columns.tolist()]
        preview_rows: list[dict[str, Any]] = []
        for row in df.to_dict(orient="records"):
            preview_rows.append({str(k): _preview_cell_value(v) for k, v in row.items()})

        ctx.log(f"[展示结果节点] 已读取 {path}，展示前 {len(preview_rows)} 条（总计 {total_rows} 条）")
        return {
            **payload,
            "preview_columns": columns,
            "preview_rows": preview_rows,
            "preview_limit": max_rows,
            "preview_total_rows": total_rows,
        }


class PreviewImagesNode(BaseNode):
    class_type = "PreviewImages"

    def run(self, inputs: dict[str, Any], ctx: NodeContext) -> Any:
        ctx.ensure_not_cancelled()
        payload = inputs.get("input") if isinstance(inputs.get("input"), dict) else {}
        folder_dir = str(inputs.get("folder_dir", "")).strip()
        max_images = max(1, min(50, self._as_int(inputs.get("max_images"), 12)))
        thumb_max_px = max(80, min(1200, self._as_int(inputs.get("thumb_max_px"), 360)))

        upstream_folder = _resolve_preview_dir_from_payload(payload)
        candidate_folder = upstream_folder or folder_dir
        if not candidate_folder:
            raise NodeExecutionError("未找到图片文件夹，请设置 folder_dir 或连接回传/识别节点。")
        try:
            all_files = _collect_images_from_dir(candidate_folder)
        except NodeExecutionError:
            fallback_folder = folder_dir if upstream_folder else _resolve_preview_dir_from_payload(payload)
            if fallback_folder and fallback_folder != candidate_folder:
                ctx.log(
                    f"[图片预览节点] 目录不可用，切换到备用目录：{fallback_folder}"
                )
                candidate_folder = fallback_folder
                all_files = _collect_images_from_dir(candidate_folder)
            else:
                raise
        selected_files = all_files[:max_images]

        preview_images: list[dict[str, Any]] = []
        for image_path in selected_files:
            preview_images.append(
                {
                    "name": Path(image_path).name,
                    "path": image_path,
                    "data_url": _image_file_to_data_url(image_path, max_side=thumb_max_px),
                }
            )

        ctx.log(
            f"[图片预览节点] 文件夹={candidate_folder}，总数={len(all_files)}，展示={len(preview_images)}"
        )
        return {
            **payload,
            "preview_images": preview_images,
            "preview_image_dir": str(Path(candidate_folder).resolve()),
            "preview_image_total": len(all_files),
            "preview_image_limit": max_images,
        }


def _payload_loop_iteration(payload: dict[str, Any]) -> int:
    value = payload.get("loop_iteration", 1)
    try:
        parsed = int(value)
    except Exception:
        parsed = 1
    return max(1, parsed)


def _direction_swipe_coords_by_distance(
    adb: ADBClient,
    device_id: str,
    direction: str,
    distance_px: int,
    x: Any = None,
    y: Any = None,
) -> tuple[int, int, int, int]:
    w, h = adb.screen_size(device_id)
    sx = int(x) if x is not None else w // 2
    sx = max(0, min(w - 1, sx))
    dist = max(1, int(distance_px))

    if direction == "up":
        sy1 = int(y) if y is not None else int(h * 0.72)
        sy2 = sy1 - dist
    elif direction == "down":
        sy1 = int(y) if y is not None else int(h * 0.28)
        sy2 = sy1 + dist
    else:
        raise NodeExecutionError("滑动方向参数无效，请选择 up 或 down")

    # Keep both points away from hard edges to avoid y1==y2 invalid swipe.
    if h >= 3:
        sy1 = max(1, min(h - 2, sy1))
        sy2 = max(1, min(h - 2, sy2))
    else:
        sy1 = max(0, min(h - 1, sy1))
        sy2 = max(0, min(h - 1, sy2))

    # If user-provided start point is too close to edge, clamp may shrink movement too much.
    # In that case fallback to a safe default band to keep swipe observable.
    actual_travel = abs(sy2 - sy1)
    min_travel = max(80, int(dist * 0.35))
    if h > 4:
        min_travel = min(min_travel, h - 3)
    if actual_travel < min_travel:
        if direction == "up":
            safe_start = int(h * 0.78)
            safe_end = safe_start - dist
        else:
            safe_start = int(h * 0.22)
            safe_end = safe_start + dist
        sy1 = max(1, min(h - 2, safe_start))
        sy2 = max(1, min(h - 2, safe_end))
        if abs(sy2 - sy1) < min_travel:
            # Final fallback uses a fixed large band.
            if direction == "up":
                sy1 = max(1, min(h - 2, int(h * 0.82)))
                sy2 = max(1, min(h - 2, int(h * 0.26)))
            else:
                sy1 = max(1, min(h - 2, int(h * 0.18)))
                sy2 = max(1, min(h - 2, int(h * 0.74)))

    if sy1 == sy2:
        sy2 = sy1 - 1 if direction == "up" else sy1 + 1
        sy2 = max(0, min(h - 1, sy2))
    return sx, sy1, sx, sy2


def _normalize_swipe_direction(value: Any, default: str = "up") -> str:
    text = str(value or "").strip().lower()
    if text in {"up", "u", "上滑"}:
        return "up"
    if text in {"down", "d", "下滑"}:
        return "down"
    return default


def _parse_langs(value: Any) -> list[str]:
    if isinstance(value, list):
        langs = [str(v).strip() for v in value if str(v).strip()]
        return langs or ["ch_sim", "en"]
    txt = str(value or "").strip()
    if not txt:
        return ["ch_sim", "en"]
    return [x.strip() for x in txt.split(",") if x.strip()]


def _extract_easyocr_entries(result: Any) -> tuple[list[str], list[float]]:
    """
    Normalize EasyOCR output into texts + confidences.
    EasyOCR may return different tuple lengths depending on options (e.g. paragraph=True).
    """
    texts: list[str] = []
    confidences: list[float] = []

    if not isinstance(result, list):
        return texts, confidences

    for item in result:
        text_val: str | None = None
        conf_val: float | None = None

        if isinstance(item, str):
            text_val = item
        elif isinstance(item, dict):
            raw_text = item.get("text")
            if raw_text is not None:
                text_val = str(raw_text)
            raw_conf = item.get("confidence", item.get("conf"))
            if raw_conf is not None:
                try:
                    conf_val = float(raw_conf)
                except (TypeError, ValueError):
                    conf_val = None
        elif isinstance(item, (list, tuple)):
            if len(item) >= 3:
                # Common format: [bbox, text, conf]
                if item[1] is not None:
                    text_val = str(item[1])
                try:
                    conf_val = float(item[2])
                except (TypeError, ValueError):
                    conf_val = None
            elif len(item) == 2:
                a, b = item[0], item[1]
                # paragraph mode often returns [bbox, text]
                if isinstance(b, str):
                    text_val = b
                elif isinstance(a, str):
                    text_val = a
                    try:
                        conf_val = float(b)
                    except (TypeError, ValueError):
                        conf_val = None
            elif len(item) == 1 and item[0] is not None:
                text_val = str(item[0])

        if text_val:
            texts.append(text_val)
        if conf_val is not None:
            confidences.append(conf_val)

    return texts, confidences


def _parse_regions(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, list):
        return [dict(v) for v in value if isinstance(v, dict)]
    if isinstance(value, dict):
        return [dict(value)]
    text = str(value).strip()
    if not text:
        return []
    parsed: Any
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        try:
            # 兼容前端常见输入：单引号、尾逗号、Python 风格布尔/None。
            parsed = ast.literal_eval(text)
        except (ValueError, SyntaxError):
            raise NodeExecutionError(f"识别区域配置格式错误：{exc}") from exc
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        raise NodeExecutionError("识别区域配置必须是数组或对象")
    normalized: list[dict[str, Any]] = []
    for idx, item in enumerate(parsed):
        if not isinstance(item, dict):
            raise NodeExecutionError(f"识别区域第 {idx + 1} 项必须是对象")
        normalized.append(dict(item))
    return normalized


def _normalize_region(region: dict[str, Any], img_w: int, img_h: int) -> tuple[int, int, int, int]:
    x = int(region.get("x", 0))
    y = int(region.get("y", 0))
    w = int(region.get("w", img_w))
    h = int(region.get("h", img_h))
    x = max(0, min(x, img_w - 1))
    y = max(0, min(y, img_h - 1))
    w = max(1, min(w, img_w - x))
    h = max(1, min(h, img_h - y))
    return x, y, w, h


def _extract_region_names(regions: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    used: set[str] = set()
    for idx, region in enumerate(regions):
        raw_name = str(region.get("name", "")).strip()
        name = raw_name if raw_name else f"区域{idx + 1}"
        if name in used:
            continue
        used.add(name)
        names.append(name)
    return names


def _resolve_preview_dir_from_payload(payload: dict[str, Any]) -> str:
    hint_dir = str(payload.get("_preview_dir_hint", "")).strip()
    hint_source = str(payload.get("_preview_dir_hint_source", "")).strip()
    if hint_dir:
        if hint_source in {"EasyOCR", "PullToPC"}:
            return hint_dir
        # Unknown source: still trust explicit hint.
        return hint_dir

    ocr_dir = str(payload.get("ocr_image_dir", "")).strip()
    if ocr_dir:
        return ocr_dir

    for key in ("ocr_image_paths", "local_paths"):
        paths = payload.get(key) or []
        if isinstance(paths, list) and paths:
            first_path = str(paths[0]).strip()
            if first_path:
                return str(Path(first_path).parent)

    save_dir = str(payload.get("save_dir", "")).strip()
    if save_dir:
        return save_dir
    return ""


def _collect_images_from_dir(image_dir: str) -> list[str]:
    path = Path(image_dir).expanduser().resolve()
    if not path.exists():
        raise NodeExecutionError(f"图片文件夹不存在：{path}")
    if not path.is_dir():
        raise NodeExecutionError(f"图片文件夹路径不是目录：{path}")

    exts = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}
    files = [p for p in path.iterdir() if p.is_file() and p.suffix.lower() in exts]
    files.sort(key=lambda p: p.name.lower())
    return [str(p) for p in files]


def _image_file_to_data_url(image_path: str, max_side: int = 360) -> str:
    with Image.open(image_path) as raw_img:
        img = raw_img.convert("RGB")
    try:
        w, h = img.size
        scale = min(max_side / max(1, w), max_side / max(1, h), 1.0)
        if scale < 1.0:
            nw = max(1, int(w * scale))
            nh = max(1, int(h * scale))
            resized = img.resize((nw, nh), Image.Resampling.LANCZOS)
            img.close()
            img = resized

        with io.BytesIO() as buf:
            img.save(buf, format="JPEG", quality=85, optimize=True)
            encoded = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"
    finally:
        img.close()


def _build_export_rows(ocr_rows: list[dict[str, Any]], region_names: list[str]) -> list[dict[str, Any]]:
    image_order: list[str] = []
    grouped: dict[str, dict[str, str]] = {}

    for row in ocr_rows:
        image_path = str(row.get("image_path", "")).strip()
        if not image_path:
            continue
        if image_path not in grouped:
            grouped[image_path] = {}
            image_order.append(image_path)

        region_name = str(row.get("region_name", "")).strip() or "未命名区域"
        text = str(row.get("text", "")).strip()
        if not text:
            continue

        existing = grouped[image_path].get(region_name, "")
        if existing:
            grouped[image_path][region_name] = f"{existing}\n{text}"
        else:
            grouped[image_path][region_name] = text

    if not region_names:
        dynamic_names: list[str] = []
        seen: set[str] = set()
        for image_path in image_order:
            for region_name in grouped.get(image_path, {}).keys():
                if region_name in seen:
                    continue
                seen.add(region_name)
                dynamic_names.append(region_name)
        region_names.extend(dynamic_names)

    rows: list[dict[str, Any]] = []
    for idx, image_path in enumerate(image_order, start=1):
        row: dict[str, Any] = {
            "序号": idx,
            "图片": Path(image_path).name,
        }
        for region_name in region_names:
            row[region_name] = grouped.get(image_path, {}).get(region_name, "")
        rows.append(row)
    return rows


def _clear_local_dir_contents(dir_path: Path) -> None:
    if not dir_path.exists():
        return
    for child in dir_path.iterdir():
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)


def _preview_cell_value(value: Any) -> Any:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except Exception:
        pass

    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _has_effective_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    try:
        if pd.isna(value):
            return False
    except Exception:
        pass
    return True


def _parse_dedup_keys(value: Any) -> list[str]:
    if value is None:
        return ["图片"]
    if isinstance(value, list):
        keys = [str(x).strip() for x in value if str(x).strip()]
        return keys or ["图片"]
    text = str(value).strip()
    if not text:
        return ["图片"]
    return [part.strip() for part in text.split(",") if part.strip()]


NODE_REGISTRY: dict[str, Callable[[], BaseNode]] = {
    StartDeviceNode.class_type: StartDeviceNode,
    TapNode.class_type: TapNode,
    SwipeNode.class_type: SwipeNode,
    WaitNode.class_type: WaitNode,
    InputFillNode.class_type: InputFillNode,
    ScreenshotNode.class_type: ScreenshotNode,
    LoopStartNode.class_type: LoopStartNode,
    LoopEndNode.class_type: LoopEndNode,
    PullToPcNode.class_type: PullToPcNode,
    EasyOCRNode.class_type: EasyOCRNode,
    ExportExcelNode.class_type: ExportExcelNode,
    PreviewExcelNode.class_type: PreviewExcelNode,
    PreviewImagesNode.class_type: PreviewImagesNode,
}
