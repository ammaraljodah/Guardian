# Guardian — Parental Site Blocker (Chrome, Manifest V3)

A PIN-protected parental control extension that blocks individual sites **and**
whole categories (social media, games, video, adult, gambling, proxies). All
settings and unblock requests are locked behind a parent PIN.

## Features

- **Category / theme blocking** — toggle entire groups on/off (Social Media,
  Games, Video/Streaming, Adult, Gambling, Proxies/Anonymizers). Blocking is
  **not limited to a fixed list**: in addition to curated domains, each enabled
  category is also detected from **page content** (title/meta/text keyword
  scoring, plus the adult RTA label), so new/unknown sites in a category are
  blocked too.
- **Custom block list** — block any specific domain.
- **Allow list** — carve out exceptions that are always permitted.
- **Parent PIN** — settings, the options page, and unblocking are all gated by a
PIN (PBKDF2-SHA256 hashed, never stored in plain text).
- **Temporary override** — from the block page a parent can unlock a site for 15
minutes with the PIN.
- **Pause** — parent can pause all blocking for 15 minutes.
- **Works behind VPNs/proxies** (see below) and detects many web-based proxy
"unblocker" pages heuristically.
- **Usage statistics** — per-site visit counts and time spent, grouped by
category, with a pie/donut chart and a duration selector (Today / 7 days /
30 days / All time). Time is tracked only for the active, non-idle tab.



## Install (developer / local)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`C:\git\chrome`).
4. A setup tab opens automatically — **create a parent PIN**. Protection is now
  active. Defaults block Adult, Gambling and Proxies; enable more categories in
   the parent settings.

To manage later: click the extension icon → **Parent settings**, or right-click
the icon → **Options**. You'll be asked for the PIN.

## How it blocks (and why VPN/proxy doesn't help the child)

The extension intercepts navigation **inside the browser** using the
`webNavigation` API and checks the site's hostname before the page loads. A
network VPN or proxy only changes how packets are routed on the network — the
browser still knows the real hostname it is navigating to (e.g.
`www.youtube.com`), and that is exactly what Guardian inspects. So:

- **Network VPN / system proxy → still blocked.** The hostname is unchanged.
- **Encrypted DNS / DoH → still blocked.** We match on the URL, not DNS.
- **Web-based proxies** (sites that load another site inside themselves, e.g.
  `croxyproxy.com`) are the real bypass. Guardian counters these two ways:
  1. A **Proxies / Anonymizers** category with many known proxy/VPN domains.
  2. Content detection (below) that flags pages resembling a web proxy.

### Content-based category detection (beyond the fixed list)

Domain lists can never cover every site. So for each **enabled** category, a
content script also scores the page's own title, meta tags and visible text
against a keyword set (and the adult **RTA** self-labelling tag). If a page
crosses the category's threshold, the tab is blocked with reason "Content
match" — even if the domain was never on any list. Detection only runs for
categories the parent has turned on, and respects the allow list, temporary
overrides and pause. Thresholds require multiple keyword hits to limit false
positives; you can always add specific sites to the allow list.



### Honest limitations

- No client-side extension can block **every** brand-new web proxy; keep the
Proxies category on and add new ones to the custom list as you find them.
- Guardian only controls the browser it's installed in. Other browsers, apps,
or a different user profile are not covered — for whole-device control, pair
it with OS-level parental controls (Windows Family Safety, etc.).
- **Incognito** disables extensions by default (see below) — a known bypass.

## Closing the Incognito bypass

By default Chrome does **not** run extensions in Incognito, so Guardian is
inactive there. Two ways to fix it:

**A. Allow the extension in Incognito (quick):** `chrome://extensions` →
Guardian → **Details** → enable **Allow in Incognito**. Blocking, detection and
stats then work in Incognito too. A user could toggle this back off unless the
extension is force-installed and locked (below).

**B. Disable Incognito entirely (recommended):** remove the escape hatch with a
Chrome policy so Incognito can't be used at all. `1` = Incognito disabled.
After applying, restart Chrome and confirm at `chrome://policy`; the
"New Incognito window" menu item disappears. Combine with the force-install
policy below for a tamper-resistant setup.

#### Windows

Option 1 — Registry (run as Administrator in an elevated Command Prompt):

```
reg add "HKLM\SOFTWARE\Policies\Google\Chrome" /v IncognitoModeAvailability /t REG_DWORD /d 1 /f
```

Or create the value manually with `regedit`:

```
HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome
  IncognitoModeAvailability  (DWORD) = 1
```

Option 2 — Group Policy (after installing Chrome ADMX templates):
`Computer Configuration → Administrative Templates → Google → Google Chrome`
→ **Incognito mode availability** → *Enabled* → set to **Incognito mode disabled**.

#### Ubuntu / Linux

Chrome reads JSON policy files from a managed-policies directory. Create one as
root (use `sudo`):

For **Google Chrome**:

```bash
sudo mkdir -p /etc/opt/chrome/policies/managed
echo '{ "IncognitoModeAvailability": 1 }' | sudo tee /etc/opt/chrome/policies/managed/parental.json
sudo chmod 644 /etc/opt/chrome/policies/managed/parental.json
```

For **Chromium** (if that's what's installed), use the Chromium path instead:

```bash
sudo mkdir -p /etc/chromium/policies/managed
echo '{ "IncognitoModeAvailability": 1 }' | sudo tee /etc/chromium/policies/managed/parental.json
sudo chmod 644 /etc/chromium/policies/managed/parental.json
```

Then fully quit and relaunch the browser and verify at `chrome://policy`
(or `chrome://policy` in Chromium). To keep the child from editing the file,
make sure it is root-owned and not writable by their user account.



## Preventing the child from disabling the extension

A regular extension **cannot** stop someone from turning it off at
`chrome://extensions` — Chrome forbids extensions from touching `chrome://`
pages, by design. The supported, tamper-proof way is a **Chrome enterprise
policy** that force-installs the extension. Force-installed extensions **cannot
be disabled or removed** by the user, and the toggle is greyed out.

### Windows (registry) — force install + lock

Because this is a locally-loaded extension, first give it a **stable ID** by
adding a `key` to `manifest.json` (generate one by packing the extension once
via **Pack extension** on `chrome://extensions`, which creates a `.pem`; or use
a known public key). Then, as Administrator, create these registry values and
restart Chrome:

```
# Force-install by ID + update URL (self-hosted or Web Store)
HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
  1 = "<EXTENSION_ID>;https://clients2.google.com/service/update2/crx"

# Optional: block Developer-mode sideloading & general lockdown
HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionSettings\<EXTENSION_ID>
  installation_mode = "force_installed"
  update_url        = "https://clients2.google.com/service/update2/crx"
```

Or via `ExtensionSettings` JSON policy:

```json
{
  "ExtensionSettings": {
    "<EXTENSION_ID>": {
      "installation_mode": "force_installed",
      "update_url": "https://clients2.google.com/service/update2/crx"
    }
  }
}
```

Verify at `chrome://policy`. Once applied, the extension shows
"Installed by your organization" and cannot be toggled off by the child.

> Force-install normally expects the extension to be hosted (Chrome Web Store or
> your own update server). For a purely local build you must either publish it
> (Web Store / private listing) or host a `.crx` + update manifest. The PIN lock
> still protects all settings in the meantime.



## Statistics

Open **Parent settings** (PIN required) → **Statistics** tab:

- **KPIs**: total time, total visits, distinct sites for the selected period.
- **Time by category**: donut chart + legend with per-category time and share.
- **Sites table**: every visited domain with its category, visit count and time.
- **Visit history**: a chronological, newest-first log of every site visited
  (timestamp, domain, category, hit count). Consecutive visits to the same
  domain are collapsed into one entry.
- **Search activity**: search terms captured from URLs — major engines (Google,
Bing, DuckDuckGo, YouTube, Yahoo, Ecosia, Startpage, Baidu, Yandex, Brave,
Qwant, Marginalia), popular sites (Wikipedia, Reddit, Amazon, eBay, Etsy,
TikTok, Pinterest, Twitch, GitHub, StackOverflow, IMDb, YouTube, app stores,
retailers, etc.), plus **generic in-site search** on any site via common
query params (`q`, `query`, `search`, `s`, …). All read from the URL's query
string — never from keystrokes or typed message content.
- **Blocked attempts**: a log of which blocked sites/proxy pages the child tried
to open, with timestamps.
- **Duration selector**: Today, Last 7 days, Last 30 days, All time.
- **Export CSV**: downloads a report (sites, searches, blocked attempts) for the
selected period.
- **Clear** wipes recorded history (stats, searches, blocked attempts).

How tracking works: visits are counted when a top-frame http/https page commits;  
time is accumulated only for the focused, active tab and pauses on idle (60s) or  
when the browser loses focus, so background tabs don't inflate numbers.

## Files


| File               | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| `manifest.json`    | MV3 manifest, permissions, entry points                      |
| `background.js`    | Service worker: navigation interception + blocking           |
| `content.js`       | Heuristic web-proxy page detector                            |
| `categories.js`    | Curated domain lists per category                            |
| `stats.js`         | Visit/time storage, categorization, aggregation, charts data |
| `store.js`         | Storage schema + PIN hashing + domain matching               |
| `options.html/.js` | PIN-locked parent dashboard                                  |
| `popup.html/.js`   | Status view + link to settings                               |
| `blocked.html/.js` | Block page with parent override                              |
| `styles.css`       | Shared UI styling                                            |




## Security notes

- PIN is stored only as a PBKDF2-SHA256 hash (150k iterations, random salt).
- Settings live in `chrome.storage.local`.
- This is a deterrent-grade control suitable for children, not a defense against
a determined technical adult with full OS access.

