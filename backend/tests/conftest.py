"""Pytest fixtures: isolated temp SQLite + TestClient."""

from __future__ import annotations

import os
import sys

import pytest
from fastapi.testclient import TestClient

# Ensure repo root is on path so `backend` imports resolve.
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("GUARDIAN_EXTENSION_TOKEN", "test-token")
os.environ.setdefault("GUARDIAN_SESSION_SECRET", "test-session-secret")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "guardian.db")
    monkeypatch.setenv("GUARDIAN_DB_PATH", db_path)
    monkeypatch.setenv("GUARDIAN_EXTENSION_TOKEN", "test-token")
    monkeypatch.setenv("GUARDIAN_SESSION_SECRET", "test-session-secret")

    from backend import config
    from backend import db as database

    config.DB_PATH = db_path
    config.EXTENSION_TOKEN = "test-token"
    config.SESSION_SECRET = "test-session-secret"
    database.set_db_path(db_path)

    from backend.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture()
def ext_headers():
    return {"X-Guardian-Token": "test-token"}


@pytest.fixture()
def authed_client(client):
    """Client with parent session after PIN setup."""
    r = client.post("/api/auth/setup", json={"pin": "1234", "confirm": "1234"})
    assert r.status_code == 200
    return client
