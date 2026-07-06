// Usage statistics: per-day, per-domain visit counts and time spent.
// Storage shape:  { "YYYY-MM-DD": { "domain.com": { visits, seconds } } }
import { CATEGORIES } from "./categories.js";
import { domainMatches } from "./store.js";
import * as db from "./db.js";
import { STORES } from "./db.js";

const STATS_KEY = "guardianStats";

/* ------------------------------ helpers -------------------------------- */

export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Human-friendly category labels + a stable color per category for charts.
export const CATEGORY_META = {
  social: { label: "Social Media", color: "#5b8def" },
  games: { label: "Games", color: "#7c5cff" },
  video: { label: "Video / Streaming", color: "#22c55e" },
  adult: { label: "Adult", color: "#ef4444" },
  gambling: { label: "Gambling", color: "#f59e0b" },
  proxies: { label: "Proxies", color: "#ec4899" },
  other: { label: "Other", color: "#64748b" }
};

export function categoryOf(domain) {
  for (const [id, cat] of Object.entries(CATEGORIES)) {
    if (domainMatches(domain, cat.domains)) return id;
  }
  return "other";
}

/* ------------------------------ storage -------------------------------- */

async function load() {
  const o = await chrome.storage.local.get(STATS_KEY);
  return o[STATS_KEY] || {};
}

async function save(stats) {
  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

function ensure(stats, day, domain) {
  stats[day] = stats[day] || {};
  stats[day][domain] = stats[day][domain] || { visits: 0, seconds: 0 };
  return stats[day][domain];
}

export async function recordVisit(domain) {
  if (!domain) return;
  const stats = await load();
  ensure(stats, dayKey(), domain).visits += 1;
  await save(stats);
}

export async function addTime(domain, seconds) {
  if (!domain || seconds <= 0) return;
  const stats = await load();
  ensure(stats, dayKey(), domain).seconds += seconds;
  await save(stats);
}

export async function clearStats() {
  await chrome.storage.local.set({ [STATS_KEY]: {} });
}

/* ---------------------------- aggregation ------------------------------ */

// days = number of days to include (1 = today), or null = all time.
export async function aggregate(days) {
  const stats = await load();
  let cutoff = null;
  if (days && days > 0) {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1));
    cutoff = dayKey(d);
  }

  const perDomain = {};
  for (const [day, domains] of Object.entries(stats)) {
    if (cutoff && day < cutoff) continue;
    for (const [domain, rec] of Object.entries(domains)) {
      perDomain[domain] = perDomain[domain] || { visits: 0, seconds: 0 };
      perDomain[domain].visits += rec.visits || 0;
      perDomain[domain].seconds += rec.seconds || 0;
    }
  }

  const sites = Object.entries(perDomain)
    .map(([domain, rec]) => ({
      domain,
      visits: rec.visits,
      seconds: rec.seconds,
      category: categoryOf(domain)
    }))
    .sort((a, b) => b.seconds - a.seconds || b.visits - a.visits);

  const byCategory = {};
  let totalSeconds = 0;
  let totalVisits = 0;
  for (const s of sites) {
    byCategory[s.category] = byCategory[s.category] || { seconds: 0, visits: 0 };
    byCategory[s.category].seconds += s.seconds;
    byCategory[s.category].visits += s.visits;
    totalSeconds += s.seconds;
    totalVisits += s.visits;
  }

  return { sites, byCategory, totalSeconds, totalVisits };
}

export function formatDuration(seconds) {
  seconds = Math.round(seconds);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/* ----------------------- Event logs (blocked/search) ------------------- */

export const KEY_BUCKET_MS = 3 * 60 * 1000;

// Timestamp for the start of the day `days-1` days ago (local). null = all time.
function cutoffTs(days) {
  if (!days || days <= 0) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

/* ----- one-time migration of legacy chrome.storage.local arrays ----- */

const LEGACY_KEYS = {
  [STORES.visit]: "guardianVisitLog",
  [STORES.search]: "guardianSearchLog",
  [STORES.key]: "guardianKeyLog",
  [STORES.blocked]: "guardianBlockedLog"
};
const MIGRATION_FLAG = "guardianLogsMigratedToIDB";

export async function migrateLegacyLogs() {
  const flag = await chrome.storage.local.get(MIGRATION_FLAG);
  if (flag[MIGRATION_FLAG]) return;

  const legacy = await chrome.storage.local.get(Object.values(LEGACY_KEYS));
  for (const [store, key] of Object.entries(LEGACY_KEYS)) {
    const arr = legacy[key];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    // Legacy arrays are newest-first; reverse so oldest gets the lowest id
    // and the ts index stays consistent with insertion order.
    const ordered = arr.slice().reverse();
    await db.bulkAdd(store, ordered);
  }
  await chrome.storage.local.set({ [MIGRATION_FLAG]: true });
  await chrome.storage.local.remove(Object.values(LEGACY_KEYS));
}

// Paged read: { entries, total } newest-first for the given day range.
export async function getLogPage(store, { days, offset = 0, limit = 500 }) {
  const cutoff = cutoffTs(days);
  const [entries, total] = await Promise.all([
    db.getPage(store, { cutoff, offset, limit }),
    db.count(store, cutoff)
  ]);
  return { entries, total };
}

function getAllLog(store, days) {
  return db.getAll(store, cutoffTs(days));
}

// Chronological "sites visited" history. Consecutive hits on the same domain
// are collapsed into one entry (so reloads / multi-page browsing on one site
// don't spam the list); we bump the newest entry's timestamp/count instead.
export async function recordVisitLog(domain, url) {
  if (!domain) return;
  const [last] = await db.getPage(STORES.visit, { offset: 0, limit: 1 });
  if (last && last.domain === domain) {
    last.ts = Date.now();
    last.count = (last.count || 1) + 1;
    await db.put(STORES.visit, last);
  } else {
    await db.add(STORES.visit, {
      ts: Date.now(),
      domain,
      category: categoryOf(domain),
      url: url || "",
      count: 1
    });
  }
}

export function getVisitLog(days) {
  return getAllLog(STORES.visit, days);
}

export function getVisitLogPage(opts) {
  return getLogPage(STORES.visit, opts);
}

export function clearVisitLog() {
  return db.clear(STORES.visit);
}

export async function recordBlocked(domain, reason, category) {
  if (!domain) return;
  await db.add(STORES.blocked, {
    ts: Date.now(),
    domain,
    category: category || categoryOf(domain),
    reason: reason || "blocked"
  });
}

export function getBlockedLog(days) {
  return getAllLog(STORES.blocked, days);
}

export function getBlockedLogPage(opts) {
  return getLogPage(STORES.blocked, opts);
}

export function clearBlockedLog() {
  return db.clear(STORES.blocked);
}

// Known search engines / sites: hostname fragment -> query param (+ optional
// path guard). Checked first so we use the correct param for popular sites.
const SEARCH_ENGINES = [
  { match: "google.", param: "q", path: "/search" },
  { match: "bing.com", param: "q" },
  { match: "duckduckgo.com", param: "q" },
  { match: "search.yahoo.com", param: "p" },
  { match: "youtube.com", param: "search_query", path: "/results" },
  { match: "ecosia.org", param: "q" },
  { match: "startpage.com", param: "query" },
  { match: "baidu.com", param: "wd" },
  { match: "yandex.", param: "text" },
  { match: "brave.com", param: "q" },
  { match: "search.marginalia.nu", param: "query" },
  { match: "qwant.com", param: "q" },
  { match: "wikipedia.org", param: "search" },
  { match: "reddit.com", param: "q" },
  { match: "amazon.", param: "k" },
  { match: "ebay.", param: "_nkw" },
  { match: "aliexpress.", param: "SearchText" },
  { match: "etsy.com", param: "q" },
  { match: "twitch.tv", param: "term" },
  { match: "tiktok.com", param: "q" },
  { match: "pinterest.", param: "q" },
  { match: "twitter.com", param: "q" },
  { match: "x.com", param: "q" },
  { match: "instagram.com", param: "q" },
  { match: "github.com", param: "q" },
  { match: "stackoverflow.com", param: "q" },
  { match: "netflix.com", param: "q" },
  { match: "spotify.com", param: "q" },
  { match: "imdb.com", param: "q" },
  { match: "play.google.com", param: "q" },
  { match: "apps.apple.com", param: "term" },
  { match: "yelp.com", param: "find_desc" },
  { match: "walmart.com", param: "q" },
  { match: "target.com", param: "searchTerm" }
];

// Generic query parameters used by site search boxes across the web. Checked
// as a fallback so in-site searches on unknown sites are still captured.
const GENERIC_PARAMS = [
  "q",
  "query",
  "search",
  "search_query",
  "searchterm",
  "search_term",
  "keyword",
  "keywords",
  "term",
  "text",
  "wd",
  "s"
];

export function extractSearch(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname;
    const engine = host.replace(/^www\./, "");

    // 1) Known sites (most reliable).
    for (const e of SEARCH_ENGINES) {
      if (!host.includes(e.match)) continue;
      if (e.path && !u.pathname.startsWith(e.path)) continue;
      const q = u.searchParams.get(e.param);
      if (q && q.trim()) return { engine, query: q.trim() };
    }

    // 2) Generic in-site search: first common param that carries a value.
    for (const p of GENERIC_PARAMS) {
      const q = u.searchParams.get(p);
      if (q) {
        const query = q.trim();
        // Guard against noise: reasonable length, not obviously an id/token.
        if (query.length >= 2 && query.length <= 200) {
          return { engine, query };
        }
      }
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

export async function recordSearch(engine, query) {
  if (!query) return;
  await db.add(STORES.search, { ts: Date.now(), engine, query });
}

export function getSearchLog(days) {
  return getAllLog(STORES.search, days);
}

export function getSearchLogPage(opts) {
  return getLogPage(STORES.search, opts);
}

export function clearSearchLog() {
  return db.clear(STORES.search);
}

const KEY_MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

function keyBucketStart(ts) {
  return Math.floor(ts / KEY_BUCKET_MS) * KEY_BUCKET_MS;
}

function applyKey(text, key) {
  if (KEY_MODIFIERS.has(key)) return text;
  if (key === "Backspace") return text.slice(0, -1);
  if (key === "Enter") return text + "\n";
  if (key === "Tab") return text + "\t";
  if (key === " ") return text + " ";
  if (key.length === 1) return text + key;
  return text;
}

export async function recordKeyPress({ downTs, upTs, key, domain }) {
  if (!domain || key == null) return;

  const bucket = keyBucketStart(downTs);
  const entry = await db.getKeyBucket(domain, bucket);

  if (entry) {
    const prev = entry.text || "";
    const next = applyKey(prev, key);
    if (next === prev) return;
    entry.text = next;
    entry.upTs = upTs;
    entry.count = (entry.count || 0) + 1;
    // Bump ts so this bucket sorts as the most recent activity.
    entry.ts = downTs;
    await db.put(STORES.key, entry);
  } else {
    const text = applyKey("", key);
    if (!text) return;
    await db.add(STORES.key, {
      ts: downTs,
      bucket,
      downTs,
      upTs,
      text,
      count: 1,
      domain,
      category: categoryOf(domain)
    });
  }
}

export function getKeyLog(days) {
  return getAllLog(STORES.key, days);
}

export function getKeyLogPage(opts) {
  return getLogPage(STORES.key, opts);
}

export function clearKeyLog() {
  return db.clear(STORES.key);
}
