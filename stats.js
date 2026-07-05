// Usage statistics: per-day, per-domain visit counts and time spent.
// Storage shape:  { "YYYY-MM-DD": { "domain.com": { visits, seconds } } }
import { CATEGORIES } from "./categories.js";
import { domainMatches } from "./store.js";

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

const BLOCKED_KEY = "guardianBlockedLog";
const SEARCH_KEY = "guardianSearchLog";
const LOG_CAP = 1000;

// Timestamp for the start of the day `days-1` days ago (local). null = all time.
function cutoffTs(days) {
  if (!days || days <= 0) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

async function pushLog(key, entry) {
  const o = await chrome.storage.local.get(key);
  const log = o[key] || [];
  log.unshift(entry);
  if (log.length > LOG_CAP) log.length = LOG_CAP;
  await chrome.storage.local.set({ [key]: log });
}

async function readLog(key, days) {
  const o = await chrome.storage.local.get(key);
  const log = o[key] || [];
  const cutoff = cutoffTs(days);
  return cutoff ? log.filter((e) => e.ts >= cutoff) : log;
}

export async function recordBlocked(domain, reason) {
  if (!domain) return;
  await pushLog(BLOCKED_KEY, {
    ts: Date.now(),
    domain,
    category: categoryOf(domain),
    reason: reason || "blocked"
  });
}

export function getBlockedLog(days) {
  return readLog(BLOCKED_KEY, days);
}

export async function clearBlockedLog() {
  await chrome.storage.local.set({ [BLOCKED_KEY]: [] });
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
  await pushLog(SEARCH_KEY, { ts: Date.now(), engine, query });
}

export function getSearchLog(days) {
  return readLog(SEARCH_KEY, days);
}

export async function clearSearchLog() {
  await chrome.storage.local.set({ [SEARCH_KEY]: [] });
}
