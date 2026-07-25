# Guardian — Parental Site Blocker (Chrome + local Python backend)

PIN-protected parental controls: a **Chrome extension** blocks sites/categories in
the browser, and a **Python backend** on the same PC stores settings and activity
logs in one shared SQLite database. Parents manage everything from a **web
dashboard** reachable on the local network (`http://<pc-ip>:8765`).

## Architecture

| Piece | Role |
|--------|------|
| `extension/` | Chrome MV3 extension — blocking, content detection, posts logs |
| `backend/` | FastAPI + SQLite — settings, stats, unified logs, parent UI |
| Dashboard | Served by the backend; open from phone/PC on the same LAN |

Every Chrome profile on the machine talks to the same API, so visit/search/key/
blocked logs are **unified** (not trapped per profile).

## Features

- Category / theme blocking (social, games, video, adult, gambling, proxies)
- Content-based detection beyond fixed domain lists
- Custom block list + allow list
- Parent PIN (PBKDF2) on the backend — unlock, pause, settings
- Temporary 15-minute site override from the block page
- Usage stats + visit / search / keystroke / blocked logs
- Cross-profile log collection into one database

## Developer install

### 1. Backend

```bash
# from repo root
python -m pip install -r backend/requirements.txt
set GUARDIAN_EXTENSION_TOKEN=dev-extension-token-change-me
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8765
```

Open http://127.0.0.1:8765 and create a parent PIN.

### 2. Extension

1. Open `chrome://extensions` → Developer mode → **Load unpacked**
2. Select the `extension/` folder
3. Default `extension/config.js` uses `http://127.0.0.1:8765` and the
   `dev-extension-token-change-me` token (must match `GUARDIAN_EXTENSION_TOKEN`
   on the backend, or the backend default)

### 3. Tests

```bash
cd backend
python -m pytest tests -v
```

## Ubuntu force-install

```bash
sudo ./deploy-guardian.sh
```

This installs `guardian.service` (API on port 8765), packs/force-installs the
extension, and prints the LAN dashboard URL. See
[DEPLOY_UBUNTU_FORCE_INSTALL.md](DEPLOY_UBUNTU_FORCE_INSTALL.md).

## How blocking works

The extension uses `webNavigation` and content scripts inside Chrome. A VPN
does not hide the hostname from the browser. Web proxies are countered via the
Proxies category and content detection.

Honest limits: other browsers/apps are not covered; pair with OS parental
controls for whole-device lockdown.

## License

See [LICENSE](LICENSE).
