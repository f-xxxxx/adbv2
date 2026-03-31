from __future__ import annotations

import threading
import time
from pathlib import Path

from .observability import log_event

_LOCK = threading.Lock()
_STARTED = False


def start_tmp_cleanup_daemon(
    tmp_root: Path,
    *,
    interval_sec: int = 600,
    ttl_sec: int = 3600,
) -> None:
    global _STARTED
    if ttl_sec <= 0 or interval_sec <= 0:
        return
    with _LOCK:
        if _STARTED:
            return
        _STARTED = True
    root = tmp_root.resolve()
    root.mkdir(parents=True, exist_ok=True)

    def _worker() -> None:
        # One startup sweep, then periodic sweeps.
        _cleanup_once(root, ttl_sec)
        while True:
            time.sleep(float(interval_sec))
            _cleanup_once(root, ttl_sec)

    threading.Thread(target=_worker, daemon=True, name="adbflow-tmp-cleanup").start()
    log_event(
        "tmp_cleanup_daemon_started",
        tmp_root=str(root),
        interval_sec=interval_sec,
        ttl_sec=ttl_sec,
    )


def _cleanup_once(root: Path, ttl_sec: int) -> None:
    now = time.time()
    removed_files = 0
    removed_dirs = 0
    cutoff = now - float(ttl_sec)

    try:
        if not root.exists():
            return
        # Remove stale files first.
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            try:
                mtime = p.stat().st_mtime
            except Exception:
                continue
            if mtime >= cutoff:
                continue
            try:
                p.unlink(missing_ok=True)
                removed_files += 1
            except Exception:
                continue

        # Remove empty directories from deep to shallow.
        all_dirs = [d for d in root.rglob("*") if d.is_dir()]
        all_dirs.sort(key=lambda x: len(x.parts), reverse=True)
        for d in all_dirs:
            try:
                d.rmdir()
                removed_dirs += 1
            except Exception:
                continue
    finally:
        if removed_files or removed_dirs:
            log_event(
                "tmp_cleanup_sweep",
                tmp_root=str(root),
                removed_files=removed_files,
                removed_dirs=removed_dirs,
                ttl_sec=ttl_sec,
            )
