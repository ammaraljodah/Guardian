"""Guardian backend configuration (env-overridable)."""

from __future__ import annotations

import os
import secrets


def _default_db_path() -> str:
    # Prefer the shared machine path used by deploy; fall back to a local file
    # under the backend package for developer machines (Windows / no /var).
    shared = os.environ.get("GUARDIAN_LOG_DIR", "/var/local/guardian-logs")
    candidate = os.path.join(shared, "guardian.db")
    if os.path.isdir(shared) or os.name != "nt":
        return os.environ.get("GUARDIAN_DB_PATH", candidate)
    local_dir = os.path.join(os.path.dirname(__file__), "data")
    return os.environ.get("GUARDIAN_DB_PATH", os.path.join(local_dir, "guardian.db"))


HOST = os.environ.get("GUARDIAN_HOST", "0.0.0.0")
PORT = int(os.environ.get("GUARDIAN_PORT", "8765"))
DB_PATH = _default_db_path()

# Shared secret the extension sends as X-Guardian-Token on every API call.
EXTENSION_TOKEN = os.environ.get(
    "GUARDIAN_EXTENSION_TOKEN", "dev-extension-token-change-me"
)

# Signs parent web session cookies.
SESSION_SECRET = os.environ.get("GUARDIAN_SESSION_SECRET") or secrets.token_hex(32)

# Cookie name for parent session after PIN login.
SESSION_COOKIE = "guardian_session"
SESSION_MAX_AGE = 60 * 60 * 12  # 12 hours

PBKDF2_ITERATIONS = 150_000
PBKDF2_DKLEN = 32

DISCORD_DOMAINS = ["discord.com", "discord.gg", "discordapp.com"]

CATEGORY_META = {
    "social": {"label": "Social Media", "color": "#5b8def", "domain_count": 17},
    "games": {"label": "Games", "color": "#7c5cff", "domain_count": 25},
    "video": {"label": "Video / Streaming", "color": "#22c55e", "domain_count": 12},
    "adult": {"label": "Adult / NSFW", "color": "#ef4444", "domain_count": 12},
    "gambling": {"label": "Gambling", "color": "#f59e0b", "domain_count": 11},
    "proxies": {
        "label": "Proxies / Anonymizers (bypass tools)",
        "color": "#ec4899",
        "domain_count": 30,
    },
    "other": {"label": "Other", "color": "#64748b", "domain_count": 0},
}
