from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class FieldSpec:
    type_name: str
    default: Any = None


@dataclass(frozen=True)
class NodeSpec:
    fields: dict[str, FieldSpec]
    deprecated_fields: tuple[str, ...] = ()


NODE_CONTRACTS: dict[str, NodeSpec] = {
    "StartDevice": NodeSpec(
        fields={
            "device_id": FieldSpec("str", ""),
        }
    ),
    "Tap": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "x": FieldSpec("int", 540),
            "y": FieldSpec("int", 1600),
        }
    ),
    "Swipe": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "direction": FieldSpec("str", "up"),
            "duration_ms": FieldSpec("int", 350),
            "distance_px": FieldSpec("int", 420),
            "x": FieldSpec("nullable_number", None),
            "y": FieldSpec("nullable_number", None),
            "x1": FieldSpec("nullable_number", None),
            "y1": FieldSpec("nullable_number", None),
            "x2": FieldSpec("nullable_number", None),
            "y2": FieldSpec("nullable_number", None),
        }
    ),
    "Wait": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "duration_sec": FieldSpec("float", 0.8),
        }
    ),
    "InputFill": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "text_channel": FieldSpec("str", "clipboard"),
            "text": FieldSpec("str", ""),
        }
    ),
    "Screenshot": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "remote_dir": FieldSpec("str", "/sdcard/adbflow"),
            "prefix": FieldSpec("str", "capture"),
        },
        deprecated_fields=(
            "scroll",
            "scroll_count",
            "scroll_distance_px",
            "scroll_direction",
            "swipe_duration_ms",
            "swipe_pause_sec",
            "capture_pause_sec",
        ),
    ),
    "LoopStart": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "loop_count": FieldSpec("int", 5),
            "loop_start_wait_sec": FieldSpec("float", 0.6),
        }
    ),
    "LoopEnd": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
        }
    ),
    "PullToPC": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "save_dir": FieldSpec("str", "outputs/screenshots"),
            "clear_save_dir": FieldSpec("bool", False),
            "cleanup_remote": FieldSpec("bool", True),
        },
        deprecated_fields=("stitch_scroll", "max_overlap_px"),
    ),
    "EasyOCR": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "languages": FieldSpec("str", "ch_sim,en"),
            "gpu": FieldSpec("bool", False),
            "image_dir": FieldSpec("str", ""),
            "regions": FieldSpec("str", ""),
        },
        deprecated_fields=("use_all_images",),
    ),
    "ExportExcel": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "output_path": FieldSpec("str", "outputs/docs/ocr_result.xlsx"),
            "append_mode": FieldSpec("bool", False),
            "dedup_keys": FieldSpec("str_list", ["图片"]),
        }
    ),
    "PreviewExcel": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "max_rows": FieldSpec("int", 10),
        }
    ),
    "PreviewImages": NodeSpec(
        fields={
            "input": FieldSpec("link", None),
            "folder_dir": FieldSpec("str", ""),
            "max_images": FieldSpec("int", 12),
            "thumb_max_px": FieldSpec("int", 360),
        }
    ),
}


def schema_public() -> dict[str, Any]:
    items: dict[str, Any] = {}
    for class_type, spec in NODE_CONTRACTS.items():
        items[class_type] = {
            "fields": {k: {"type": v.type_name, "default": v.default} for k, v in spec.fields.items()},
            "deprecated_fields": list(spec.deprecated_fields),
        }
    return items


def normalize_workflow(workflow: Any) -> tuple[dict[str, Any], list[str]]:
    if not isinstance(workflow, dict) or not workflow:
        raise ValueError("工作流必须是非空对象")

    warnings: list[str] = []
    normalized: dict[str, Any] = {}

    for node_id, raw_node in workflow.items():
        node_key = str(node_id).strip()
        if not node_key:
            warnings.append("检测到空节点 id，已忽略")
            continue
        if not isinstance(raw_node, dict):
            warnings.append(f"节点 {node_key} 配置无效，已忽略")
            continue

        class_type = str(raw_node.get("class_type", "")).strip()
        if not class_type:
            warnings.append(f"节点 {node_key} 缺少 class_type，已忽略")
            continue

        raw_inputs = raw_node.get("inputs", {})
        if not isinstance(raw_inputs, dict):
            raw_inputs = {}
            warnings.append(f"节点 {node_key}.inputs 非对象，已重置为空")

        spec = NODE_CONTRACTS.get(class_type)
        if spec is None:
            # Plugin / custom nodes: keep passthrough, only normalize id/type shell.
            normalized[node_key] = {"class_type": class_type, "inputs": dict(raw_inputs)}
            continue

        node_inputs: dict[str, Any] = {}
        for name, field_spec in spec.fields.items():
            if name in raw_inputs:
                node_inputs[name] = _coerce_field(
                    raw_inputs[name],
                    field_spec=field_spec,
                    node_id=node_key,
                    class_type=class_type,
                    field_name=name,
                    warnings=warnings,
                )
            elif field_spec.default is not None:
                node_inputs[name] = _clone_default(field_spec.default)

        for removed in spec.deprecated_fields:
            if removed in raw_inputs:
                warnings.append(f"节点 {node_key}（{class_type}）移除废弃字段：{removed}")

        known_keys = set(spec.fields.keys()) | set(spec.deprecated_fields)
        for extra_key in raw_inputs.keys():
            if extra_key in known_keys:
                continue
            warnings.append(f"节点 {node_key}（{class_type}）忽略未知字段：{extra_key}")

        normalized[node_key] = {"class_type": class_type, "inputs": node_inputs}

    if not normalized:
        raise ValueError("工作流为空或全部节点无效")
    return normalized, warnings


def _coerce_field(
    value: Any,
    *,
    field_spec: FieldSpec,
    node_id: str,
    class_type: str,
    field_name: str,
    warnings: list[str],
) -> Any:
    t = field_spec.type_name
    if t == "str":
        return str(value or "")
    if t == "bool":
        return _to_bool(value, default=bool(field_spec.default))
    if t == "int":
        return _to_int(value, default=int(field_spec.default or 0))
    if t == "float":
        return _to_float(value, default=float(field_spec.default or 0.0))
    if t == "nullable_number":
        text = str(value).strip() if value is not None else ""
        if text == "":
            return None
        try:
            parsed = float(value)
            return int(parsed) if parsed.is_integer() else parsed
        except Exception:
            warnings.append(
                f"节点 {node_id}（{class_type}）字段 {field_name} 非数字，已重置为默认值"
            )
            return _clone_default(field_spec.default)
    if t == "str_list":
        if isinstance(value, list):
            items = [str(x).strip() for x in value if str(x).strip()]
            return items or _clone_default(field_spec.default)
        text = str(value or "").strip()
        if not text:
            return _clone_default(field_spec.default)
        return [x.strip() for x in text.split(",") if x.strip()] or _clone_default(field_spec.default)
    if t == "link":
        if value is None:
            return None
        if (
            isinstance(value, list)
            and len(value) == 2
            and isinstance(value[0], (str, int))
            and isinstance(value[1], int)
        ):
            return [str(value[0]), int(value[1])]
        warnings.append(
            f"节点 {node_id}（{class_type}）字段 {field_name} 引用格式无效，已清空"
        )
        return None
    return value


def _clone_default(value: Any) -> Any:
    if isinstance(value, list):
        return list(value)
    if isinstance(value, dict):
        return dict(value)
    return value


def _to_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return default


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _to_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return default
