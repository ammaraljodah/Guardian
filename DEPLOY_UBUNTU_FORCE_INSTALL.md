# Force-Installing Guardian on Ubuntu (All Users, Non-Removable)

Guardian is a **Manifest V3 Chrome/Chromium extension**. The only robust, tamper-proof
way to deploy it to every user on a Linux machine and stop them from disabling or
uninstalling it is through the browser's **enterprise managed policy**.

When an extension is delivered via `ExtensionInstallForcelist`:

- It is installed automatically for **every user profile** on the machine.
- The **Remove** and **Disable** buttons are greyed out in `chrome://extensions`.
- If a user tries to delete the files, the browser **re-installs it** on next launch.
- Users **cannot** turn it off, even in Developer Mode.

This is the same mechanism corporations and schools use, so it is fully supported and
survives browser updates.

---

## Overview of the steps

1. Pack the extension into a `.crx` with a **fixed key** (so the extension ID never changes).
2. Compute the **extension ID**.
3. Create an **update manifest** (`update.xml`).
4. **Host** the `.crx` + `update.xml` (local HTTP server or internal URL).
5. Drop a **managed policy JSON** into the browser's policy directory.
6. Restart the browser and verify.

> Do these as an admin (`sudo`). The policy files must be root-owned so users can't edit them.

---

## 0. Prerequisites

```bash
# You need Chrome OR Chromium installed. Check which one you have:
which google-chrome google-chrome-stable chromium chromium-browser
```

Note the binary name — you'll use it below. Examples:

- Google Chrome → `google-chrome` (or `google-chrome-stable`)
- Chromium (apt) → `chromium-browser`
- Chromium (snap) → `chromium`

> **Snap Chromium caveat:** the snap sandbox ignores `/etc/chromium/policies`.
> If you're on snap Chromium, either switch to the `.deb`/Chrome build, or see the
> snap note at the bottom. Google Chrome (`.deb`) is the most reliable target.

---

## 1. Pack the extension with a fixed key

Packing with your own key keeps the **extension ID stable** across every rebuild and
every machine. Generate the key **once** and reuse it everywhere.

```bash
# Generate a private key ONCE and keep it safe (do NOT ship it to users).
openssl genrsa 2048 > guardian.pem

# Pack the extension folder using that key.
# Replace the path with wherever your Guardian source folder is.
google-chrome --pack-extension="$HOME/Documents/Guardian" \
              --pack-extension-key="$HOME/guardian.pem"
```

This creates **`Guardian.crx`** next to the source folder.

> If you run this again later after editing the code, keep using the same
> `guardian.pem` so the ID stays the same.

---

## 2. Compute the extension ID

The ID is derived deterministically from the public key:

```bash
openssl rsa -in guardian.pem -pubout -outform DER 2>/dev/null \
  | sha256sum | head -c 32 | tr 0-9a-f a-p
```

This prints a 32-character ID like:

```
kjmaabcdefghijklmnopabcdefghijklmn
```

Save it — call it `<EXT_ID>` below.

---

## 3. Create the update manifest

Force-installed self-hosted extensions require an `update.xml` that points to the `.crx`.

Create `update.xml` (replace `<EXT_ID>` and the `codebase` URL):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="<EXT_ID>">
    <updatecheck codebase="http://127.0.0.1:8000/Guardian.crx" version="1.4.0" />
  </app>
</gupdate>
```

- `version` **must** match `"version"` in `manifest.json` (currently `1.4.0`).
  Bump both together whenever you release an update.
- `codebase` is the URL where the browser can download the `.crx`.

---

## 4. Host the .crx and update.xml

The browser fetches these at startup, so they must stay reachable.

### Option A — Simple local host (single machine / testing)

```bash
sudo mkdir -p /opt/guardian
sudo cp Guardian.crx update.xml /opt/guardian/
cd /opt/guardian
# Serve on localhost. For production, run this as a systemd service so it's always up.
python3 -m http.server 8000
```

Keep `codebase` as `http://127.0.0.1:8000/Guardian.crx` and set the update URL
(next step) to `http://127.0.0.1:8000/update.xml`.

To make the server permanent, create a systemd service:

```bash
sudo tee /etc/systemd/system/guardian-host.service >/dev/null <<'EOF'
[Unit]
Description=Guardian extension host
After=network.target

[Service]
ExecStart=/usr/bin/python3 -m http.server 8000
WorkingDirectory=/opt/guardian
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now guardian-host.service
```

### Option B — Internal web server (fleet deployment)

Host `Guardian.crx` and `update.xml` on an internal HTTP(S) server (nginx/Apache)
and set `codebase` / update URL to that address. This is best for many machines.

---

## 5. Install the managed policy

This is the step that actually forces the install and blocks removal.

Pick the directory for your browser:

| Browser | Policy directory |
|---|---|
| Google Chrome | `/etc/opt/chrome/policies/managed/` |
| Chromium (deb) | `/etc/chromium/policies/managed/` |
| Chromium (older) | `/etc/chromium-browser/policies/managed/` |

Create the directory and the policy file:

```bash
# For Google Chrome:
sudo mkdir -p /etc/opt/chrome/policies/managed

sudo tee /etc/opt/chrome/policies/managed/guardian.json >/dev/null <<'EOF'
{
  "ExtensionInstallForcelist": [
    "<EXT_ID>;http://127.0.0.1:8000/update.xml"
  ],
  "ExtensionInstallSources": [
    "http://127.0.0.1:8000/*"
  ],
  "ExtensionSettings": {
    "<EXT_ID>": {
      "installation_mode": "force_installed",
      "update_url": "http://127.0.0.1:8000/update.xml",
      "toolbar_pin": "force_pinned"
    }
  }
}
EOF
```

Replace **both** `<EXT_ID>` occurrences and the URLs.

- `ExtensionInstallForcelist` → forces install + blocks disable/remove.
- `ExtensionInstallSources` → allows the self-hosted `.crx` source.
- `ExtensionSettings` with `force_installed` → belt-and-suspenders lock and pins the
  toolbar icon so users can't hide it.

Lock down the files so users can't tamper with them:

```bash
sudo chown -R root:root /etc/opt/chrome/policies
sudo chmod -R 755 /etc/opt/chrome/policies
sudo chmod 644 /etc/opt/chrome/policies/managed/guardian.json
```

> For **Chromium**, use the matching directory from the table above; the JSON is identical.

---

## 6. Restart the browser and verify

```bash
# Fully quit Chrome/Chromium first, then reopen it.
```

1. Open `chrome://policy` → click **Reload policies**. You should see
   `ExtensionInstallForcelist` listed with your ID.
2. Open `chrome://extensions` → Guardian should be present, with **Remove** and the
   on/off toggle **greyed out** ("Installed by enterprise policy").

Guardian is now force-installed for **all users** on that machine and **cannot be
removed or disabled** through the browser.

---

## Updating Guardian later

1. Bump `"version"` in `manifest.json`.
2. Re-pack with the **same** `guardian.pem` (Step 1).
3. Update `version` in `update.xml` to match.
4. Replace `Guardian.crx` + `update.xml` on the host.
5. Browsers pick up the new version automatically within a few hours (or on restart).

---

## Fully offline alternative (no HTTP server)

If you can't run a server, use `file://` for the `codebase` and update URL. Copy the
files to a root-owned path and reference them directly:

```bash
sudo mkdir -p /opt/guardian
sudo cp Guardian.crx update.xml /opt/guardian/
```

`update.xml` codebase: `file:///opt/guardian/Guardian.crx`
Policy URLs: `file:///opt/guardian/update.xml` and source `file:///opt/guardian/*`

> `file://` works on most Linux Chrome/Chromium builds for forced self-hosted
> extensions but is less consistent than HTTP across versions — prefer the HTTP host
> if you hit "failed to install" errors in `chrome://extensions`.

---

## Snap Chromium note

Snap-packaged Chromium (Ubuntu's default) is sandboxed and **ignores**
`/etc/chromium/policies`. Options:

```bash
# Recommended: install Google Chrome .deb and target /etc/opt/chrome/policies.
# OR remove snap chromium and install the deb build:
sudo snap remove chromium
sudo apt install chromium-browser   # only if a non-snap deb is available on your release
```

Google Chrome (`.deb` from google.com) is the most predictable target for managed
policies on Ubuntu.

---

## Quick reference — what each piece does

| Piece | Purpose |
|---|---|
| `guardian.pem` | Fixed private key → stable extension ID. Keep secret. |
| `Guardian.crx` | Packed extension the browser installs. |
| `update.xml` | Tells the browser where/what version to fetch. |
| `guardian.json` policy | Forces install, blocks removal, pins the icon. |
| `chrome://policy` | Verify the policy loaded. |
| `chrome://extensions` | Confirm greyed-out Remove/Disable. |
