import { CATEGORIES, DETECTION } from "./categories.js";
import {
  getSettings,
  syncSettingsFromServer,
  toDomain,
  domainMatches,
  isTempAllowed,
  API_BASE
} from "./store.js";
import {
  recordVisit,
  recordVisitLog,
  addTime,
  recordBlocked,
  recordSearch,
  extractSearch,
  recordKeyPress,
  migrateLegacyLogs
} from "./stats.js";
import { resetApiProbe } from "./db.js";

// Move any pre-IndexedDB logs into storage once, on service-worker boot.
migrateLegacyLogs().catch((e) =>
  console.error("[Guardian] log migration failed:", e)
);

// Keep a local mirror of machine-wide settings from the Python backend,
// then close any already-open (incl. pinned) tabs that are now blocked.
syncAndEnforce({ force: true }).catch(() => {});
chrome.alarms.create("settingsSync", { periodInMinutes: 1 });
chrome.alarms.create("apiProbe", { periodInMinutes: 1 });
// Faster poll so parent Block/Allow from the LAN dashboard applies quickly.
chrome.alarms.create("settingsSyncFast", { periodInMinutes: 0.1 });

function settingsSignature(s) {
  return JSON.stringify({
    categories: s.categories || {},
    customBlocked: s.customBlocked || [],
    allowlist: s.allowlist || [],
    pausedUntil: s.pausedUntil || 0,
    tempAllow: s.tempAllow || {}
  });
}

async function enforceAllOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id == null || !tab.url) continue;
      await enforce(tab.id, tab.url);
    }
  } catch (e) {
    console.warn("[Guardian] enforceAllOpenTabs failed:", e.message);
  }
}

async function syncAndEnforce({ force = false } = {}) {
  const before = settingsSignature(await getSettings());
  const next = await syncSettingsFromServer();
  const after = settingsSignature(next);
  // Always re-check open tabs when settings change, and on force (SW boot).
  // Pinned / already-open tabs never fire a new navigation, so they would
  // otherwise keep showing a blocked site until the next address-bar load.
  if (force || before !== after) await enforceAllOpenTabs();
  return next;
}

/** Build the effective set of blocked base-domains from settings. */
function buildBlocklist(settings) {
  const set = new Set();
  for (const [id, enabled] of Object.entries(settings.categories || {})) {
    if (enabled && CATEGORIES[id]) {
      for (const d of CATEGORIES[id].domains) set.add(d);
    }
  }
  for (const d of settings.customBlocked || []) {
    const norm = toDomain(d) || d.trim().toLowerCase();
    if (norm) set.add(norm);
  }
  return Array.from(set);
}

function isPaused(settings) {
  return settings.pausedUntil && Date.now() < settings.pausedUntil;
}

async function shouldBlock(url) {
  const domain = toDomain(url);
  if (!domain) return false;

  // Pull recent parent changes (Block/Allow/pause) before deciding.
  const settings = await getSettings({ fresh: true });
  if (isPaused(settings)) return false;

  // Allowlist and temporary parent overrides always win.
  if (domainMatches(domain, settings.allowlist || [])) return false;
  if (isTempAllowed(settings, domain)) return false;

  const blocklist = buildBlocklist(settings);
  return domainMatches(domain, blocklist) ? domain : false;
}

function isOwnPage(url) {
  return url && url.startsWith(chrome.runtime.getURL(""));
}

async function injectKeys(tabId, frameIds) {
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: frameIds
        ? { tabId, frameIds }
        : { tabId, allFrames: true },
      files: ["keys.js"]
    });
  } catch (e) {
    /* cross-origin or restricted frame */
  }
}

async function injectKeysAllFrames(tabId) {
  if (tabId == null) return;
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    for (const frame of frames) {
      await injectKeys(tabId, [frame.frameId]);
    }
  } catch (e) {
    /* tab gone */
  }
}

async function enforce(tabId, url) {
  if (isOwnPage(url)) return; // never re-block our own blocked page
  const blockedDomain = await shouldBlock(url);
  if (blockedDomain) {
    recordBlocked(blockedDomain, "blocked");
    const target = chrome.runtime.getURL(
      `blocked.html?site=${encodeURIComponent(blockedDomain)}`
    );
    chrome.tabs.update(tabId, { url: target });
  }
}

// Catch address-bar / link navigations before the page loads.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  enforce(d.tabId, d.url);
});

// Catch SPA / history navigations (e.g. youtube.com -> youtube.com/watch).
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  enforce(d.tabId, d.url);
});

// Count a "visit" whenever a real http/https page commits in the top frame.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  if (isOwnPage(d.url)) return;
  const domain = toDomain(d.url);
  if (domain) {
    recordVisit(domain);
    recordVisitLog(domain, d.url);
  }
  const search = extractSearch(d.url);
  if (search) recordSearch(search.engine, search.query);
});

// Editor iframes (e.g. TinyMCE javascript: iframes) may not get manifest content
// scripts; inject keys.js whenever a frame commits or the tab finishes loading.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (isOwnPage(d.url)) return;
  if (d.frameId === 0) return;
  injectKeys(d.tabId, [d.frameId]);
});

chrome.webNavigation.onCompleted.addListener((d) => {
  if (isOwnPage(d.url)) return;
  if (!d.url.startsWith("http")) return;
  injectKeysAllFrames(d.tabId);
});

/* ------------------------- Time-on-site tracking ------------------------ */
// We track how long the currently focused tab's domain stays active, pausing
// on idle / lost focus. The active session lives in chrome.storage.session so
// it survives service-worker suspension.
const SESSION_KEY = "guardianActiveSession";
const MAX_SESSION_SECONDS = 3600; // ignore absurd deltas (sleep, etc.)

async function getActiveDomain() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });
    if (!tab || !tab.url || isOwnPage(tab.url)) return null;
    return toDomain(tab.url);
  } catch (e) {
    return null;
  }
}

async function flushSession() {
  const o = await chrome.storage.session.get(SESSION_KEY);
  const s = o[SESSION_KEY];
  if (!s) return;
  const secs = Math.round((Date.now() - s.start) / 1000);
  if (secs > 0 && secs < MAX_SESSION_SECONDS) await addTime(s.domain, secs);
  await chrome.storage.session.remove(SESSION_KEY);
}

async function refreshSession() {
  await flushSession();
  const domain = await getActiveDomain();
  if (domain) {
    await chrome.storage.session.set({
      [SESSION_KEY]: { domain, start: Date.now() }
    });
  }
}

chrome.tabs.onActivated.addListener(async (info) => {
  refreshSession();
  // Switching to a pinned/already-open tab does not navigate — enforce now.
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (tab?.id != null && tab.url) await enforce(tab.id, tab.url);
  } catch (_) {
    /* tab gone */
  }
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.active && (info.url || info.status === "complete")) refreshSession();
  // Restored / discarded pinned tabs load without onBeforeNavigate in some cases.
  if ((info.status === "complete" || info.url) && tab?.url) {
    enforce(tabId, tab.url);
  }
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) flushSession();
  else refreshSession();
});
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
  if (state === "active") refreshSession();
  else flushSession();
});

// Periodic flush so ongoing time is persisted even without navigation events.
chrome.alarms.create("flushTick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "flushTick") refreshSession();
  if (
    a.name === "settingsSync" ||
    a.name === "settingsSyncFast" ||
    a.name === "apiProbe"
  ) {
    if (a.name === "apiProbe") resetApiProbe();
    syncAndEnforce().catch(() => {});
  }
});

// Messages from the content script (content-based category detection).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content script asks which categories to look for + their keywords.
  if (msg?.type === "GET_DETECTION_CONFIG") {
    (async () => {
      const settings = await getSettings();
      const categories = {};
      if (!isPaused(settings)) {
        for (const [id, cfg] of Object.entries(DETECTION)) {
          if (settings.categories?.[id]) categories[id] = cfg;
        }
      }
      sendResponse({ categories });
    })();
    return true; // async response
  }

  // Content script detected that this page's content matches a category.
  if (msg?.type === "CATEGORY_DETECTED" && sender.tab?.id != null) {
    (async () => {
      try {
        const settings = await getSettings();
        if (isPaused(settings)) return;
        const category = msg.category;
        if (!settings.categories?.[category]) return;

        const domain = toDomain(sender.tab.url);
        if (!domain) return;
        if (domainMatches(domain, settings.allowlist || [])) return;
        if (isTempAllowed(settings, domain)) return;

        const reason = category === "proxies" ? "proxy" : "content";
        await recordBlocked(domain, reason, category);
        const target = chrome.runtime.getURL(
          `blocked.html?site=${encodeURIComponent(domain)}&reason=${reason}` +
            `&cat=${encodeURIComponent(category)}`
        );
        await chrome.tabs.update(sender.tab.id, { url: target });
      } catch (e) {
        console.error("[Guardian] CATEGORY_DETECTED failed:", e);
      } finally {
        try {
          sendResponse({ ok: true });
        } catch (_) {
          /* channel closed */
        }
      }
    })();
    return true;
  }

  // Key press from keys.js — must return true so the service worker stays
  // awake long enough for the shared-API write (get bucket + put).
  if (msg?.type === "KEY_PRESS") {
    (async () => {
      try {
        const tabUrl = sender.tab?.url;
        if (!tabUrl || isOwnPage(tabUrl)) return;
        const domain = toDomain(tabUrl);
        if (!domain) return;
        await recordKeyPress({
          downTs: msg.downTs,
          upTs: msg.upTs,
          key: msg.key,
          domain
        });
      } catch (e) {
        console.error("[Guardian] KEY_PRESS failed:", e);
      } finally {
        try {
          sendResponse({ ok: true });
        } catch (_) {
          /* channel closed */
        }
      }
    })();
    return true;
  }
  return false;
});

// First install -> open parent dashboard (LAN) so a parent can create a PIN.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: API_BASE.replace(/\/$/, "") + "/" });
  }
  syncAndEnforce({ force: true }).catch(() => {});
});
