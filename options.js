import { CATEGORIES } from "./categories.js";
import {
  getSettings,
  saveSettings,
  setPin,
  verifyPin,
  toDomain
} from "./store.js";

const $ = (id) => document.getElementById(id);
const setupView = $("setupView");
const lockView = $("lockView");
const dashboard = $("dashboard");

function show(el) {
  [setupView, lockView, dashboard].forEach((v) => v.classList.add("hidden"));
  el.classList.remove("hidden");
}

/* ------------------------------ Boot flow ------------------------------ */

async function boot() {
  const settings = await getSettings();
  if (!settings.setup) {
    show(setupView);
  } else {
    show(lockView);
    $("lockPin").focus();
  }
}

/* ---------------------------- Setup / lock ----------------------------- */

$("createPinBtn").addEventListener("click", async () => {
  const pin = $("newPin").value.trim();
  const confirm = $("confirmPin").value.trim();
  const err = $("setupError");
  err.textContent = "";
  if (pin.length < 4) {
    err.textContent = "PIN must be at least 4 characters.";
    return;
  }
  if (pin !== confirm) {
    err.textContent = "PINs do not match.";
    return;
  }
  await setPin(pin);
  await openDashboard();
});

$("unlockBtn").addEventListener("click", unlock);
$("lockPin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") unlock();
});

async function unlock() {
  const err = $("lockError");
  err.textContent = "";
  const pin = $("lockPin").value.trim();
  if (await verifyPin(pin)) {
    $("lockPin").value = "";
    await openDashboard();
  } else {
    err.textContent = "Incorrect PIN.";
    $("lockPin").value = "";
  }
}

/* ----------------------------- Dashboard ------------------------------- */

async function openDashboard() {
  show(dashboard);
  await render();
}

async function render() {
  const settings = await getSettings();
  renderStatus(settings);
  renderCategories(settings);
  renderList("blockList", settings.customBlocked, removeBlocked);
  renderList("allowList", settings.allowlist, removeAllowed);
}

function renderStatus(settings) {
  const paused = settings.pausedUntil && Date.now() < settings.pausedUntil;
  const pill = $("statusPill");
  if (paused) {
    const mins = Math.ceil((settings.pausedUntil - Date.now()) / 60000);
    pill.textContent = `Paused (${mins}m left)`;
    pill.className = "pill off";
    $("pauseBtn").classList.add("hidden");
    $("resumeBtn").classList.remove("hidden");
  } else {
    pill.textContent = "Active";
    pill.className = "pill on";
    $("pauseBtn").classList.remove("hidden");
    $("resumeBtn").classList.add("hidden");
  }
}

function renderCategories(settings) {
  const wrap = $("categories");
  wrap.innerHTML = "";
  for (const [id, cat] of Object.entries(CATEGORIES)) {
    const row = document.createElement("div");
    row.className = "cat";
    row.innerHTML = `
      <div class="meta">
        <div>${cat.label}</div>
        <small>${cat.domains.length} sites</small>
      </div>
      <label class="switch">
        <input type="checkbox" data-cat="${id}" ${
      settings.categories[id] ? "checked" : ""
    } />
        <span class="slider"></span>
      </label>`;
    wrap.appendChild(row);
  }
  wrap.querySelectorAll("input[data-cat]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const s = await getSettings();
      s.categories[cb.dataset.cat] = cb.checked;
      await saveSettings(s);
    });
  });
}

function renderList(containerId, items, onRemove) {
  const wrap = $(containerId);
  wrap.innerHTML = "";
  if (!items || items.length === 0) {
    wrap.innerHTML = `<p class="muted" style="margin:0">None yet.</p>`;
    return;
  }
  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "list-item";
    const span = document.createElement("span");
    span.textContent = item;
    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => onRemove(item));
    el.appendChild(span);
    el.appendChild(btn);
    wrap.appendChild(el);
  });
}

/* --------------------------- List mutations ---------------------------- */

$("addBlockBtn").addEventListener("click", async () => {
  const input = $("blockInput");
  const domain = toDomain(input.value) || input.value.trim().toLowerCase();
  if (!domain) return;
  const s = await getSettings();
  if (!s.customBlocked.includes(domain)) s.customBlocked.push(domain);
  await saveSettings(s);
  input.value = "";
  render();
});

$("addAllowBtn").addEventListener("click", async () => {
  const input = $("allowInput");
  const domain = toDomain(input.value) || input.value.trim().toLowerCase();
  if (!domain) return;
  const s = await getSettings();
  if (!s.allowlist.includes(domain)) s.allowlist.push(domain);
  await saveSettings(s);
  input.value = "";
  render();
});

async function removeBlocked(domain) {
  const s = await getSettings();
  s.customBlocked = s.customBlocked.filter((d) => d !== domain);
  await saveSettings(s);
  render();
}

async function removeAllowed(domain) {
  const s = await getSettings();
  s.allowlist = s.allowlist.filter((d) => d !== domain);
  await saveSettings(s);
  render();
}

/* ----------------------------- Pause/PIN ------------------------------- */

$("pauseBtn").addEventListener("click", async () => {
  const s = await getSettings();
  s.pausedUntil = Date.now() + 15 * 60 * 1000;
  await saveSettings(s);
  render();
});

$("resumeBtn").addEventListener("click", async () => {
  const s = await getSettings();
  s.pausedUntil = 0;
  await saveSettings(s);
  render();
});

$("changePinBtn").addEventListener("click", async () => {
  const msg = $("changeMsg");
  const pin = $("changePin").value.trim();
  if (pin.length < 4) {
    msg.textContent = "PIN must be at least 4 characters.";
    return;
  }
  await setPin(pin);
  $("changePin").value = "";
  msg.style.color = "var(--ok)";
  msg.textContent = "PIN updated.";
});

boot();
