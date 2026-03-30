from __future__ import annotations

import threading
from pathlib import Path

from src.adbflow.adb_client import ADBClient
from src.adbflow.engine import WorkflowEngine

# ---------------------------------------------------------------------------
# Directory constants
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Shared instances
# ---------------------------------------------------------------------------
adb = ADBClient()
engine = WorkflowEngine(adb=adb)

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
