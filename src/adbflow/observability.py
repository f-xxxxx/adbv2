from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

_LOGGER_NAME = "adbflow"
_LOG_INIT_LOCK = threading.Lock()
_LOG_INITIALIZED = False
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_LOGS_DIR = _PROJECT_ROOT / "logs"


class DailyTextFileHandler(logging.Handler):
    """Write logs to logs/YYYY-MM-DD.txt.

    Open/close file on each emit to avoid long-lived file descriptors.
    """

    def __init__(self, logs_dir: Path) -> None:
        super().__init__()
        self._logs_dir = logs_dir

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = self.format(record)
            day = datetime.now().strftime("%Y-%m-%d")
            self._logs_dir.mkdir(parents=True, exist_ok=True)
            log_path = self._logs_dir / f"{day}.txt"
            with log_path.open("a", encoding="utf-8") as f:
                f.write(message)
                f.write("\n")
        except Exception:
            self.handleError(record)


def setup_logging() -> None:
    global _LOG_INITIALIZED
    if _LOG_INITIALIZED:
        return
    with _LOG_INIT_LOCK:
        if _LOG_INITIALIZED:
            return
        logger = logging.getLogger(_LOGGER_NAME)
        logger.setLevel(logging.INFO)
        logger.propagate = False
        _LOGS_DIR.mkdir(parents=True, exist_ok=True)
        if not logger.handlers:
            formatter = logging.Formatter("%(message)s")
            stream_handler = logging.StreamHandler()
            stream_handler.setFormatter(formatter)
            file_handler = DailyTextFileHandler(_LOGS_DIR)
            file_handler.setFormatter(formatter)
            logger.addHandler(stream_handler)
            logger.addHandler(file_handler)
        _LOG_INITIALIZED = True


def new_run_id(prefix: str = "run") -> str:
    now_ms = int(time.time() * 1000)
    return f"{prefix}_{now_ms}_{uuid.uuid4().hex[:8]}"


def log_event(event: str, level: int = logging.INFO, **fields: Any) -> None:
    setup_logging()
    payload = {
        "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "event": event,
        **fields,
    }
    logging.getLogger(_LOGGER_NAME).log(level, json.dumps(payload, ensure_ascii=False, default=str))
