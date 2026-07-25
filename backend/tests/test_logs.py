"""Cross-profile log / stats unification tests."""


def test_two_profiles_logs_merge(client, ext_headers):
    # Simulate profile A
    r = client.post(
        "/api/logs/visit",
        headers=ext_headers,
        json={
            "record": {
                "ts": 1000,
                "domain": "a.example",
                "category": "other",
                "count": 1,
            }
        },
    )
    assert r.status_code == 200
    id_a = r.json()["id"]

    # Simulate profile B
    r = client.post(
        "/api/logs/visit",
        headers=ext_headers,
        json={
            "record": {
                "ts": 2000,
                "domain": "b.example",
                "category": "other",
                "count": 1,
            }
        },
    )
    assert r.status_code == 200
    id_b = r.json()["id"]
    assert id_a != id_b

    page = client.get(
        "/api/logs/visit",
        headers=ext_headers,
        params={"cmd": "getPage", "limit": 50},
    ).json()
    domains = {e["domain"] for e in page["entries"]}
    assert domains == {"a.example", "b.example"}

    count = client.get(
        "/api/logs/visit",
        headers=ext_headers,
        params={"cmd": "count"},
    ).json()
    assert count["count"] == 2


def test_pagination_and_cutoff(client, ext_headers):
    for i, ts in enumerate([100, 200, 300, 400, 500]):
        client.post(
            "/api/logs/blocked",
            headers=ext_headers,
            json={
                "record": {
                    "ts": ts,
                    "domain": f"d{i}.com",
                    "reason": "blocked",
                    "category": "other",
                }
            },
        )

    page = client.get(
        "/api/logs/blocked",
        headers=ext_headers,
        params={"cmd": "getPage", "cutoff": 300, "offset": 0, "limit": 2},
    ).json()
    assert len(page["entries"]) == 2
    assert page["entries"][0]["ts"] >= page["entries"][1]["ts"]

    count = client.get(
        "/api/logs/blocked",
        headers=ext_headers,
        params={"cmd": "count", "cutoff": 300},
    ).json()
    assert count["count"] == 3


def test_key_bucket_put(client, ext_headers):
    r = client.post(
        "/api/logs/key",
        headers=ext_headers,
        json={
            "record": {
                "ts": 1000,
                "domain": "site.com",
                "bucket": 900,
                "text": "hi",
                "count": 2,
            }
        },
    )
    rid = r.json()["id"]
    got = client.get(
        "/api/logs/key/bucket",
        headers=ext_headers,
        params={"domain": "site.com", "bucket": 900},
    ).json()
    assert got["record"]["text"] == "hi"
    assert got["record"]["id"] == rid

    client.put(
        "/api/logs/key",
        headers=ext_headers,
        json={
            "record": {
                "id": rid,
                "ts": 1100,
                "domain": "site.com",
                "bucket": 900,
                "text": "hello",
                "count": 5,
            }
        },
    )
    got = client.get(
        "/api/logs/key/bucket",
        headers=ext_headers,
        params={"domain": "site.com", "bucket": 900},
    ).json()
    assert got["record"]["text"] == "hello"


def test_stats_merge_and_clear(authed_client, ext_headers):
    authed_client.post(
        "/api/stats/inc",
        headers=ext_headers,
        json={"day": "2026-07-25", "domain": "a.com", "visits": 2, "seconds": 10},
    )
    authed_client.post(
        "/api/stats/inc",
        headers=ext_headers,
        json={"day": "2026-07-25", "domain": "b.com", "visits": 1, "seconds": 5},
    )
    agg = authed_client.get(
        "/api/stats", headers=ext_headers, params={"days": 0}
    ).json()
    # days=0 treated as None-ish — our API uses Optional; 0 is falsy so all time
    assert agg["totalVisits"] == 3
    assert agg["totalSeconds"] == 15
    assert len(agg["sites"]) == 2

    r = authed_client.delete("/api/stats")
    assert r.status_code == 200
    agg = authed_client.get("/api/stats", headers=ext_headers).json()
    assert agg["totalVisits"] == 0


def test_clear_logs_session(authed_client, ext_headers):
    authed_client.post(
        "/api/logs/search",
        headers=ext_headers,
        json={"record": {"ts": 1, "engine": "google.com", "query": "cats"}},
    )
    assert (
        authed_client.get(
            "/api/logs/search",
            headers=ext_headers,
            params={"cmd": "count"},
        ).json()["count"]
        == 1
    )
    r = authed_client.delete("/api/logs/search")
    assert r.status_code == 200
    assert (
        authed_client.get(
            "/api/logs/search",
            headers=ext_headers,
            params={"cmd": "count"},
        ).json()["count"]
        == 0
    )
