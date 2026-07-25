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
    response.set_cookie(
        key=config.SESSION_COOKIE,
        value=make_session_cookie(),
        httponly=True,
        samesite="lax",
        max_age=config.SESSION_MAX_AGE,
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
    with database.get_conn() as conn:
        settings = database.get_settings(conn)
    if not settings.get("setup") or not settings.get("pinHash"):
        return False
    return verify_pin_hash(pin, settings["pinHash"], settings["pinSalt"])
