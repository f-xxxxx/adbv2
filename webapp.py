from __future__ import annotations

import threading
import sys

from flask import Flask

from routes.schedules import _ensure_scheduler_started, schedules_bp
from routes.utils import utils_bp
from routes.workflows import workflows_bp
from src.adbflow.observability import setup_logging
from src.adbflow.tmp_guardian import start_tmp_cleanup_daemon
import webapp_state as state
from webapp_state import OUTPUTS_DIR

app = Flask(__name__, template_folder="web", static_folder="web")
app.register_blueprint(workflows_bp)
app.register_blueprint(schedules_bp)
app.register_blueprint(utils_bp)
setup_logging()


def _try_raise_fd_limit() -> None:
    if sys.platform != "darwin":
        return
    try:
        import resource  # type: ignore

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        target_soft = min(max(soft, 8192), hard)
        if target_soft > soft:
            resource.setrlimit(resource.RLIMIT_NOFILE, (target_soft, hard))
    except Exception:
        # Best-effort only; keep startup robust.
        pass


def _warmup_ocr() -> None:
    from src.adbflow.nodes import get_ocr_reader

    if not bool(state.OCR_WARMUP_ON_START):
        return

    def _do_warmup():
        try:
            get_ocr_reader(list(state.OCR_LANG_LIST), gpu=bool(state.OCR_GPU_ENABLED))
        except Exception:
            pass

    threading.Thread(target=_do_warmup, daemon=True, name="ocr-warmup").start()


_warmup_ocr()
_try_raise_fd_limit()
_ensure_scheduler_started()
start_tmp_cleanup_daemon(
    OUTPUTS_DIR / "tmp",
    interval_sec=max(10, int(state.TMP_CLEANUP_INTERVAL_SEC)),
    ttl_sec=max(60, int(state.TMP_CLEANUP_TTL_SEC)),
)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=7860, debug=True, use_reloader=False)
