"""SQLite persistence for settings, stats, and unified activity logs."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from . import config

STORES = ("visit", "search", "key", "blocked")

_local = threading.local()


def _ensure_dir(path: str) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)


def connect(db_path: Optional[str] = None) -> sqlite3.Connection:
    path = db_path or config.DB_PATH
    _ensure_dir(path)
    conn = sqlite3.connect(path, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=15000")
    init_schema(conn)
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    for store in STORES:
        conn.execute(
            f"""CREATE TABLE IF NOT EXISTS {store} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts INTEGER,
                    domain TEXT,
                    bucket INTEGER,
                    payload TEXT
                )"""
        )
        conn.execute(f"CREATE INDEX IF NOT EXISTS {store}_ts ON {store}(ts)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS key_domain_bucket ON key(domain, bucket)"
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL
            )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS stats (
                day TEXT NOT NULL,
                domain TEXT NOT NULL,
                visits INTEGER NOT NULL DEFAULT 0,
                seconds INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (day, domain)
            )"""
    )
    conn.commit()


def set_db_path(path: str) -> None:
    """Point subsequent connections at a different DB (used by tests)."""
    config.DB_PATH = path
    if getattr(_local, "conn", None) is not None:
        try:
            _local.conn.close()
        except Exception:
            pass
        _local.conn = None


@contextmanager
def get_conn(db_path: Optional[str] = None) -> Iterator[sqlite3.Connection]:
    path = db_path or config.DB_PATH
    conn = connect(path)
    try:
        yield conn
    finally:
        conn.close()


def default_settings() -> dict[str, Any]:
    categories = {
        "social": True,
        "games": True,
        "video": False,
        "adult": True,
        "gambling": True,
        "proxies": True,
    }
    return {
        "setup": False,
        "pinHash": None,
        "pinSalt": None,
        "categories": categories,
        "customBlocked": list(config.DISCORD_DOMAINS),
        "allowlist": [],
        "pausedUntil": 0,
        "tempAllow": {},
    }


def _ensure_discord(custom: list) -> list:
    out = list(custom or [])
    for d in config.DISCORD_DOMAINS:
        if d not in out:
            out.append(d)
    return out


def get_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute("SELECT payload FROM settings WHERE id = 1").fetchone()
    base = default_settings()
    if not row:
        return base
    stored = json.loads(row["payload"])
    merged = {**base, **stored}
    merged["categories"] = {
        **base["categories"],
        **(stored.get("categories") or {}),
    }
    merged["customBlocked"] = _ensure_discord(merged.get("customBlocked") or [])
    merged["allowlist"] = list(merged.get("allowlist") or [])
    merged["tempAllow"] = dict(merged.get("tempAllow") or {})
    return merged


def save_settings(conn: sqlite3.Connection, settings: dict[str, Any]) -> None:
    payload = dict(settings)
    payload["customBlocked"] = _ensure_discord(payload.get("customBlocked") or [])
    # Never expose managed flag from server unless we set it.
    conn.execute(
        "INSERT INTO settings (id, payload) VALUES (1, ?) "
        "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
        (json.dumps(payload),),
    )
    conn.commit()


def public_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Settings safe to return to clients (omit raw pin material from UI when not needed)."""
    out = dict(settings)
    # Extension needs to know setup; pin hashes stay server-side for verify.
    out.pop("pinHash", None)
    out.pop("pinSalt", None)
    return out


def row_to_record(row: sqlite3.Row) -> dict[str, Any]:
    rec = json.loads(row["payload"]) if row["payload"] else {}
    rec["id"] = row["id"]
    return rec


def valid_store(store: str) -> bool:
    return store in STORES


def do_add(conn: sqlite3.Connection, store: str, record: dict) -> dict:
    ts = record.get("ts", 0)
    domain = record.get("domain")
    bucket = record.get("bucket")
    cur = conn.execute(
        f"INSERT INTO {store} (ts, domain, bucket, payload) VALUES (?,?,?,?)",
        (ts, domain, bucket, json.dumps(record)),
    )
    conn.commit()
    return {"id": cur.lastrowid}


def do_put(conn: sqlite3.Connection, store: str, record: dict) -> dict:
    rid = record.get("id")
    if rid is None:
        return do_add(conn, store, record)
    ts = record.get("ts", 0)
    domain = record.get("domain")
    bucket = record.get("bucket")
    conn.execute(
        f"INSERT OR REPLACE INTO {store} (id, ts, domain, bucket, payload) "
        f"VALUES (?,?,?,?,?)",
        (rid, ts, domain, bucket, json.dumps(record)),
    )
    conn.commit()
    return {"id": rid}


def do_get_key_bucket(
    conn: sqlite3.Connection, domain: str, bucket: int
) -> dict:
    row = conn.execute(
        "SELECT * FROM key WHERE domain=? AND bucket=? LIMIT 1", (domain, bucket)
    ).fetchone()
    return {"record": row_to_record(row) if row else None}


def do_count(conn: sqlite3.Connection, store: str, cutoff) -> dict:
    if cutoff:
        row = conn.execute(
            f"SELECT COUNT(*) AS n FROM {store} WHERE ts >= ?", (cutoff,)
        ).fetchone()
    else:
        row = conn.execute(f"SELECT COUNT(*) AS n FROM {store}").fetchone()
    return {"count": row["n"]}


def do_get_page(
    conn: sqlite3.Connection, store: str, cutoff, offset: int, limit: int
) -> dict:
    if cutoff:
        rows = conn.execute(
            f"SELECT * FROM {store} WHERE ts >= ? ORDER BY ts DESC, id DESC "
            f"LIMIT ? OFFSET ?",
            (cutoff, limit, offset),
        ).fetchall()
    else:
        rows = conn.execute(
            f"SELECT * FROM {store} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return {"entries": [row_to_record(r) for r in rows]}


def do_get_all(conn: sqlite3.Connection, store: str, cutoff) -> dict:
    if cutoff:
        rows = conn.execute(
            f"SELECT * FROM {store} WHERE ts >= ? ORDER BY ts DESC, id DESC",
            (cutoff,),
        ).fetchall()
    else:
        rows = conn.execute(
            f"SELECT * FROM {store} ORDER BY ts DESC, id DESC"
        ).fetchall()
    return {"entries": [row_to_record(r) for r in rows]}


def do_clear(conn: sqlite3.Connection, store: str) -> dict:
    conn.execute(f"DELETE FROM {store}")
    conn.commit()
    return {"ok": True}


def do_bulk_add(conn: sqlite3.Connection, store: str, records: list) -> dict:
    for record in records or []:
        conn.execute(
            f"INSERT INTO {store} (ts, domain, bucket, payload) VALUES (?,?,?,?)",
            (
                record.get("ts", 0),
                record.get("domain"),
                record.get("bucket"),
                json.dumps(record),
            ),
        )
    conn.commit()
    return {"ok": True}


def record_visit_stat(conn: sqlite3.Connection, day: str, domain: str) -> None:
    conn.execute(
        """INSERT INTO stats (day, domain, visits, seconds) VALUES (?,?,1,0)
           ON CONFLICT(day, domain) DO UPDATE SET visits = visits + 1""",
        (day, domain),
    )
    conn.commit()


def add_time_stat(
    conn: sqlite3.Connection, day: str, domain: str, seconds: int
) -> None:
    if seconds <= 0:
        return
    conn.execute(
        """INSERT INTO stats (day, domain, visits, seconds) VALUES (?,?,0,?)
           ON CONFLICT(day, domain) DO UPDATE SET seconds = seconds + ?""",
        (day, domain, seconds, seconds),
    )
    conn.commit()


def clear_stats(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM stats")
    conn.commit()


def load_stats_blob(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return {day: {domain: {visits, seconds}}} for aggregation."""
    rows = conn.execute(
        "SELECT day, domain, visits, seconds FROM stats"
    ).fetchall()
    out: dict[str, Any] = {}
    for row in rows:
        out.setdefault(row["day"], {})[row["domain"]] = {
            "visits": row["visits"],
            "seconds": row["seconds"],
        }
    return out


def replace_stats_blob(conn: sqlite3.Connection, blob: dict) -> None:
    """Replace all stats from a nested blob (used by extension sync/merge)."""
    conn.execute("DELETE FROM stats")
    for day, domains in (blob or {}).items():
        for domain, rec in (domains or {}).items():
            conn.execute(
                "INSERT INTO stats (day, domain, visits, seconds) VALUES (?,?,?,?)",
                (
                    day,
                    domain,
                    int(rec.get("visits") or 0),
                    int(rec.get("seconds") or 0),
                ),
            )
    conn.commit()
