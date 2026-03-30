from __future__ import annotations

import threading

from flask import Flask

from routes.schedules import _ensure_scheduler_started, schedules_bp
from routes.utils import utils_bp
from routes.workflows import workflows_bp
from src.adbflow.observability import setup_logging

app = Flask(__name__, template_folder="web", static_folder="web")
app.register_blueprint(workflows_bp)
app.register_blueprint(schedules_bp)
app.register_blueprint(utils_bp)
setup_logging()


def _warmup_ocr() -> None:
    from src.adbflow.nodes import get_ocr_reader

    def _do_warmup():
        try:
            get_ocr_reader(["ch_sim", "en"], gpu=False)
        except Exception:
            pass

    threading.Thread(target=_do_warmup, daemon=True, name="ocr-warmup").start()


_warmup_ocr()
_ensure_scheduler_started()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=7860, debug=True, use_reloader=False)
