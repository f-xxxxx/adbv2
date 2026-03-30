from __future__ import annotations

from typing import Any

from flask import jsonify

from src.adbflow.error_codes import ErrorCode
from src.adbflow.observability import log_event


def err(message: str, code: str = ErrorCode.BAD_REQUEST, status: int = 400, **extra: Any):
    payload: dict[str, Any] = {
        "ok": False,
        "error": str(message),
        "error_code": str(code),
    }
    if extra:
        payload.update(extra)
    log_event("api_error", error_code=code, status=status, error=message, details=extra or {})
    return jsonify(payload), int(status)
