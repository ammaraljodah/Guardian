import { CATEGORIES } from "./categories.js";
import {
  getSettings,
  toDomain,
  domainMatches,
  isTempAllowed
} from "./store.js";

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

  const settings = await getSettings();
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

async function enforce(tabId, url) {
  if (isOwnPage(url)) return; // never re-block our own blocked page
  const blockedDomain = await shouldBlock(url);
  if (blockedDomain) {
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

// Messages from the content script (proxy-page heuristics) and pages.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "PROXY_DETECTED" && sender.tab?.id != null) {
    (async () => {
      const settings = await getSettings();
      if (isPaused(settings)) return;
      if (!settings.categories?.proxies) return;
      const domain = toDomain(sender.tab.url);
      if (domain && domainMatches(domain, settings.allowlist || [])) return;
      if (domain && isTempAllowed(settings, domain)) return;
      const target = chrome.runtime.getURL(
        `blocked.html?site=${encodeURIComponent(domain || "proxy")}&reason=proxy`
      );
      chrome.tabs.update(sender.tab.id, { url: target });
    })();
  }
  return false;
});

// First install -> open setup so a parent can create a PIN.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  }
});
