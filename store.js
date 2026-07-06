// Shared storage + PIN crypto helpers used by the service worker and all pages.
import { CATEGORIES } from "./categories.js";

const KEY = "guardianSettings";

const DISCORD_DOMAINS = ["discord.com", "discord.gg", "discordapp.com"];

function defaultSettings() {
  const categories = {};
  for (const id of Object.keys(CATEGORIES)) {
    // Sensible defaults: adult, gambling, proxies, social, and games blocked out of the box.
    categories[id] =
      id === "adult" ||
      id === "gambling" ||
      id === "proxies" ||
      id === "social" ||
      id === "games";
  }
  return {
    setup: false,
    pinHash: null,
    pinSalt: null,
    categories,
    customBlocked: [...DISCORD_DOMAINS],
    allowlist: [],
    // Epoch ms until which blocking is paused by the parent (0 = never).
    pausedUntil: 0,
    // Map of base-domain -> epoch ms expiry for temporary parent overrides.
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

// Admin-set configuration pushed through enterprise policy (chrome.storage.managed).
// It is identical for every Chrome profile on the machine and cannot be changed by
// the user, so using it as the source of truth stops each new profile from starting
// fresh and prompting for its own PIN.
async function getManaged() {
  try {
    if (!chrome.storage || !chrome.storage.managed) return {};
    return (await chrome.storage.managed.get(null)) || {};
  } catch (e) {
    return {};
  }
}

/** True when the PIN is fixed by the administrator via managed policy. */
export function isManagedPin(settings) {
  return !!(settings && settings.managed && settings.pinHash && settings.pinSalt);
}

export async function getSettings() {
  const data = await chrome.storage.local.get(KEY);
  const stored = data[KEY] || {};
  const managed = await getManaged();
  const base = defaultSettings();
  const customBlocked = [
    ...(managed.customBlocked || stored.customBlocked || base.customBlocked)
  ];
  for (const d of DISCORD_DOMAINS) {
    if (!customBlocked.includes(d)) customBlocked.push(d);
  }
  const merged = {
    ...base,
    ...stored,
    categories: {
      ...base.categories,
      ...(stored.categories || {}),
      ...(managed.categories || {})
    },
    customBlocked
  };
  if (Array.isArray(managed.allowlist)) merged.allowlist = managed.allowlist;
  // A managed PIN wins over anything a profile set locally, and marks setup as
  // done so no profile ever sees the "create a PIN" screen again.
  if (managed.pinHash && managed.pinSalt) {
    merged.pinHash = managed.pinHash;
    merged.pinSalt = managed.pinSalt;
    merged.setup = true;
    merged.managed = true;
  }
  return merged;
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ [KEY]: settings });
}

/* ----------------------------- PIN handling ----------------------------- */

function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function derive(pin, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bufToB64(bits);
}

export async function setPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt);
  const settings = await getSettings();
  settings.pinHash = hash;
  settings.pinSalt = bufToB64(salt);
  settings.setup = true;
  await saveSettings(settings);
}

export async function verifyPin(pin) {
  const settings = await getSettings();
  if (!settings.setup || !settings.pinHash || !settings.pinSalt) return false;
  const salt = b64ToBuf(settings.pinSalt);
  const hash = await derive(pin, salt);
  // Constant-time-ish comparison.
  if (hash.length !== settings.pinHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= hash.charCodeAt(i) ^ settings.pinHash.charCodeAt(i);
  }
  return diff === 0;
}

/* --------------------------- Domain matching ---------------------------- */

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
