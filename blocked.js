import { verifyPin, getSettings, saveSettings, toDomain } from "./store.js";
import { CATEGORY_META } from "./stats.js";

const params = new URLSearchParams(location.search);
const site = params.get("site") || "this site";
const reason = params.get("reason");
const cat = params.get("cat");

document.getElementById("site").textContent = site;
const reasonEl = document.getElementById("reason");
if (reason === "proxy") {
  reasonEl.innerHTML =
    'This looks like a <b>proxy / unblocker</b> page, which is blocked by your parental controls.';
} else if (reason === "content") {
  const label = (CATEGORY_META[cat] || CATEGORY_META.other).label;
  reasonEl.innerHTML =
    `This page's content matches the blocked <b>${label}</b> category, so it was ` +
    "blocked by your parental controls.";
}

const form = document.getElementById("unlockForm");
const pinInput = document.getElementById("pin");
const errorEl = document.getElementById("error");

document.getElementById("openSettings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.textContent = "";
  const pin = pinInput.value.trim();
  if (!pin) return;

  const ok = await verifyPin(pin);
  if (!ok) {
    errorEl.textContent = "Incorrect PIN.";
    pinInput.value = "";
    return;
  }

  const settings = await getSettings();
  const base = toDomain(site) || site;
  settings.tempAllow = settings.tempAllow || {};
  settings.tempAllow[base] = Date.now() + 15 * 60 * 1000; // 15 minutes
  await saveSettings(settings);

  // Go to the site now that it's temporarily allowed.
  location.href = "https://" + base;
});
