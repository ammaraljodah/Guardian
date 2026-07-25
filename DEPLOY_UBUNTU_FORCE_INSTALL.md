# Force-installing Guardian on Ubuntu

Guardian uses Chrome **enterprise policy** (`ExtensionInstallForcelist`) so the
extension cannot be disabled, plus a **systemd Python backend** that stores
settings and logs for every Chrome profile in one SQLite database.

Parents open the dashboard from any device on the LAN:
`http://<pc-lan-ip>:8765`

## One-shot deploy

From the repo root (as root / with sudo):

```bash
# Point at your checkout if it isn't ~/Documents/Guardian
export SRC_DIR=/path/to/Guardian

sudo ./deploy-guardian.sh
```

The script will:

1. Derive a stable extension ID from `~/guardian.pem` (creates the key if needed)
2. Generate a shared `X-Guardian-Token` and write `extension/config.js`
3. Pack the CRX and force-install it via Chrome managed policy
4. Install `/opt/guardian` + `guardian.service` (FastAPI on `0.0.0.0:8765`)
5. Use shared DB path `/var/local/guardian-logs/guardian.db`
6. Remove any legacy native-messaging host (`com.guardian.logs`)
7. Restart Chrome so every profile picks up the extension

Optional: enter a parent PIN when prompted (or create it later in the web UI).

## Verify

```bash
systemctl status guardian.service
curl -s http://127.0.0.1:8765/api/health
# chrome://policy → Reload → ExtensionInstallForcelist OK
```

Dashboard: `http://127.0.0.1:8765` on the PC, or `http://<lan-ip>:8765` from a phone.

## Cross-profile logs

Every profile’s extension posts to the same local API. Visits, searches,
keystrokes, and blocked attempts appear in **one** parent dashboard.

## Dev / tests (not on the school machine)

```bash
cd backend
python -m pip install -r requirements.txt
python -m pytest tests -v
```

## Firewall note

Port `8765` must be reachable on the LAN for phone access. Restrict to your
local subnet if the PC is on a wider network.
