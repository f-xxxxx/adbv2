from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from datetime import datetime
from typing import Any

_LOGGER_NAME = "adbflow"
_LOG_INIT_LOCK = threading.Lock()
_LOG_INITIALIZED = False


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
        if not logger.handlers:
            handler = logging.StreamHandler()
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(handler)
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
