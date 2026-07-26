"""Auth / PIN / token tests."""

from backend import config


def test_setup_status_initial(client):
    r = client.get("/api/setup-status")
    assert r.status_code == 200
    assert r.json()["setup"] is False


def test_setup_and_login(client):
    r = client.post("/api/auth/setup", json={"pin": "1234", "confirm": "9999"})
    assert r.status_code == 400

    r = client.post("/api/auth/setup", json={"pin": "12", "confirm": "12"})
    assert r.status_code == 400

    r = client.post("/api/auth/setup", json={"pin": "1234", "confirm": "1234"})
    assert r.status_code == 200
    assert r.json()["setup"] is True
    assert client.cookies.get("guardian_session")

    r = client.get("/api/setup-status")
    assert r.json()["setup"] is True

    r = client.post("/api/auth/setup", json={"pin": "5678", "confirm": "5678"})
    assert r.status_code == 400

    client.cookies.clear()
    r = client.post("/api/auth/login", json={"pin": "wrong"})
    assert r.status_code == 401

    r = client.post("/api/auth/login", json={"pin": "1234"})
    assert r.status_code == 200
    assert client.cookies.get("guardian_session")


def test_extension_token_required(client, ext_headers):
    r = client.get("/api/settings")
    assert r.status_code == 401

    r = client.get("/api/settings", headers={"X-Guardian-Token": "bad"})
    assert r.status_code == 401

    r = client.get("/api/settings", headers=ext_headers)
    assert r.status_code == 200
    assert "categories" in r.json()


def test_verify_pin(authed_client, ext_headers):
    r = authed_client.post(
        "/api/auth/verify",
        json={"pin": "1234"},
        headers=ext_headers,
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True

    r = authed_client.post(
        "/api/auth/verify",
        json={"pin": "0000"},
        headers=ext_headers,
    )
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_pin_lockout_after_three_failures(client, ext_headers):
    assert (
        client.post(
            "/api/auth/setup", json={"pin": "1234", "confirm": "1234"}
        ).status_code
        == 200
    )
    client.cookies.clear()

    for _ in range(config.PIN_MAX_ATTEMPTS - 1):
        r = client.post("/api/auth/login", json={"pin": "bad"})
        assert r.status_code == 401

    r = client.post("/api/auth/login", json={"pin": "bad"})
    assert r.status_code == 429
    detail = r.json()["detail"]
    assert detail["error"] == "pin_locked"
    assert detail["lockedUntil"] > 0
    assert "Try again" in detail["message"]

    # Correct PIN still blocked during lockout.
    r = client.post("/api/auth/login", json={"pin": "1234"})
    assert r.status_code == 429

    # verify endpoint also respects lockout
    r = client.post(
        "/api/auth/verify",
        json={"pin": "1234"},
        headers=ext_headers,
    )
    assert r.status_code == 429


def test_successful_pin_resets_fail_count(client):
    assert (
        client.post(
            "/api/auth/setup", json={"pin": "1234", "confirm": "1234"}
        ).status_code
        == 200
    )
    client.cookies.clear()

    assert client.post("/api/auth/login", json={"pin": "x"}).status_code == 401
    assert client.post("/api/auth/login", json={"pin": "y"}).status_code == 401
    # Correct PIN clears the counter before lockout.
    assert client.post("/api/auth/login", json={"pin": "1234"}).status_code == 200
    client.cookies.clear()

    assert client.post("/api/auth/login", json={"pin": "x"}).status_code == 401
    assert client.post("/api/auth/login", json={"pin": "y"}).status_code == 401
    assert client.post("/api/auth/login", json={"pin": "1234"}).status_code == 200


def test_session_required_for_settings_write(client, ext_headers):
    r = client.put(
        "/api/settings",
        json={"categories": {"games": False}},
        headers=ext_headers,
    )
    assert r.status_code == 401
