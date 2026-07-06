#!/usr/bin/env bash
#
# Guardian force-install deployer for Ubuntu (Google Chrome).
#
# Does everything in one shot:
#   1. Finds/derives the extension ID from guardian.pem (no hardcoding).
#   2. Packs the extension into a .crx if one isn't present.
#   3. Hosts the .crx + update.xml via file:// (no web server needed).
#   4. Writes a single clean force-install policy using the derived ID.
#   5. Removes stale/duplicate policy files and fixes the blocklist JSON.
#   6. Restarts Chrome.
#
# Usage:
#   sudo ./deploy-guardian.sh
#
# Optional overrides (env vars):
#   SRC_DIR   = extension source folder   (default: ~/Documents/Guardian)
#   PEM       = signing key path          (default: ~/guardian.pem)
#   HOST_DIR  = where the crx is hosted   (default: /var/local/guardian-extension)

set -euo pipefail

# --- Resolve the real (non-root) user's home even under sudo ---
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"

SRC_DIR="${SRC_DIR:-$REAL_HOME/Documents/Guardian}"
PEM="${PEM:-$REAL_HOME/guardian.pem}"
HOST_DIR="${HOST_DIR:-/var/local/guardian-extension}"
POLICY_DIR="/etc/opt/chrome/policies/managed"

echo "== Guardian deployer =="
echo "   user     : $REAL_USER"
echo "   source   : $SRC_DIR"
echo "   key      : $PEM"
echo "   host dir : $HOST_DIR"
echo

# --- Sanity checks ---
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run with sudo (sudo ./deploy-guardian.sh)" >&2
  exit 1
fi
if [[ ! -d "$SRC_DIR" ]]; then
  echo "ERROR: extension source folder not found: $SRC_DIR" >&2
  exit 1
fi

CHROME_BIN="$(command -v google-chrome || command -v google-chrome-stable || true)"
if [[ -z "$CHROME_BIN" ]]; then
  echo "ERROR: google-chrome not found in PATH" >&2
  exit 1
fi

# --- Ensure we have a signing key (generate once if missing) ---
if [[ ! -f "$PEM" ]]; then
  echo ">> No key at $PEM — generating a new one (keep it safe!)"
  openssl genrsa 2048 > "$PEM"
  chown "$REAL_USER":"$REAL_USER" "$PEM"
  chmod 600 "$PEM"
fi

# --- Derive the extension ID from the key (authoritative) ---
EXT_ID="$(openssl rsa -in "$PEM" -pubout -outform DER 2>/dev/null \
          | sha256sum | head -c 32 | tr 0-9a-f a-p)"
if [[ ${#EXT_ID} -ne 32 ]]; then
  echo "ERROR: failed to derive a 32-char extension ID from $PEM" >&2
  exit 1
fi
echo ">> Extension ID: $EXT_ID"

# --- Read the version from manifest.json (must match update.xml) ---
VERSION="$(grep -oP '"version"\s*:\s*"\K[0-9][0-9.]*' "$SRC_DIR/manifest.json" | head -1)"
VERSION="${VERSION:-1.0.0}"
echo ">> Extension version: $VERSION"

# --- Ask for a parent PIN and hash it (same PBKDF2 params as store.js) ---
# The hash+salt (never the PIN itself) go into managed storage, so every profile
# shares the same PIN and none of them show the "create a PIN" screen.
PIN_JSON=""
read -rsp "Set parent PIN (min 4 chars, leave blank to keep per-profile PINs): " PARENT_PIN
echo
if [[ -n "$PARENT_PIN" ]]; then
  if [[ ${#PARENT_PIN} -lt 4 ]]; then
    echo "ERROR: PIN must be at least 4 characters" >&2
    exit 1
  fi
  PIN_JSON="$(PARENT_PIN="$PARENT_PIN" python3 - <<'PY'
import os, hashlib, base64, json
pin = os.environ["PARENT_PIN"]
salt = os.urandom(16)
dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, 150000, dklen=32)
print(json.dumps({
    "pinHash": base64.b64encode(dk).decode(),
    "pinSalt": base64.b64encode(salt).decode(),
}))
PY
)"
  echo ">> PIN hashed for managed storage."
fi

# --- Pack the .crx (always repack so it matches current source + key) ---
CRX_SRC="${SRC_DIR%/}.crx"   # chrome writes <folder>.crx next to the folder
echo ">> Packing extension..."
# Run pack as the real user so output ownership is sane; ignore the crx-exists notice.
sudo -u "$REAL_USER" "$CHROME_BIN" \
     --pack-extension="$SRC_DIR" \
     --pack-extension-key="$PEM" >/dev/null 2>&1 || true
if [[ ! -f "$CRX_SRC" ]]; then
  echo "ERROR: packing failed, $CRX_SRC not created" >&2
  exit 1
fi
echo "   packed: $CRX_SRC"

# --- Host the crx + update.xml via file:// ---
echo ">> Setting up host dir: $HOST_DIR"
mkdir -p "$HOST_DIR"
cp -f "$CRX_SRC" "$HOST_DIR/Guardian.crx"

cat > "$HOST_DIR/update.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="$EXT_ID">
    <updatecheck codebase="file://$HOST_DIR/Guardian.crx" version="$VERSION" />
  </app>
</gupdate>
EOF

# --- Clean out any stale/duplicate Guardian policy files ---
echo ">> Writing policy in $POLICY_DIR"
mkdir -p "$POLICY_DIR"
rm -f "$POLICY_DIR/guardian_force.json" "$POLICY_DIR/guardian.json"

# Build the managed-storage (3rdparty) block only when a PIN was provided.
THIRDPARTY=""
if [[ -n "$PIN_JSON" ]]; then
  PIN_HASH="$(echo "$PIN_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["pinHash"])')"
  PIN_SALT="$(echo "$PIN_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["pinSalt"])')"
  THIRDPARTY=$(cat <<EOF
,
  "3rdparty": {
    "extensions": {
      "$EXT_ID": {
        "pinHash": "$PIN_HASH",
        "pinSalt": "$PIN_SALT",
        "lockSettings": true
      }
    }
  }
EOF
)
fi

cat > "$POLICY_DIR/guardian.json" <<EOF
{
  "ExtensionInstallForcelist": [
    "$EXT_ID;file://$HOST_DIR/update.xml"
  ],
  "ExtensionInstallSources": [
    "file:///*"
  ],
  "ExtensionSettings": {
    "$EXT_ID": {
      "installation_mode": "force_installed",
      "update_url": "file://$HOST_DIR/update.xml",
      "toolbar_pin": "force_pinned"
    }
  }$THIRDPARTY
}
EOF

# --- Fix the blocklist file (valid JSON; force-installed IDs are exempt) ---
cat > "$POLICY_DIR/blocked_extensions.json" <<'EOF'
{
  "ExtensionInstallBlocklist": ["*"],
  "URLBlocklist": [
    "https://chromewebstore.google.com/*"
  ]
}
EOF

# --- Lock permissions so users can't tamper ---
chown -R root:root /etc/opt/chrome/policies "$HOST_DIR"
chmod 644 "$POLICY_DIR"/*.json
chmod -R a+rX "$HOST_DIR"

echo
echo "== Done =="
echo "   Policy    : $POLICY_DIR/guardian.json"
echo "   Host      : $HOST_DIR (Guardian.crx + update.xml)"
echo "   Ext ID    : $EXT_ID"
echo
echo ">> Restarting Chrome..."
pkill -f chrome 2>/dev/null || true
sleep 2
sudo -u "$REAL_USER" nohup "$CHROME_BIN" >/dev/null 2>&1 &

echo
echo "Next: open chrome://policy -> Reload policies, and confirm"
echo "ExtensionInstallForcelist shows $EXT_ID with status OK."
