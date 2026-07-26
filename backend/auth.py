"""PIN hashing (PBKDF2) and session / extension-token auth."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any, Optional

from fastapi import Cookie, Header, HTTPException, Request, Response

from . import config
from . import db as database


def hash_pin(pin: str, salt: Optional[bytes] = None) -> tuple[str, str]:
    """Return (pinHash_b64, pinSalt_b64) matching the extension's store.js."""
    if salt is None:
        salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256",
        pin.encode("utf-8"),
        salt,
        config.PBKDF2_ITERATIONS,
        dklen=config.PBKDF2_DKLEN,
    )
    return (
        base64.b64encode(dk).decode("ascii"),
        base64.b64encode(salt).decode("ascii"),
    )


def verify_pin_hash(pin: str, pin_hash: str, pin_salt: str) -> bool:
    try:
        salt = base64.b64decode(pin_salt)
    except Exception:
        return False
    computed, _ = hash_pin(pin, salt)
    if len(computed) != len(pin_hash):
        return False
    return hmac.compare_digest(computed, pin_hash)


def _sign(payload: dict[str, Any]) -> str:
    body = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    sig = hmac.new(
        config.SESSION_SECRET.encode(), body.encode(), hashlib.sha256
    ).hexdigest()
    return f"{body}.{sig}"


def _unsign(token: str) -> Optional[dict[str, Any]]:
    try:
        body, sig = token.rsplit(".", 1)
    except ValueError:
        return None
    expected = hmac.new(
        config.SESSION_SECRET.encode(), body.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    pad = "=" * (-len(body) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(body + pad))
    except Exception:
        return None
    if data.get("exp", 0) < time.time():
        return None
    return data


def make_session_cookie() -> str:
    return _sign(
        {"auth": True, "exp": int(time.time()) + config.SESSION_MAX_AGE}
    )


def set_session(response: Response) -> None:
    # No Max-Age / Expires → browser session cookie (dropped when Chrome
    # fully quits). The web UI also clears this on every dashboard page load.
    response.set_cookie(
        key=config.SESSION_COOKIE,
        value=make_session_cookie(),
        httponly=True,
        samesite="lax",
        path="/",
    )


def clear_session(response: Response) -> None:
    response.delete_cookie(config.SESSION_COOKIE, path="/")


def has_valid_session(cookie: Optional[str]) -> bool:
    if not cookie:
        return False
    return _unsign(cookie) is not None


def extension_token_ok(token: Optional[str]) -> bool:
    if not token:
        return False
    return hmac.compare_digest(token, config.EXTENSION_TOKEN)


def require_extension_or_session(
    request: Request,
    x_guardian_token: Optional[str] = Header(None, alias="X-Guardian-Token"),
    guardian_session: Optional[str] = Cookie(
        None, alias=config.SESSION_COOKIE
    ),
) -> str:
    """Allow either the shared extension token or a parent web session."""
    if extension_token_ok(x_guardian_token):
        return "extension"
    if has_valid_session(guardian_session):
        return "session"
    raise HTTPException(status_code=401, detail="unauthorized")


def require_session(
    guardian_session: Optional[str] = Cookie(
        None, alias=config.SESSION_COOKIE
    ),
) -> None:
    if not has_valid_session(guardian_session):
        raise HTTPException(status_code=401, detail="session required")


def require_extension(
    x_guardian_token: Optional[str] = Header(None, alias="X-Guardian-Token"),
) -> None:
    if not extension_token_ok(x_guardian_token):
        raise HTTPException(status_code=401, detail="invalid extension token")


def pin_matches_db(pin: str) -> bool:
    """Raw hash check only — prefer check_pin() when enforcing lockout."""
    with database.get_conn() as conn:
        settings = database.get_settings(conn)
    if not settings.get("setup") or not settings.get("pinHash"):
        return False
    return verify_pin_hash(pin, settings["pinHash"], settings["pinSalt"])


def _now_ms() -> int:
    return int(time.time() * 1000)


def lockout_remaining_ms(settings: dict[str, Any]) -> int:
    until = int(settings.get("pinLockedUntil") or 0)
    return max(0, until - _now_ms())


def format_lockout_message(remaining_ms: int) -> str:
    secs = max(1, (remaining_ms + 999) // 1000)
    hours = secs // 3600
    mins = (secs % 3600) // 60
    if hours >= 1:
        if mins >= 1:
            return (
                f"Too many wrong PINs. Try again in {hours}h {mins}m."
            )
        return f"Too many wrong PINs. Try again in {hours} hour{'s' if hours != 1 else ''}."
    if mins >= 1:
        return f"Too many wrong PINs. Try again in {mins} minute{'s' if mins != 1 else ''}."
    return f"Too many wrong PINs. Try again in {secs} second{'s' if secs != 1 else ''}."


def lockout_http_detail(settings: dict[str, Any]) -> dict[str, Any]:
    remaining = lockout_remaining_ms(settings)
    return {
        "error": "pin_locked",
        "lockedUntil": int(settings.get("pinLockedUntil") or 0),
        "message": format_lockout_message(remaining),
    }


def _expire_lockout_if_needed(conn, settings: dict[str, Any]) -> dict[str, Any]:
    until = int(settings.get("pinLockedUntil") or 0)
    if until and until <= _now_ms():
        settings["pinLockedUntil"] = 0
        settings["pinFailCount"] = 0
        database.save_settings(conn, settings)
    return settings


def raise_if_pin_locked(settings: dict[str, Any]) -> None:
    if lockout_remaining_ms(settings) > 0:
        raise HTTPException(status_code=429, detail=lockout_http_detail(settings))


def _record_pin_failure(conn, settings: dict[str, Any]) -> None:
    """Increment fail count; lock for PIN_LOCKOUT_SECONDS after PIN_MAX_ATTEMPTS."""
    count = int(settings.get("pinFailCount") or 0) + 1
    settings["pinFailCount"] = count
    if count >= config.PIN_MAX_ATTEMPTS:
        settings["pinFailCount"] = 0
        settings["pinLockedUntil"] = _now_ms() + config.PIN_LOCKOUT_SECONDS * 1000
        database.save_settings(conn, settings)
        raise_if_pin_locked(settings)
    database.save_settings(conn, settings)


def _clear_pin_failures(conn, settings: dict[str, Any]) -> None:
    if settings.get("pinFailCount") or settings.get("pinLockedUntil"):
        settings["pinFailCount"] = 0
        settings["pinLockedUntil"] = 0
        database.save_settings(conn, settings)


def check_pin(pin: str) -> bool:
    """
    Verify PIN with shared lockout.

    Returns True on success (failures cleared).
    Returns False on wrong PIN (failure recorded).
    Raises HTTP 429 after 3 failures for 5 hours.
    """
    pin = (pin or "").strip()
    with database.get_conn() as conn:
        settings = database.get_settings(conn)
        _expire_lockout_if_needed(conn, settings)
        raise_if_pin_locked(settings)
        if not settings.get("setup") or not settings.get("pinHash"):
            return False
        if verify_pin_hash(pin, settings["pinHash"], settings["pinSalt"]):
            _clear_pin_failures(conn, settings)
            return True
        _record_pin_failure(conn, settings)
        return False


def require_pin(pin: str) -> None:
    """Like check_pin, but raises 401 on wrong PIN."""
    if not check_pin(pin):
        raise HTTPException(status_code=401, detail="Incorrect PIN")
