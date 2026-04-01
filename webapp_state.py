from __future__ import annotations

import threading
import json
from pathlib import Path

from src.adbflow.adb_client import ADBClient
from src.adbflow.engine import WorkflowEngine
from src.adbflow.executor import ExecutionQueue
from src.adbflow.persistence import init_db

# ---------------------------------------------------------------------------
# Directory constants
# ---------------------------------------------------------------------------
WORKFLOWS_DIR = Path("workflows").resolve()
OUTPUTS_DIR = Path("outputs").resolve()
DOCS_DIR = (OUTPUTS_DIR / "docs").resolve()
REPORTS_DIR = Path("outputs/reports").resolve()
DB_PATH = Path("schedules/adbflow.db").resolve()
SCHEDULES_DIR = Path("schedules").resolve()
NODE_PLUGINS_DIR = Path("plugins/nodes").resolve()

OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
DOCS_DIR.mkdir(parents=True, exist_ok=True)
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
SCHEDULES_DIR.mkdir(parents=True, exist_ok=True)
NODE_PLUGINS_DIR.mkdir(parents=True, exist_ok=True)
init_db(DB_PATH)

# ---------------------------------------------------------------------------
# Shared instances
# ---------------------------------------------------------------------------
adb = ADBClient()
engine = WorkflowEngine(adb=adb)

_RUNTIME_SETTINGS_PATH = (SCHEDULES_DIR / "runtime_settings.json").resolve()
_RUNTIME_SETTINGS_LOCK = threading.Lock()
_RUNTIME_SETTING_KEYS = (
    # Execution
    "EXEC_DEFAULT_TIMEOUT_SEC",
    "EXEC_DEFAULT_MAX_RETRIES",
    "EXEC_RETRY_BACKOFF_SEC",
    "EXEC_CIRCUIT_FAIL_THRESHOLD",
    "EXEC_CIRCUIT_OPEN_SEC",
    "MANUAL_RUN_TIMEOUT_SEC",
    "SCHEDULE_RUN_TIMEOUT_SEC",
    "EXECUTION_QUEUE_MAX_SIZE",
    "STREAM_EVENT_QUEUE_SIZE",
    "STREAM_DROP_WARN_THRESHOLD",
    # Scheduler / UI
    "SCHEDULE_DEFAULT_INTERVAL_SEC",
    "SCHEDULE_DEFAULT_MAX_RUNS",
    "SCHEDULE_AUTO_RUN_ON_CREATE",
    "SCHEDULE_LIST_PAGE_SIZE",
    # Cleanup / report
    "TMP_CLEANUP_INTERVAL_SEC",
    "TMP_CLEANUP_TTL_SEC",
    "TAP_PICKER_TMP_TTL_SEC",
    "REPORT_KEEP_DAYS",
    "REPORT_MAX_FILES",
    # OCR / ADB
    "OCR_LANG_LIST",
    "OCR_GPU_ENABLED",
    "OCR_WARMUP_ON_START",
    "ADB_SHELL_TIMEOUT_SEC",
    "ADB_PULL_TIMEOUT_SEC",
    "ADB_DEVICE_SELECT_POLICY",
    # Frontend preference
    "TIMELINE_DEFAULT_SPEED",
    "TIMELINE_AUTO_OPEN_AFTER_RUN",
    "DEFAULT_BOTTOM_TAB",
    "SIDEBAR_COLLAPSED_DEFAULT",
    "BOTTOM_PANEL_COLLAPSED_DEFAULT",
)
_RUNTIME_DEFAULTS: dict[str, object] = {
    "EXEC_DEFAULT_TIMEOUT_SEC": 180.0,
    "EXEC_DEFAULT_MAX_RETRIES": 1,
    "EXEC_RETRY_BACKOFF_SEC": 0.8,
    "EXEC_CIRCUIT_FAIL_THRESHOLD": 3,
    "EXEC_CIRCUIT_OPEN_SEC": 30.0,
    "MANUAL_RUN_TIMEOUT_SEC": 180.0,
    "SCHEDULE_RUN_TIMEOUT_SEC": 300.0,
    "EXECUTION_QUEUE_MAX_SIZE": 0,
    "STREAM_EVENT_QUEUE_SIZE": 1024,
    "STREAM_DROP_WARN_THRESHOLD": 1,
    "SCHEDULE_DEFAULT_INTERVAL_SEC": 300,
    "SCHEDULE_DEFAULT_MAX_RUNS": 0,
    "SCHEDULE_AUTO_RUN_ON_CREATE": 0,
    "SCHEDULE_LIST_PAGE_SIZE": 6,
    "TMP_CLEANUP_INTERVAL_SEC": 600,
    "TMP_CLEANUP_TTL_SEC": 3600,
    "TAP_PICKER_TMP_TTL_SEC": 600,
    "REPORT_KEEP_DAYS": 7,
    "REPORT_MAX_FILES": 300,
    "OCR_LANG_LIST": 0,
    "OCR_GPU_ENABLED": 0,
    "OCR_WARMUP_ON_START": 1,
    "ADB_SHELL_TIMEOUT_SEC": 25.0,
    "ADB_PULL_TIMEOUT_SEC": 25.0,
    "ADB_DEVICE_SELECT_POLICY": 0,
    "TIMELINE_DEFAULT_SPEED": 4.0,
    "TIMELINE_AUTO_OPEN_AFTER_RUN": 1,
    "DEFAULT_BOTTOM_TAB": 0,
    "SIDEBAR_COLLAPSED_DEFAULT": 1,
    "BOTTOM_PANEL_COLLAPSED_DEFAULT": 1,
}
_SPECIAL_DEFAULTS: dict[str, object] = {
    "OCR_LANG_LIST": ["ch_sim", "en"],
    "ADB_DEVICE_SELECT_POLICY": "strict",
    "DEFAULT_BOTTOM_TAB": "logs",
}


def _to_float(value: object, *, key: str, minimum: float) -> float:
    try:
        parsed = float(value)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"{key} 必须是数字") from exc
    if parsed < minimum:
        raise ValueError(f"{key} 必须 >= {minimum}")
    return parsed


def _to_int(value: object, *, key: str, minimum: int) -> int:
    try:
        if isinstance(value, bool):
            raise ValueError
        parsed = int(value)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"{key} 必须是整数") from exc
    if parsed < minimum:
        raise ValueError(f"{key} 必须 >= {minimum}")
    return parsed


def _normalize_runtime_settings(payload: dict[str, object]) -> dict[str, object]:
    merged: dict[str, object] = dict(_RUNTIME_DEFAULTS)
    for key in _RUNTIME_SETTING_KEYS:
        if key in payload:
            merged[key] = payload[key]
    normalized: dict[str, object] = {
        "EXEC_DEFAULT_TIMEOUT_SEC": _to_float(
            merged["EXEC_DEFAULT_TIMEOUT_SEC"], key="EXEC_DEFAULT_TIMEOUT_SEC", minimum=1.0
        ),
        "EXEC_DEFAULT_MAX_RETRIES": _to_int(
            merged["EXEC_DEFAULT_MAX_RETRIES"], key="EXEC_DEFAULT_MAX_RETRIES", minimum=0
        ),
        "EXEC_RETRY_BACKOFF_SEC": _to_float(
            merged["EXEC_RETRY_BACKOFF_SEC"], key="EXEC_RETRY_BACKOFF_SEC", minimum=0.0
        ),
        "EXEC_CIRCUIT_FAIL_THRESHOLD": _to_int(
            merged["EXEC_CIRCUIT_FAIL_THRESHOLD"], key="EXEC_CIRCUIT_FAIL_THRESHOLD", minimum=1
        ),
        "EXEC_CIRCUIT_OPEN_SEC": _to_float(
            merged["EXEC_CIRCUIT_OPEN_SEC"], key="EXEC_CIRCUIT_OPEN_SEC", minimum=1.0
        ),
        "MANUAL_RUN_TIMEOUT_SEC": _to_float(
            merged["MANUAL_RUN_TIMEOUT_SEC"], key="MANUAL_RUN_TIMEOUT_SEC", minimum=1.0
        ),
        "SCHEDULE_RUN_TIMEOUT_SEC": _to_float(
            merged["SCHEDULE_RUN_TIMEOUT_SEC"], key="SCHEDULE_RUN_TIMEOUT_SEC", minimum=1.0
        ),
        "EXECUTION_QUEUE_MAX_SIZE": _to_int(
            merged["EXECUTION_QUEUE_MAX_SIZE"], key="EXECUTION_QUEUE_MAX_SIZE", minimum=0
        ),
        "STREAM_EVENT_QUEUE_SIZE": _to_int(
            merged["STREAM_EVENT_QUEUE_SIZE"], key="STREAM_EVENT_QUEUE_SIZE", minimum=1
        ),
        "STREAM_DROP_WARN_THRESHOLD": _to_int(
            merged["STREAM_DROP_WARN_THRESHOLD"], key="STREAM_DROP_WARN_THRESHOLD", minimum=0
        ),
        "SCHEDULE_DEFAULT_INTERVAL_SEC": _to_int(
            merged["SCHEDULE_DEFAULT_INTERVAL_SEC"], key="SCHEDULE_DEFAULT_INTERVAL_SEC", minimum=10
        ),
        "SCHEDULE_DEFAULT_MAX_RUNS": _to_int(
            merged["SCHEDULE_DEFAULT_MAX_RUNS"], key="SCHEDULE_DEFAULT_MAX_RUNS", minimum=0
        ),
        "SCHEDULE_AUTO_RUN_ON_CREATE": bool(merged["SCHEDULE_AUTO_RUN_ON_CREATE"]),
        "SCHEDULE_LIST_PAGE_SIZE": _to_int(
            merged["SCHEDULE_LIST_PAGE_SIZE"], key="SCHEDULE_LIST_PAGE_SIZE", minimum=1
        ),
        "TMP_CLEANUP_INTERVAL_SEC": _to_int(
            merged["TMP_CLEANUP_INTERVAL_SEC"], key="TMP_CLEANUP_INTERVAL_SEC", minimum=10
        ),
        "TMP_CLEANUP_TTL_SEC": _to_int(
            merged["TMP_CLEANUP_TTL_SEC"], key="TMP_CLEANUP_TTL_SEC", minimum=60
        ),
        "TAP_PICKER_TMP_TTL_SEC": _to_int(
            merged["TAP_PICKER_TMP_TTL_SEC"], key="TAP_PICKER_TMP_TTL_SEC", minimum=60
        ),
        "REPORT_KEEP_DAYS": _to_int(
            merged["REPORT_KEEP_DAYS"], key="REPORT_KEEP_DAYS", minimum=0
        ),
        "REPORT_MAX_FILES": _to_int(
            merged["REPORT_MAX_FILES"], key="REPORT_MAX_FILES", minimum=0
        ),
        "OCR_GPU_ENABLED": bool(merged["OCR_GPU_ENABLED"]),
        "OCR_WARMUP_ON_START": bool(merged["OCR_WARMUP_ON_START"]),
        "ADB_SHELL_TIMEOUT_SEC": _to_float(
            merged["ADB_SHELL_TIMEOUT_SEC"], key="ADB_SHELL_TIMEOUT_SEC", minimum=1.0
        ),
        "ADB_PULL_TIMEOUT_SEC": _to_float(
            merged["ADB_PULL_TIMEOUT_SEC"], key="ADB_PULL_TIMEOUT_SEC", minimum=1.0
        ),
        "TIMELINE_DEFAULT_SPEED": _to_float(
            merged["TIMELINE_DEFAULT_SPEED"], key="TIMELINE_DEFAULT_SPEED", minimum=0.1
        ),
        "TIMELINE_AUTO_OPEN_AFTER_RUN": bool(merged["TIMELINE_AUTO_OPEN_AFTER_RUN"]),
        "SIDEBAR_COLLAPSED_DEFAULT": bool(merged["SIDEBAR_COLLAPSED_DEFAULT"]),
        "BOTTOM_PANEL_COLLAPSED_DEFAULT": bool(merged["BOTTOM_PANEL_COLLAPSED_DEFAULT"]),
    }
    langs_raw = merged.get("OCR_LANG_LIST")
    langs: list[str] = []
    if isinstance(langs_raw, list):
        langs = [str(x).strip() for x in langs_raw if str(x).strip()]
    elif isinstance(langs_raw, str):
        langs = [x.strip() for x in langs_raw.split(",") if x.strip()]
    if not langs:
        langs = list(_SPECIAL_DEFAULTS["OCR_LANG_LIST"])  # type: ignore[arg-type]
    normalized["OCR_LANG_LIST"] = langs

    policy = str(merged.get("ADB_DEVICE_SELECT_POLICY", "")).strip().lower()
    if policy not in {"strict", "first_available"}:
        policy = str(_SPECIAL_DEFAULTS["ADB_DEVICE_SELECT_POLICY"])
    normalized["ADB_DEVICE_SELECT_POLICY"] = policy

    default_tab = str(merged.get("DEFAULT_BOTTOM_TAB", "")).strip().lower()
    if default_tab not in {"logs", "report", "timeline", "preview"}:
        default_tab = str(_SPECIAL_DEFAULTS["DEFAULT_BOTTOM_TAB"])
    normalized["DEFAULT_BOTTOM_TAB"] = default_tab
    return normalized  # type: ignore[return-value]


def _load_runtime_settings() -> dict[str, object]:
    if not _RUNTIME_SETTINGS_PATH.exists():
        defaults = _normalize_runtime_settings(dict(_RUNTIME_DEFAULTS))
        _save_runtime_settings_unlocked(defaults)
        return defaults
    try:
        with _RUNTIME_SETTINGS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            defaults = _normalize_runtime_settings(dict(_RUNTIME_DEFAULTS))
            _save_runtime_settings_unlocked(defaults)
            return defaults
        normalized = _normalize_runtime_settings(data)
        # Ensure file always contains full normalized keys/default values.
        _save_runtime_settings_unlocked(normalized)
        return normalized
    except Exception:
        defaults = _normalize_runtime_settings(dict(_RUNTIME_DEFAULTS))
        _save_runtime_settings_unlocked(defaults)
        return defaults


def _save_runtime_settings_unlocked(settings: dict[str, object]) -> None:
    _RUNTIME_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _RUNTIME_SETTINGS_PATH.open("w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)


_loaded_runtime_settings = _load_runtime_settings()
EXEC_DEFAULT_TIMEOUT_SEC = float(_loaded_runtime_settings["EXEC_DEFAULT_TIMEOUT_SEC"])
EXEC_DEFAULT_MAX_RETRIES = int(_loaded_runtime_settings["EXEC_DEFAULT_MAX_RETRIES"])
EXEC_RETRY_BACKOFF_SEC = float(_loaded_runtime_settings["EXEC_RETRY_BACKOFF_SEC"])
EXEC_CIRCUIT_FAIL_THRESHOLD = int(_loaded_runtime_settings["EXEC_CIRCUIT_FAIL_THRESHOLD"])
EXEC_CIRCUIT_OPEN_SEC = float(_loaded_runtime_settings["EXEC_CIRCUIT_OPEN_SEC"])
MANUAL_RUN_TIMEOUT_SEC = float(_loaded_runtime_settings["MANUAL_RUN_TIMEOUT_SEC"])
SCHEDULE_RUN_TIMEOUT_SEC = float(_loaded_runtime_settings["SCHEDULE_RUN_TIMEOUT_SEC"])
EXECUTION_QUEUE_MAX_SIZE = int(_loaded_runtime_settings["EXECUTION_QUEUE_MAX_SIZE"])
STREAM_EVENT_QUEUE_SIZE = int(_loaded_runtime_settings["STREAM_EVENT_QUEUE_SIZE"])
STREAM_DROP_WARN_THRESHOLD = int(_loaded_runtime_settings["STREAM_DROP_WARN_THRESHOLD"])
SCHEDULE_DEFAULT_INTERVAL_SEC = int(_loaded_runtime_settings["SCHEDULE_DEFAULT_INTERVAL_SEC"])
SCHEDULE_DEFAULT_MAX_RUNS = int(_loaded_runtime_settings["SCHEDULE_DEFAULT_MAX_RUNS"])
SCHEDULE_AUTO_RUN_ON_CREATE = bool(_loaded_runtime_settings["SCHEDULE_AUTO_RUN_ON_CREATE"])
SCHEDULE_LIST_PAGE_SIZE = int(_loaded_runtime_settings["SCHEDULE_LIST_PAGE_SIZE"])
TMP_CLEANUP_INTERVAL_SEC = int(_loaded_runtime_settings["TMP_CLEANUP_INTERVAL_SEC"])
TMP_CLEANUP_TTL_SEC = int(_loaded_runtime_settings["TMP_CLEANUP_TTL_SEC"])
TAP_PICKER_TMP_TTL_SEC = int(_loaded_runtime_settings["TAP_PICKER_TMP_TTL_SEC"])
REPORT_KEEP_DAYS = int(_loaded_runtime_settings["REPORT_KEEP_DAYS"])
REPORT_MAX_FILES = int(_loaded_runtime_settings["REPORT_MAX_FILES"])
OCR_LANG_LIST = list(_loaded_runtime_settings["OCR_LANG_LIST"])  # type: ignore[arg-type]
OCR_GPU_ENABLED = bool(_loaded_runtime_settings["OCR_GPU_ENABLED"])
OCR_WARMUP_ON_START = bool(_loaded_runtime_settings["OCR_WARMUP_ON_START"])
ADB_SHELL_TIMEOUT_SEC = float(_loaded_runtime_settings["ADB_SHELL_TIMEOUT_SEC"])
ADB_PULL_TIMEOUT_SEC = float(_loaded_runtime_settings["ADB_PULL_TIMEOUT_SEC"])
ADB_DEVICE_SELECT_POLICY = str(_loaded_runtime_settings["ADB_DEVICE_SELECT_POLICY"])
TIMELINE_DEFAULT_SPEED = float(_loaded_runtime_settings["TIMELINE_DEFAULT_SPEED"])
TIMELINE_AUTO_OPEN_AFTER_RUN = bool(_loaded_runtime_settings["TIMELINE_AUTO_OPEN_AFTER_RUN"])
DEFAULT_BOTTOM_TAB = str(_loaded_runtime_settings["DEFAULT_BOTTOM_TAB"])
SIDEBAR_COLLAPSED_DEFAULT = bool(_loaded_runtime_settings["SIDEBAR_COLLAPSED_DEFAULT"])
BOTTOM_PANEL_COLLAPSED_DEFAULT = bool(_loaded_runtime_settings["BOTTOM_PANEL_COLLAPSED_DEFAULT"])

execution_queue = ExecutionQueue(
    engine,
    default_timeout_sec=EXEC_DEFAULT_TIMEOUT_SEC,
    default_max_retries=EXEC_DEFAULT_MAX_RETRIES,
    retry_backoff_sec=EXEC_RETRY_BACKOFF_SEC,
    circuit_fail_threshold=EXEC_CIRCUIT_FAIL_THRESHOLD,
    circuit_open_sec=EXEC_CIRCUIT_OPEN_SEC,
    max_queue_size=EXECUTION_QUEUE_MAX_SIZE,
)
adb.configure_timeouts(shell_timeout_sec=ADB_SHELL_TIMEOUT_SEC, pull_timeout_sec=ADB_PULL_TIMEOUT_SEC)


def get_runtime_settings() -> dict[str, object]:
    with _RUNTIME_SETTINGS_LOCK:
        return {
            "EXEC_DEFAULT_TIMEOUT_SEC": float(EXEC_DEFAULT_TIMEOUT_SEC),
            "EXEC_DEFAULT_MAX_RETRIES": int(EXEC_DEFAULT_MAX_RETRIES),
            "EXEC_RETRY_BACKOFF_SEC": float(EXEC_RETRY_BACKOFF_SEC),
            "EXEC_CIRCUIT_FAIL_THRESHOLD": int(EXEC_CIRCUIT_FAIL_THRESHOLD),
            "EXEC_CIRCUIT_OPEN_SEC": float(EXEC_CIRCUIT_OPEN_SEC),
            "MANUAL_RUN_TIMEOUT_SEC": float(MANUAL_RUN_TIMEOUT_SEC),
            "SCHEDULE_RUN_TIMEOUT_SEC": float(SCHEDULE_RUN_TIMEOUT_SEC),
            "EXECUTION_QUEUE_MAX_SIZE": int(EXECUTION_QUEUE_MAX_SIZE),
            "STREAM_EVENT_QUEUE_SIZE": int(STREAM_EVENT_QUEUE_SIZE),
            "STREAM_DROP_WARN_THRESHOLD": int(STREAM_DROP_WARN_THRESHOLD),
            "SCHEDULE_DEFAULT_INTERVAL_SEC": int(SCHEDULE_DEFAULT_INTERVAL_SEC),
            "SCHEDULE_DEFAULT_MAX_RUNS": int(SCHEDULE_DEFAULT_MAX_RUNS),
            "SCHEDULE_AUTO_RUN_ON_CREATE": bool(SCHEDULE_AUTO_RUN_ON_CREATE),
            "SCHEDULE_LIST_PAGE_SIZE": int(SCHEDULE_LIST_PAGE_SIZE),
            "TMP_CLEANUP_INTERVAL_SEC": int(TMP_CLEANUP_INTERVAL_SEC),
            "TMP_CLEANUP_TTL_SEC": int(TMP_CLEANUP_TTL_SEC),
            "TAP_PICKER_TMP_TTL_SEC": int(TAP_PICKER_TMP_TTL_SEC),
            "REPORT_KEEP_DAYS": int(REPORT_KEEP_DAYS),
            "REPORT_MAX_FILES": int(REPORT_MAX_FILES),
            "OCR_LANG_LIST": list(OCR_LANG_LIST),
            "OCR_GPU_ENABLED": bool(OCR_GPU_ENABLED),
            "OCR_WARMUP_ON_START": bool(OCR_WARMUP_ON_START),
            "ADB_SHELL_TIMEOUT_SEC": float(ADB_SHELL_TIMEOUT_SEC),
            "ADB_PULL_TIMEOUT_SEC": float(ADB_PULL_TIMEOUT_SEC),
            "ADB_DEVICE_SELECT_POLICY": str(ADB_DEVICE_SELECT_POLICY),
            "TIMELINE_DEFAULT_SPEED": float(TIMELINE_DEFAULT_SPEED),
            "TIMELINE_AUTO_OPEN_AFTER_RUN": bool(TIMELINE_AUTO_OPEN_AFTER_RUN),
            "DEFAULT_BOTTOM_TAB": str(DEFAULT_BOTTOM_TAB),
            "SIDEBAR_COLLAPSED_DEFAULT": bool(SIDEBAR_COLLAPSED_DEFAULT),
            "BOTTOM_PANEL_COLLAPSED_DEFAULT": bool(BOTTOM_PANEL_COLLAPSED_DEFAULT),
        }


def update_runtime_settings(payload: dict[str, object]) -> dict[str, object]:
    global EXEC_DEFAULT_TIMEOUT_SEC
    global EXEC_DEFAULT_MAX_RETRIES
    global EXEC_RETRY_BACKOFF_SEC
    global EXEC_CIRCUIT_FAIL_THRESHOLD
    global EXEC_CIRCUIT_OPEN_SEC
    global MANUAL_RUN_TIMEOUT_SEC
    global SCHEDULE_RUN_TIMEOUT_SEC
    global EXECUTION_QUEUE_MAX_SIZE
    global STREAM_EVENT_QUEUE_SIZE
    global STREAM_DROP_WARN_THRESHOLD
    global SCHEDULE_DEFAULT_INTERVAL_SEC
    global SCHEDULE_DEFAULT_MAX_RUNS
    global SCHEDULE_AUTO_RUN_ON_CREATE
    global SCHEDULE_LIST_PAGE_SIZE
    global TMP_CLEANUP_INTERVAL_SEC
    global TMP_CLEANUP_TTL_SEC
    global TAP_PICKER_TMP_TTL_SEC
    global REPORT_KEEP_DAYS
    global REPORT_MAX_FILES
    global OCR_LANG_LIST
    global OCR_GPU_ENABLED
    global OCR_WARMUP_ON_START
    global ADB_SHELL_TIMEOUT_SEC
    global ADB_PULL_TIMEOUT_SEC
    global ADB_DEVICE_SELECT_POLICY
    global TIMELINE_DEFAULT_SPEED
    global TIMELINE_AUTO_OPEN_AFTER_RUN
    global DEFAULT_BOTTOM_TAB
    global SIDEBAR_COLLAPSED_DEFAULT
    global BOTTOM_PANEL_COLLAPSED_DEFAULT

    with _RUNTIME_SETTINGS_LOCK:
        current = {
            "EXEC_DEFAULT_TIMEOUT_SEC": float(EXEC_DEFAULT_TIMEOUT_SEC),
            "EXEC_DEFAULT_MAX_RETRIES": int(EXEC_DEFAULT_MAX_RETRIES),
            "EXEC_RETRY_BACKOFF_SEC": float(EXEC_RETRY_BACKOFF_SEC),
            "EXEC_CIRCUIT_FAIL_THRESHOLD": int(EXEC_CIRCUIT_FAIL_THRESHOLD),
            "EXEC_CIRCUIT_OPEN_SEC": float(EXEC_CIRCUIT_OPEN_SEC),
            "MANUAL_RUN_TIMEOUT_SEC": float(MANUAL_RUN_TIMEOUT_SEC),
            "SCHEDULE_RUN_TIMEOUT_SEC": float(SCHEDULE_RUN_TIMEOUT_SEC),
            "EXECUTION_QUEUE_MAX_SIZE": int(EXECUTION_QUEUE_MAX_SIZE),
            "STREAM_EVENT_QUEUE_SIZE": int(STREAM_EVENT_QUEUE_SIZE),
            "STREAM_DROP_WARN_THRESHOLD": int(STREAM_DROP_WARN_THRESHOLD),
            "SCHEDULE_DEFAULT_INTERVAL_SEC": int(SCHEDULE_DEFAULT_INTERVAL_SEC),
            "SCHEDULE_DEFAULT_MAX_RUNS": int(SCHEDULE_DEFAULT_MAX_RUNS),
            "SCHEDULE_AUTO_RUN_ON_CREATE": bool(SCHEDULE_AUTO_RUN_ON_CREATE),
            "SCHEDULE_LIST_PAGE_SIZE": int(SCHEDULE_LIST_PAGE_SIZE),
            "TMP_CLEANUP_INTERVAL_SEC": int(TMP_CLEANUP_INTERVAL_SEC),
            "TMP_CLEANUP_TTL_SEC": int(TMP_CLEANUP_TTL_SEC),
            "TAP_PICKER_TMP_TTL_SEC": int(TAP_PICKER_TMP_TTL_SEC),
            "REPORT_KEEP_DAYS": int(REPORT_KEEP_DAYS),
            "REPORT_MAX_FILES": int(REPORT_MAX_FILES),
            "OCR_LANG_LIST": list(OCR_LANG_LIST),
            "OCR_GPU_ENABLED": bool(OCR_GPU_ENABLED),
            "OCR_WARMUP_ON_START": bool(OCR_WARMUP_ON_START),
            "ADB_SHELL_TIMEOUT_SEC": float(ADB_SHELL_TIMEOUT_SEC),
            "ADB_PULL_TIMEOUT_SEC": float(ADB_PULL_TIMEOUT_SEC),
            "ADB_DEVICE_SELECT_POLICY": str(ADB_DEVICE_SELECT_POLICY),
            "TIMELINE_DEFAULT_SPEED": float(TIMELINE_DEFAULT_SPEED),
            "TIMELINE_AUTO_OPEN_AFTER_RUN": bool(TIMELINE_AUTO_OPEN_AFTER_RUN),
            "DEFAULT_BOTTOM_TAB": str(DEFAULT_BOTTOM_TAB),
            "SIDEBAR_COLLAPSED_DEFAULT": bool(SIDEBAR_COLLAPSED_DEFAULT),
            "BOTTOM_PANEL_COLLAPSED_DEFAULT": bool(BOTTOM_PANEL_COLLAPSED_DEFAULT),
        }
        patch: dict[str, object] = dict(current)
        for key in _RUNTIME_SETTING_KEYS:
            if key in payload:
                patch[key] = payload[key]
        normalized = _normalize_runtime_settings(patch)

        EXEC_DEFAULT_TIMEOUT_SEC = float(normalized["EXEC_DEFAULT_TIMEOUT_SEC"])
        EXEC_DEFAULT_MAX_RETRIES = int(normalized["EXEC_DEFAULT_MAX_RETRIES"])
        EXEC_RETRY_BACKOFF_SEC = float(normalized["EXEC_RETRY_BACKOFF_SEC"])
        EXEC_CIRCUIT_FAIL_THRESHOLD = int(normalized["EXEC_CIRCUIT_FAIL_THRESHOLD"])
        EXEC_CIRCUIT_OPEN_SEC = float(normalized["EXEC_CIRCUIT_OPEN_SEC"])
        MANUAL_RUN_TIMEOUT_SEC = float(normalized["MANUAL_RUN_TIMEOUT_SEC"])
        SCHEDULE_RUN_TIMEOUT_SEC = float(normalized["SCHEDULE_RUN_TIMEOUT_SEC"])
        EXECUTION_QUEUE_MAX_SIZE = int(normalized["EXECUTION_QUEUE_MAX_SIZE"])
        STREAM_EVENT_QUEUE_SIZE = int(normalized["STREAM_EVENT_QUEUE_SIZE"])
        STREAM_DROP_WARN_THRESHOLD = int(normalized["STREAM_DROP_WARN_THRESHOLD"])
        SCHEDULE_DEFAULT_INTERVAL_SEC = int(normalized["SCHEDULE_DEFAULT_INTERVAL_SEC"])
        SCHEDULE_DEFAULT_MAX_RUNS = int(normalized["SCHEDULE_DEFAULT_MAX_RUNS"])
        SCHEDULE_AUTO_RUN_ON_CREATE = bool(normalized["SCHEDULE_AUTO_RUN_ON_CREATE"])
        SCHEDULE_LIST_PAGE_SIZE = int(normalized["SCHEDULE_LIST_PAGE_SIZE"])
        TMP_CLEANUP_INTERVAL_SEC = int(normalized["TMP_CLEANUP_INTERVAL_SEC"])
        TMP_CLEANUP_TTL_SEC = int(normalized["TMP_CLEANUP_TTL_SEC"])
        TAP_PICKER_TMP_TTL_SEC = int(normalized["TAP_PICKER_TMP_TTL_SEC"])
        REPORT_KEEP_DAYS = int(normalized["REPORT_KEEP_DAYS"])
        REPORT_MAX_FILES = int(normalized["REPORT_MAX_FILES"])
        OCR_LANG_LIST = list(normalized["OCR_LANG_LIST"])  # type: ignore[arg-type]
        OCR_GPU_ENABLED = bool(normalized["OCR_GPU_ENABLED"])
        OCR_WARMUP_ON_START = bool(normalized["OCR_WARMUP_ON_START"])
        ADB_SHELL_TIMEOUT_SEC = float(normalized["ADB_SHELL_TIMEOUT_SEC"])
        ADB_PULL_TIMEOUT_SEC = float(normalized["ADB_PULL_TIMEOUT_SEC"])
        ADB_DEVICE_SELECT_POLICY = str(normalized["ADB_DEVICE_SELECT_POLICY"])
        TIMELINE_DEFAULT_SPEED = float(normalized["TIMELINE_DEFAULT_SPEED"])
        TIMELINE_AUTO_OPEN_AFTER_RUN = bool(normalized["TIMELINE_AUTO_OPEN_AFTER_RUN"])
        DEFAULT_BOTTOM_TAB = str(normalized["DEFAULT_BOTTOM_TAB"])
        SIDEBAR_COLLAPSED_DEFAULT = bool(normalized["SIDEBAR_COLLAPSED_DEFAULT"])
        BOTTOM_PANEL_COLLAPSED_DEFAULT = bool(normalized["BOTTOM_PANEL_COLLAPSED_DEFAULT"])

        with execution_queue._lock:  # noqa: SLF001
            execution_queue._default_timeout_sec = EXEC_DEFAULT_TIMEOUT_SEC  # noqa: SLF001
            execution_queue._default_max_retries = EXEC_DEFAULT_MAX_RETRIES  # noqa: SLF001
            execution_queue._retry_backoff_sec = EXEC_RETRY_BACKOFF_SEC  # noqa: SLF001
            execution_queue._circuit_fail_threshold = EXEC_CIRCUIT_FAIL_THRESHOLD  # noqa: SLF001
            execution_queue._circuit_open_sec = EXEC_CIRCUIT_OPEN_SEC  # noqa: SLF001
            execution_queue._queue.maxsize = max(0, int(EXECUTION_QUEUE_MAX_SIZE))  # noqa: SLF001
        adb.configure_timeouts(shell_timeout_sec=ADB_SHELL_TIMEOUT_SEC, pull_timeout_sec=ADB_PULL_TIMEOUT_SEC)

        _save_runtime_settings_unlocked(normalized)
        return dict(normalized)

# ---------------------------------------------------------------------------
# Manual-run concurrency state
# ---------------------------------------------------------------------------
_MANUAL_RUN_LOCK = threading.Lock()
_MANUAL_RUN_STATE: dict[str, object] = {
    "running": False,
    "cancel_event": threading.Event(),
}


def _try_begin_manual_run() -> tuple[bool, str, threading.Event | None]:
    with _MANUAL_RUN_LOCK:
        if bool(_MANUAL_RUN_STATE.get("running")):
            return False, "已有手动执行任务正在运行，请先停止或等待完成。", None
        if _is_scheduler_running():
            return False, "调度任务正在执行中，请稍后再手动运行。", None
        cancel_event = threading.Event()
        _MANUAL_RUN_STATE["running"] = True
        _MANUAL_RUN_STATE["cancel_event"] = cancel_event
        return True, "", cancel_event


def _end_manual_run() -> None:
    with _MANUAL_RUN_LOCK:
        _MANUAL_RUN_STATE["running"] = False
        _MANUAL_RUN_STATE["cancel_event"] = threading.Event()


# ---------------------------------------------------------------------------
# Scheduler concurrency state
# ---------------------------------------------------------------------------
_SCHEDULER_LOCK = threading.Lock()
_SCHEDULES: dict[str, dict[str, object]] = {}
_SCHEDULER_STARTED = False
_SCHEDULE_RUNNING_COUNT = 0
_SCHEDULE_CANCEL_EVENT: threading.Event | None = None


def _is_scheduler_running() -> bool:
    with _SCHEDULER_LOCK:
        return _SCHEDULE_RUNNING_COUNT > 0


def _is_scheduler_running_locked() -> bool:
    return _SCHEDULE_RUNNING_COUNT > 0


def _increment_schedule_running() -> None:
    global _SCHEDULE_RUNNING_COUNT
    _SCHEDULE_RUNNING_COUNT += 1


def _decrement_schedule_running() -> None:
    global _SCHEDULE_RUNNING_COUNT
    _SCHEDULE_RUNNING_COUNT = max(0, _SCHEDULE_RUNNING_COUNT - 1)


def _mark_scheduler_started() -> None:
    global _SCHEDULER_STARTED
    _SCHEDULER_STARTED = True


def _set_schedule_cancel_event(evt: threading.Event | None) -> None:
    global _SCHEDULE_CANCEL_EVENT
    _SCHEDULE_CANCEL_EVENT = evt


def _get_schedule_cancel_event() -> threading.Event | None:
    return _SCHEDULE_CANCEL_EVENT
