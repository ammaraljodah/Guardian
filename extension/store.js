// Settings cache + domain helpers. Machine-wide settings live on the Python
// backend; this module mirrors them into chrome.storage.local for fast blocking.
import { CATEGORIES } from "./categories.js";
import { API_BASE, EXTENSION_TOKEN } from "./config.js";

const KEY = "guardianSettings";

const DISCORD_DOMAINS = ["discord.com", "discord.gg", "discordapp.com"];

function defaultSettings() {
  const categories = {};
  for (const id of Object.keys(CATEGORIES)) {
    categories[id] =
      id === "adult" ||
      id === "gambling" ||
      id === "proxies" ||
      id === "social" ||
      id === "games";
  }
  return {
    setup: false,
    categories,
    customBlocked: [...DISCORD_DOMAINS],
    allowlist: [],
    pausedUntil: 0,
    tempAllow: {}
  };
}

/** True if `domain` (or a parent of it) has an unexpired temporary override. */
export function isTempAllowed(settings, domain) {
  const temp = settings.tempAllow || {};
  const now = Date.now();
  return Object.keys(temp).some(
    (d) => temp[d] > now && (domain === d || domain.endsWith("." + d))
  );
}

export function isManagedPin() {
  return false;
}

function ensureDiscord(customBlocked) {
  const list = [...(customBlocked || [])];
  for (const d of DISCORD_DOMAINS) {
    if (!list.includes(d)) list.push(d);
  }
  return list;
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Guardian-Token": EXTENSION_TOKEN,
      ...(opts.headers || {})
    }
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    throw new Error((data && data.detail) || res.statusText);
  }
  return data;
}

/** Pull machine-wide settings from the backend into the local cache. */
export async function syncSettingsFromServer() {
  try {
    const remote = await apiFetch("/api/settings");
    const merged = {
      ...defaultSettings(),
      ...remote,
      customBlocked: ensureDiscord(remote.customBlocked),
      categories: {
        ...defaultSettings().categories,
        ...(remote.categories || {})
      }
    };
    await chrome.storage.local.set({ [KEY]: merged });
    return merged;
  } catch (e) {
    console.warn("[Guardian] settings sync failed:", e.message);
    return getSettings();
  }
}

export async function getSettings() {
  const data = await chrome.storage.local.get(KEY);
  const stored = data[KEY] || {};
  const base = defaultSettings();
  return {
    ...base,
    ...stored,
    categories: {
      ...base.categories,
      ...(stored.categories || {})
    },
    customBlocked: ensureDiscord(
      stored.customBlocked || base.customBlocked
    ),
    allowlist: stored.allowlist || base.allowlist,
    tempAllow: stored.tempAllow || {}
  };
}

/** Local cache only — server remains source of truth for parent changes. */
export async function saveSettings(settings) {
  await chrome.storage.local.set({ [KEY]: settings });
}

export async function verifyPin(pin) {
  try {
    const resp = await apiFetch("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({ pin })
    });
    return !!resp.ok;
  } catch (e) {
    return false;
  }
}

export async function tempAllowDomain(domain, pin, minutes = 15) {
  const remote = await apiFetch("/api/temp-allow", {
    method: "POST",
    body: JSON.stringify({ domain, pin, minutes })
  });
  await saveSettings({
    ...(await getSettings()),
    ...remote,
    customBlocked: ensureDiscord(remote.customBlocked)
  });
  return remote;
}

export function toDomain(input) {
  if (!input) return null;
  let host = input;
  try {
    if (input.includes("://")) {
      const url = new URL(input);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      host = url.hostname;
    }
  } catch (e) {
    return null;
  }
  host = host.trim().toLowerCase().replace(/^www\./, "");
  return host || null;
}

export function domainMatches(domain, list) {
  if (!domain) return false;
  return list.some((b) => domain === b || domain.endsWith("." + b));
}

export { API_BASE };
