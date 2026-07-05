// Shared storage + PIN crypto helpers used by the service worker and all pages.
import { CATEGORIES } from "./categories.js";

const KEY = "guardianSettings";

function defaultSettings() {
  const categories = {};
  for (const id of Object.keys(CATEGORIES)) {
    // Sensible defaults: adult, gambling and proxies blocked out of the box.
    categories[id] = id === "adult" || id === "gambling" || id === "proxies";
  }
  return {
    setup: false,
    pinHash: null,
    pinSalt: null,
    categories,
    customBlocked: [],
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

export async function getSettings() {
  const data = await chrome.storage.local.get(KEY);
  const stored = data[KEY] || {};
  const base = defaultSettings();
  // Merge so newly added categories appear for existing users.
  return {
    ...base,
    ...stored,
    categories: { ...base.categories, ...(stored.categories || {}) }
  };
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
