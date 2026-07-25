"""Guardian FastAPI application: LAN parent dashboard + extension API."""

from __future__ import annotations

import os
from datetime import date, timedelta
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, config
from . import db as database

WEB_DIR = os.path.join(os.path.dirname(__file__), "web")

app = FastAPI(title="Guardian", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ----------------------------- models -----------------------------------


class PinBody(BaseModel):
    pin: str


class SetupBody(BaseModel):
    pin: str
    confirm: Optional[str] = None


class SettingsUpdate(BaseModel):
    categories: Optional[dict[str, bool]] = None
    customBlocked: Optional[list[str]] = None
    allowlist: Optional[list[str]] = None
    pausedUntil: Optional[int] = None
    tempAllow: Optional[dict[str, int]] = None
    pin: Optional[str] = None  # change PIN when provided


class PauseBody(BaseModel):
    minutes: int = 15
    resume: bool = False


class TempAllowBody(BaseModel):
    domain: str
    minutes: int = 15
    pin: Optional[str] = None


class LogRecordBody(BaseModel):
    record: dict[str, Any] = Field(default_factory=dict)


class BulkAddBody(BaseModel):
    records: list[dict[str, Any]] = Field(default_factory=list)


class StatsIncBody(BaseModel):
    day: Optional[str] = None
    domain: str
    visits: int = 0
    seconds: int = 0


class StatsReplaceBody(BaseModel):
    stats: dict[str, Any] = Field(default_factory=dict)


# ----------------------------- helpers ----------------------------------


def _day_key(d: Optional[date] = None) -> str:
    d = d or date.today()
    return d.isoformat()


def _category_of(domain: str) -> str:
    # Lightweight classification for aggregation labels; extension does real blocking.
    # Match on suffixes against known category labels only for display rollup.
    # Without embedding full domain lists, fall back to "other" unless already set.
    return "other"


def aggregate_stats(blob: dict, days: Optional[int]) -> dict:
    cutoff = None
    if days and days > 0:
        cutoff = (date.today() - timedelta(days=days - 1)).isoformat()

    per_domain: dict[str, dict] = {}
    for day, domains in (blob or {}).items():
        if cutoff and day < cutoff:
            continue
        for domain, rec in (domains or {}).items():
            slot = per_domain.setdefault(domain, {"visits": 0, "seconds": 0})
            slot["visits"] += int(rec.get("visits") or 0)
            slot["seconds"] += int(rec.get("seconds") or 0)

    sites = [
        {
            "domain": domain,
            "visits": rec["visits"],
            "seconds": rec["seconds"],
            "category": _category_of(domain),
        }
        for domain, rec in per_domain.items()
    ]
    sites.sort(key=lambda s: (-s["seconds"], -s["visits"]))

    by_category: dict[str, dict] = {}
    total_seconds = 0
    total_visits = 0
    for s in sites:
        cat = s["category"]
        by_category.setdefault(cat, {"seconds": 0, "visits": 0})
        by_category[cat]["seconds"] += s["seconds"]
        by_category[cat]["visits"] += s["visits"]
        total_seconds += s["seconds"]
        total_visits += s["visits"]

    return {
        "sites": sites,
        "byCategory": by_category,
        "totalSeconds": total_seconds,
        "totalVisits": total_visits,
    }


# ----------------------------- auth routes ------------------------------


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/setup-status")
def setup_status():
    with database.get_conn() as conn:
        settings = database.get_settings(conn)
    return {"setup": bool(settings.get("setup"))}


@app.get("/api/meta")
def meta():
    return {"categories": config.CATEGORY_META, "port": config.PORT}


@app.get("/api/auth/status")
def auth_status(
    who: str = Depends(auth.require_extension_or_session),
):
    with database.get_conn() as conn:
        settings = database.get_settings(conn)
    return {
        "ok": True,
        "actor": who,
        "setup": bool(settings.get("setup")),
        "authenticated": who == "session" or who == "extension",
    }


@app.post("/api/auth/setup")
def auth_setup(body: SetupBody, response: Response):
    pin = (body.pin or "").strip()
    if len(pin) < 4:
        raise HTTPException(400, "PIN must be at least 4 characters")
    if body.confirm is not None and body.confirm != pin:
        raise HTTPException(400, "PINs do not match")
    with database.get_conn() as conn:
        settings = database.get_settings(conn)
        if settings.get("setup"):
            raise HTTPException(400, "PIN already set")
        pin_hash, pin_salt = auth.hash_pin(pin)
        settings["pinHash"] = pin_hash
        settings["pinSalt"] = pin_salt
        settings["setup"] = True
        database.save_settings(conn, settings)
    auth.set_session(response)
    return {"ok": True, "setup": True}


@app.post("/api/auth/login")
def auth_login(body: PinBody, response: Response):
    pin = (body.pin or "").strip()
    if not auth.pin_matches_db(pin):
        raise HTTPException(401, "Incorrect PIN")
    auth.set_session(response)
    return {"ok": True}


@app.post("/api/auth/logout")
def auth_logout(response: Response):
    auth.clear_session(response)
    return {"ok": True}


@app.post("/api/auth/verify")
def auth_verify(
    body: PinBody,
    _: str = Depends(auth.require_extension_or_session),
):
    ok = auth.pin_matches_db((body.pin or "").strip())
    return {"ok": ok}


# ----------------------------- settings ---------------------------------


@app.get("/api/settings")
def get_settings(who: str = Depends(auth.require_extension_or_session)):
    with database.get_conn() as conn:
        settings = database.get_settings(conn)
    # Extension needs full block config; omit pin material always.
    out = database.public_settings(settings)
    out["setup"] = bool(settings.get("setup"))
    return out


@app.put("/api/settings")
def put_settings(
    body: SettingsUpdate,
    _: None = Depends(auth.require_session),
):
    with database.get_conn() as conn:
        settings = database.get_settings(conn)
        if body.categories is not None:
            settings["categories"] = {
                **settings.get("categories", {}),
                **body.categories,
            }
        if body.customBlocked is not None:
            settings["customBlocked"] = body.customBlocked
        if body.allowlist is not None:
            settings["allowlist"] = body.allowlist
        if body.pausedUntil is not None:
            settings["pausedUntil"] = body.pausedUntil
        if body.tempAllow is not None:
            settings["tempAllow"] = body.tempAllow
        if body.pin:
            pin = body.pin.strip()
            if len(pin) < 4:
                raise HTTPException(400, "PIN must be at least 4 characters")
            pin_hash, pin_salt = auth.hash_pin(pin)
            settings["pinHash"] = pin_hash
            settings["pinSalt"] = pin_salt
            settings["setup"] = True
        database.save_settings(conn, settings)
        return database.public_settings(settings)


@app.post("/api/pause")
def pause(
    body: PauseBody,
    _: None = Depends(auth.require_session),
):
    import time

    with database.get_conn() as conn:
        settings = database.get_settings(conn)
        if body.resume:
            settings["pausedUntil"] = 0
        else:
            settings["pausedUntil"] = int(
                time.time() * 1000 + body.minutes * 60 * 1000
            )
        database.save_settings(conn, settings)
        return database.public_settings(settings)


@app.post("/api/temp-allow")
def temp_allow(
    body: TempAllowBody,
    who: str = Depends(auth.require_extension_or_session),
):
    import time

    # From blocked page (extension), require PIN in body.
    if who == "extension":
        if not body.pin or not auth.pin_matches_db(body.pin.strip()):
            raise HTTPException(401, "Incorrect PIN")
    domain = (body.domain or "").strip().lower().lstrip(".")
    if domain.startswith("www."):
        domain = domain[4:]
    if not domain:
        raise HTTPException(400, "domain required")
    with database.get_conn() as conn:
        settings = database.get_settings(conn)
        temp = dict(settings.get("tempAllow") or {})
        temp[domain] = int(time.time() * 1000 + body.minutes * 60 * 1000)
        settings["tempAllow"] = temp
        database.save_settings(conn, settings)
        return database.public_settings(settings)


# ----------------------------- logs -------------------------------------


@app.get("/api/logs/key/bucket")
def key_bucket(
    domain: str,
    bucket: int,
    _: None = Depends(auth.require_extension),
):
    with database.get_conn() as conn:
        return database.do_get_key_bucket(conn, domain, bucket)


@app.post("/api/logs/{store}")
def logs_add(
    store: str,
    body: LogRecordBody,
    _: None = Depends(auth.require_extension),
):
    if not database.valid_store(store):
        raise HTTPException(400, f"invalid store: {store}")
    with database.get_conn() as conn:
        return database.do_add(conn, store, body.record)


@app.put("/api/logs/{store}")
def logs_put(
    store: str,
    body: LogRecordBody,
    _: None = Depends(auth.require_extension),
):
    if not database.valid_store(store):
        raise HTTPException(400, f"invalid store: {store}")
    with database.get_conn() as conn:
        return database.do_put(conn, store, body.record)


@app.get("/api/logs/{store}")
def logs_get(
    store: str,
    _: str = Depends(auth.require_extension_or_session),
    cmd: str = Query("getPage"),
    cutoff: Optional[int] = None,
    offset: int = 0,
    limit: int = 500,
    domain: Optional[str] = None,
    bucket: Optional[int] = None,
):
    if store == "key" and cmd == "getKeyBucket":
        with database.get_conn() as conn:
            return database.do_get_key_bucket(conn, domain or "", bucket or 0)

    if not database.valid_store(store):
        raise HTTPException(400, f"invalid store: {store}")

    with database.get_conn() as conn:
        if cmd == "count":
            return database.do_count(conn, store, cutoff)
        if cmd == "getAll":
            return database.do_get_all(conn, store, cutoff)
        if cmd == "getPage":
            return database.do_get_page(conn, store, cutoff, offset, limit)
        raise HTTPException(400, f"unknown cmd: {cmd}")


@app.delete("/api/logs/{store}")
def logs_clear(
    store: str,
    _: None = Depends(auth.require_session),
):
    if not database.valid_store(store):
        raise HTTPException(400, f"invalid store: {store}")
    with database.get_conn() as conn:
        return database.do_clear(conn, store)


@app.post("/api/logs/{store}/bulk")
def logs_bulk(
    store: str,
    body: BulkAddBody,
    _: None = Depends(auth.require_extension),
):
    if not database.valid_store(store):
        raise HTTPException(400, f"invalid store: {store}")
    with database.get_conn() as conn:
        return database.do_bulk_add(conn, store, body.records)


# ----------------------------- stats ------------------------------------


@app.get("/api/stats")
def get_stats(
    days: Optional[int] = None,
    _: str = Depends(auth.require_extension_or_session),
):
    with database.get_conn() as conn:
        blob = database.load_stats_blob(conn)
    return aggregate_stats(blob, days)


@app.get("/api/stats/raw")
def get_stats_raw(_: None = Depends(auth.require_extension)):
    with database.get_conn() as conn:
        return database.load_stats_blob(conn)


@app.post("/api/stats/inc")
def stats_inc(
    body: StatsIncBody,
    _: None = Depends(auth.require_extension),
):
    day = body.day or _day_key()
    with database.get_conn() as conn:
        if body.visits:
            for _ in range(body.visits):
                database.record_visit_stat(conn, day, body.domain)
        if body.seconds:
            database.add_time_stat(conn, day, body.domain, body.seconds)
    return {"ok": True}


@app.put("/api/stats")
def stats_replace(
    body: StatsReplaceBody,
    _: None = Depends(auth.require_extension),
):
    with database.get_conn() as conn:
        database.replace_stats_blob(conn, body.stats)
    return {"ok": True}


@app.delete("/api/stats")
def stats_clear(_: None = Depends(auth.require_session)):
    with database.get_conn() as conn:
        database.clear_stats(conn)
    return {"ok": True}


# ----------------------------- static web -------------------------------

if os.path.isdir(WEB_DIR):
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/")
def index():
    index_path = os.path.join(WEB_DIR, "index.html")
    if not os.path.isfile(index_path):
        raise HTTPException(404, "dashboard not found")
    return FileResponse(index_path)


def create_app() -> FastAPI:
    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
    )
