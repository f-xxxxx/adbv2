from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

_DB_LOCK = threading.Lock()
_DB_PATH: Path | None = None


def init_db(db_path: Path) -> Path:
    global _DB_PATH
    with _DB_LOCK:
        _DB_PATH = Path(db_path).resolve()
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS schedules (
                    id TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    trigger TEXT NOT NULL,
                    schedule_id TEXT,
                    status TEXT NOT NULL,
                    error_code TEXT,
                    error_message TEXT,
                    started_at REAL NOT NULL,
                    ended_at REAL,
                    elapsed_sec REAL,
                    workflow_node_count INTEGER NOT NULL DEFAULT 0,
                    log_count INTEGER NOT NULL DEFAULT 0,
                    output_node_count INTEGER NOT NULL DEFAULT 0,
                    report_path TEXT,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS reports (
                    report_path TEXT PRIMARY KEY,
                    run_id TEXT,
                    trigger TEXT NOT NULL,
                    schedule_id TEXT,
                    ok INTEGER NOT NULL,
                    started_at REAL NOT NULL,
                    ended_at REAL NOT NULL,
                    elapsed_sec REAL NOT NULL,
                    error_code TEXT,
                    error_message TEXT,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS node_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    schedule_id TEXT,
                    node_id TEXT,
                    class_type TEXT,
                    event TEXT NOT NULL,
                    ts REAL NOT NULL,
                    duration_ms REAL,
                    payload_json TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_runs_schedule_id ON runs(schedule_id);
                CREATE INDEX IF NOT EXISTS idx_runs_schedule_started ON runs(schedule_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_runs_report_path ON runs(report_path);
                CREATE INDEX IF NOT EXISTS idx_reports_run_id ON reports(run_id);
                CREATE INDEX IF NOT EXISTS idx_reports_schedule_created ON reports(schedule_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_node_events_run_id ON node_events(run_id);
                CREATE INDEX IF NOT EXISTS idx_node_events_schedule_ts ON node_events(schedule_id, ts);
                CREATE INDEX IF NOT EXISTS idx_node_events_run_node_event ON node_events(run_id, node_id, event, ts);
                CREATE INDEX IF NOT EXISTS idx_node_events_class ON node_events(class_type);
                """
            )
        return _DB_PATH


def load_schedules() -> dict[str, dict[str, Any]]:
    with _DB_LOCK:
        with _connect() as conn:
            rows = conn.execute("SELECT id, payload_json FROM schedules").fetchall()
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        sid = str(row["id"])
        try:
            payload = json.loads(str(row["payload_json"]))
        except Exception:
            continue
        if isinstance(payload, dict):
            result[sid] = payload
    return result


def replace_schedules(items: dict[str, dict[str, Any]]) -> None:
    now = time.time()
    with _DB_LOCK:
        with _connect() as conn:
            conn.execute("DELETE FROM schedules")
            for sid, payload in items.items():
                conn.execute(
                    "INSERT INTO schedules(id, payload_json, updated_at) VALUES(?, ?, ?)",
                    (str(sid), json.dumps(payload, ensure_ascii=False), now),
                )
            conn.commit()


def insert_run(
    run_id: str,
    trigger: str,
    schedule_id: str = "",
    started_at: float | None = None,
    workflow_node_count: int = 0,
) -> None:
    ts = time.time()
    started = float(started_at if started_at is not None else ts)
    with _DB_LOCK:
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO runs(
                    run_id, trigger, schedule_id, status, started_at,
                    workflow_node_count, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(run_id),
                    str(trigger),
                    str(schedule_id or ""),
                    "running",
                    started,
                    max(0, int(workflow_node_count)),
                    ts,
                ),
            )
            conn.commit()


def finish_run(
    run_id: str,
    *,
    status: str,
    ended_at: float,
    elapsed_sec: float,
    error_code: str = "",
    error_message: str = "",
    log_count: int = 0,
    output_node_count: int = 0,
    report_path: str = "",
) -> None:
    with _DB_LOCK:
        with _connect() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status = ?,
                    ended_at = ?,
                    elapsed_sec = ?,
                    error_code = ?,
                    error_message = ?,
                    log_count = ?,
                    output_node_count = ?,
                    report_path = ?
                WHERE run_id = ?
                """,
                (
                    str(status),
                    float(ended_at),
                    max(0.0, float(elapsed_sec)),
                    str(error_code or ""),
                    str(error_message or ""),
                    max(0, int(log_count)),
                    max(0, int(output_node_count)),
                    str(report_path or ""),
                    str(run_id),
                ),
            )
            conn.commit()


def upsert_report(
    *,
    report_path: str,
    run_id: str = "",
    trigger: str,
    schedule_id: str = "",
    ok: bool,
    started_at: float,
    ended_at: float,
    elapsed_sec: float,
    error_code: str = "",
    error_message: str = "",
) -> None:
    created_at = time.time()
    with _DB_LOCK:
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO reports(
                    report_path, run_id, trigger, schedule_id, ok, started_at, ended_at,
                    elapsed_sec, error_code, error_message, created_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(report_path) DO UPDATE SET
                    run_id = excluded.run_id,
                    trigger = excluded.trigger,
                    schedule_id = excluded.schedule_id,
                    ok = excluded.ok,
                    started_at = excluded.started_at,
                    ended_at = excluded.ended_at,
                    elapsed_sec = excluded.elapsed_sec,
                    error_code = excluded.error_code,
                    error_message = excluded.error_message,
                    created_at = excluded.created_at
                """,
                (
                    str(report_path),
                    str(run_id or ""),
                    str(trigger),
                    str(schedule_id or ""),
                    1 if ok else 0,
                    float(started_at),
                    float(ended_at),
                    max(0.0, float(elapsed_sec)),
                    str(error_code or ""),
                    str(error_message or ""),
                    created_at,
                ),
            )
            conn.commit()


def finalize_run_and_report(
    *,
    run_id: str,
    status: str,
    ended_at: float,
    elapsed_sec: float,
    error_code: str = "",
    error_message: str = "",
    log_count: int = 0,
    output_node_count: int = 0,
    report_path: str,
    trigger: str,
    schedule_id: str = "",
    ok: bool,
    started_at: float,
) -> None:
    created_at = time.time()
    with _DB_LOCK:
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO reports(
                    report_path, run_id, trigger, schedule_id, ok, started_at, ended_at,
                    elapsed_sec, error_code, error_message, created_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(report_path) DO UPDATE SET
                    run_id = excluded.run_id,
                    trigger = excluded.trigger,
                    schedule_id = excluded.schedule_id,
                    ok = excluded.ok,
                    started_at = excluded.started_at,
                    ended_at = excluded.ended_at,
                    elapsed_sec = excluded.elapsed_sec,
                    error_code = excluded.error_code,
                    error_message = excluded.error_message,
                    created_at = excluded.created_at
                """,
                (
                    str(report_path),
                    str(run_id or ""),
                    str(trigger),
                    str(schedule_id or ""),
                    1 if ok else 0,
                    float(started_at),
                    float(ended_at),
                    max(0.0, float(elapsed_sec)),
                    str(error_code or ""),
                    str(error_message or ""),
                    created_at,
                ),
            )
            conn.execute(
                """
                UPDATE runs
                SET status = ?,
                    ended_at = ?,
                    elapsed_sec = ?,
                    error_code = ?,
                    error_message = ?,
                    log_count = ?,
                    output_node_count = ?,
                    report_path = ?
                WHERE run_id = ?
                """,
                (
                    str(status),
                    float(ended_at),
                    max(0.0, float(elapsed_sec)),
                    str(error_code or ""),
                    str(error_message or ""),
                    max(0, int(log_count)),
                    max(0, int(output_node_count)),
                    str(report_path or ""),
                    str(run_id),
                ),
            )
            conn.commit()


def insert_node_event(
    *,
    run_id: str,
    schedule_id: str = "",
    node_id: str = "",
    class_type: str = "",
    event: str,
    ts: float | None = None,
    duration_ms: float | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    event_ts = float(ts if ts is not None else time.time())
    payload_text = json.dumps(payload or {}, ensure_ascii=False)
    with _DB_LOCK:
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO node_events(
                    run_id, schedule_id, node_id, class_type, event, ts, duration_ms, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(run_id),
                    str(schedule_id or ""),
                    str(node_id or ""),
                    str(class_type or ""),
                    str(event),
                    event_ts,
                    float(duration_ms) if duration_ms is not None else None,
                    payload_text,
                ),
            )
            conn.commit()


def insert_node_events_bulk(items: list[dict[str, Any]]) -> None:
    if not items:
        return
    rows: list[tuple[str, str, str, str, float, float | None, str]] = []
    now_ts = time.time()
    for item in items:
        if not isinstance(item, dict):
            continue
        event_name = str(item.get("event", "")).strip()
        if not event_name:
            continue
        ts_raw = item.get("ts", now_ts)
        try:
            event_ts = float(ts_raw)
        except Exception:
            event_ts = now_ts
        duration_raw = item.get("duration_ms")
        duration_ms: float | None
        if duration_raw is None:
            duration_ms = None
        else:
            try:
                duration_ms = float(duration_raw)
            except Exception:
                duration_ms = None
        payload_obj = item.get("payload")
        payload_text = json.dumps(payload_obj if isinstance(payload_obj, dict) else {}, ensure_ascii=False)
        rows.append(
            (
                str(item.get("run_id", "") or ""),
                str(item.get("schedule_id", "") or ""),
                str(item.get("node_id", "") or ""),
                str(item.get("class_type", "") or ""),
                event_name,
                event_ts,
                duration_ms,
                payload_text,
            )
        )
    if not rows:
        return
    with _DB_LOCK:
        with _connect() as conn:
            conn.executemany(
                """
                INSERT INTO node_events(
                    run_id, schedule_id, node_id, class_type, event, ts, duration_ms, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            conn.commit()


def health_summary() -> dict[str, Any]:
    started = time.time()
    with _DB_LOCK:
        with _connect() as conn:
            conn.execute("SELECT 1").fetchone()
            runs_count = int(conn.execute("SELECT COUNT(*) AS c FROM runs").fetchone()["c"])
            schedules_count = int(conn.execute("SELECT COUNT(*) AS c FROM schedules").fetchone()["c"])
            report_count = int(conn.execute("SELECT COUNT(*) AS c FROM reports").fetchone()["c"])
    return {
        "db_ok": True,
        "db_path": str(_require_db_path()),
        "runs_count": runs_count,
        "schedules_count": schedules_count,
        "report_count": report_count,
        "elapsed_ms": round((time.time() - started) * 1000.0, 2),
    }


def metrics_summary(top_n: int = 5) -> dict[str, Any]:
    n = max(1, min(20, int(top_n)))
    with _DB_LOCK:
        with _connect() as conn:
            run_row = conn.execute(
                """
                SELECT
                    COUNT(*) AS total_runs,
                    SUM(CASE WHEN status IN ('error', 'cancelled') THEN 1 ELSE 0 END) AS failed_runs,
                    AVG(CASE WHEN elapsed_sec IS NOT NULL THEN elapsed_sec END) AS avg_elapsed_sec
                FROM runs
                """
            ).fetchone()
            top_rows = conn.execute(
                """
                SELECT
                    COALESCE(class_type, '') AS class_type,
                    COUNT(*) AS run_count,
                    AVG(duration_ms) AS avg_duration_ms,
                    MAX(duration_ms) AS max_duration_ms
                FROM node_events
                WHERE event = 'node_done' AND duration_ms IS NOT NULL
                GROUP BY COALESCE(class_type, '')
                ORDER BY avg_duration_ms DESC
                LIMIT ?
                """,
                (n,),
            ).fetchall()
    total_runs = int(run_row["total_runs"] or 0)
    failed_runs = int(run_row["failed_runs"] or 0)
    failure_rate = (failed_runs / total_runs) if total_runs > 0 else 0.0
    return {
        "total_runs": total_runs,
        "failed_runs": failed_runs,
        "failure_rate": round(failure_rate, 4),
        "avg_elapsed_sec": round(float(run_row["avg_elapsed_sec"] or 0.0), 3),
        "node_duration_top": [
            {
                "class_type": str(r["class_type"] or ""),
                "run_count": int(r["run_count"] or 0),
                "avg_duration_ms": round(float(r["avg_duration_ms"] or 0.0), 2),
                "max_duration_ms": round(float(r["max_duration_ms"] or 0.0), 2),
            }
            for r in top_rows
        ],
    }


def get_run_timeline(run_id: str) -> dict[str, Any] | None:
    rid = str(run_id or "").strip()
    if not rid:
        return None
    with _DB_LOCK:
        with _connect() as conn:
            run_row = conn.execute(
                """
                SELECT run_id, trigger, schedule_id, status, error_code, error_message, started_at, ended_at, elapsed_sec
                FROM runs
                WHERE run_id = ?
                LIMIT 1
                """,
                (rid,),
            ).fetchone()
            if run_row is None:
                return None
            event_rows = conn.execute(
                """
                SELECT id, node_id, class_type, event, ts, duration_ms, payload_json
                FROM node_events
                WHERE run_id = ?
                ORDER BY ts ASC, id ASC
                """,
                (rid,),
            ).fetchall()

    start_map: dict[str, float] = {}
    timeline_nodes: list[dict[str, Any]] = []
    for row in event_rows:
        node_id = str(row["node_id"] or "").strip()
        event_name = str(row["event"] or "").strip()
        class_type = str(row["class_type"] or "").strip()
        ts = float(row["ts"] or 0.0)
        duration_ms_raw = row["duration_ms"]
        duration_ms = float(duration_ms_raw) if duration_ms_raw is not None else None
        payload = _load_payload_json(row["payload_json"])

        if event_name == "node_start" and node_id:
            start_map[node_id] = ts
            continue

        if event_name == "node_done":
            start_ts = start_map.pop(node_id, None)
            if start_ts is None and duration_ms is not None:
                start_ts = ts - duration_ms / 1000.0
            if duration_ms is None and start_ts is not None:
                duration_ms = max(0.0, (ts - start_ts) * 1000.0)
            timeline_nodes.append(
                {
                    "node_id": node_id,
                    "class_type": class_type,
                    "status": "ok",
                    "start_ts": start_ts or ts,
                    "end_ts": ts,
                    "duration_ms": round(float(duration_ms or 0.0), 3),
                    "error": "",
                }
            )
            continue

        if event_name == "node_error":
            start_ts = start_map.pop(node_id, None) or ts
            error_text = str(payload.get("error", "")).strip()
            timeline_nodes.append(
                {
                    "node_id": node_id,
                    "class_type": class_type,
                    "status": "error",
                    "start_ts": start_ts,
                    "end_ts": ts,
                    "duration_ms": round(max(0.0, (ts - start_ts) * 1000.0), 3),
                    "error": error_text,
                }
            )

    timeline_nodes.sort(key=lambda x: float(x.get("start_ts", 0.0)))
    return {
        "run_id": str(run_row["run_id"] or ""),
        "trigger": str(run_row["trigger"] or ""),
        "schedule_id": str(run_row["schedule_id"] or ""),
        "status": str(run_row["status"] or ""),
        "error_code": str(run_row["error_code"] or ""),
        "error_message": str(run_row["error_message"] or ""),
        "started_at": float(run_row["started_at"] or 0.0),
        "ended_at": float(run_row["ended_at"] or 0.0),
        "elapsed_sec": float(run_row["elapsed_sec"] or 0.0),
        "nodes": timeline_nodes,
    }


def get_run_timeline_by_report_path(report_path: str) -> dict[str, Any] | None:
    path_text = str(report_path or "").strip()
    if not path_text:
        return None
    with _DB_LOCK:
        with _connect() as conn:
            row = conn.execute(
                "SELECT run_id FROM reports WHERE report_path = ? LIMIT 1",
                (path_text,),
            ).fetchone()
    if row is None:
        return None
    rid = str(row["run_id"] or "").strip()
    if not rid:
        return None
    return get_run_timeline(rid)


def _load_payload_json(payload_text: Any) -> dict[str, Any]:
    if not payload_text:
        return {}
    try:
        parsed = json.loads(str(payload_text))
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _require_db_path() -> Path:
    if _DB_PATH is None:
        raise RuntimeError("Database is not initialized. Call init_db() first.")
    return _DB_PATH


def _connect() -> sqlite3.Connection:
    db_path = _require_db_path()
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA busy_timeout=30000;")
    conn.row_factory = sqlite3.Row
    return conn
