"""Machine-wide settings tests."""


def test_default_categories(client, ext_headers):
    s = client.get("/api/settings", headers=ext_headers).json()
    assert s["categories"]["adult"] is True
    assert s["categories"]["games"] is True
    assert s["categories"]["video"] is False
    assert "discord.com" in s["customBlocked"]
    assert "pinHash" not in s


def test_settings_shared_across_callers(authed_client, ext_headers):
    r = authed_client.put(
        "/api/settings",
        json={"categories": {"games": False, "video": True}},
    )
    assert r.status_code == 200
    assert r.json()["categories"]["games"] is False
    assert r.json()["categories"]["video"] is True

    # Extension (profile A)
    a = authed_client.get("/api/settings", headers=ext_headers).json()
    # Extension (profile B) — same token, separate request
    b = authed_client.get("/api/settings", headers=ext_headers).json()
    assert a["categories"] == b["categories"]
    assert a["categories"]["games"] is False


def test_pause_and_temp_allow(authed_client, ext_headers):
    r = authed_client.post("/api/pause", json={"minutes": 15, "resume": False})
    assert r.status_code == 200
    assert r.json()["pausedUntil"] > 0

    r = authed_client.post("/api/pause", json={"resume": True})
    assert r.json()["pausedUntil"] == 0

    r = authed_client.post(
        "/api/temp-allow",
        json={"domain": "example.com", "minutes": 15, "pin": "1234"},
        headers=ext_headers,
    )
    assert r.status_code == 200
    assert "example.com" in r.json()["tempAllow"]
    assert r.json()["tempAllow"]["example.com"] > 0

    r = authed_client.post(
        "/api/temp-allow",
        json={"domain": "evil.com", "minutes": 15, "pin": "bad"},
        headers=ext_headers,
    )
    assert r.status_code == 401
