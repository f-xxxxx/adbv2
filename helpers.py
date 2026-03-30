from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from copy import deepcopy
from datetime import datetime
from pathlib import Path

from src.adbflow.engine import ExecutionResult

from webapp_state import DOCS_DIR, REPORTS_DIR


def _write_execution_report(
    workflow: dict[str, object],
    result: ExecutionResult | None,
    started_at: float,
    trigger: str,
    ok: bool,
    error: str,
) -> Path:
    import time

    ended_at = time.time()
    report_path = _resolve_report_path(trigger)
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


def _resolve_report_path(trigger: str) -> Path:
    trigger_text = str(trigger or "").strip().lower()
    if trigger_text == "manual":
        return (REPORTS_DIR / "manual_latest.json").resolve()
    if trigger_text.startswith("schedule:"):
        parts = trigger_text.split(":")
        schedule_id = parts[1] if len(parts) >= 2 else "schedule"
        safe_schedule_id = "".join(ch for ch in str(schedule_id) if ch.isalnum() or ch in {"-", "_"})
        if not safe_schedule_id:
            safe_schedule_id = "schedule"
        return (REPORTS_DIR / f"schedule_{safe_schedule_id}.json").resolve()
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return (REPORTS_DIR / f"run_{ts}_{uuid.uuid4().hex[:6]}.json").resolve()


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

    subprocess.run(["xdg-open", str(open_dir)], check=True, capture_output=True)
