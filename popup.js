import { CATEGORIES } from "./categories.js";
import {
  getSettings,
  toDomain,
  domainMatches,
  isTempAllowed
} from "./store.js";

const $ = (id) => document.getElementById(id);

function buildBlocklist(settings) {
  const set = new Set();
  for (const [id, enabled] of Object.entries(settings.categories || {})) {
    if (enabled && CATEGORIES[id]) CATEGORIES[id].domains.forEach((d) => set.add(d));
  }
  (settings.customBlocked || []).forEach((d) => set.add(d));
  return Array.from(set);
}

async function render() {
  const settings = await getSettings();
  const paused = settings.pausedUntil && Date.now() < settings.pausedUntil;

  const pill = $("statusPill");
  if (paused) {
    const mins = Math.ceil((settings.pausedUntil - Date.now()) / 60000);
    pill.textContent = `Paused (${mins}m)`;
    pill.className = "pill off";
  } else {
    pill.textContent = "Active";
    pill.className = "pill on";
  }

  const enabledCats = Object.values(settings.categories || {}).filter(Boolean)
    .length;
  $("catCount").textContent = enabledCats;
  $("customCount").textContent = (settings.customBlocked || []).length;

  // Status of the current tab.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const wrap = $("currentWrap");
  const domain = tab ? toDomain(tab.url) : null;
  if (!domain) {
    wrap.textContent = "";
  } else {
    const blocked =
      !paused &&
      !domainMatches(domain, settings.allowlist || []) &&
      !isTempAllowed(settings, domain) &&
      domainMatches(domain, buildBlocklist(settings));
    wrap.innerHTML = blocked
      ? `<b style="color:var(--danger)">${domain}</b> is blocked.`
      : `<b>${domain}</b> is allowed.`;
  }
}

$("manageBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

render();
