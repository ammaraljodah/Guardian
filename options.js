import { CATEGORIES } from "./categories.js";
import {
  getSettings,
  saveSettings,
  setPin,
  verifyPin,
  toDomain
} from "./store.js";
import {
  aggregate,
  clearStats,
  formatDuration,
  CATEGORY_META,
  getSearchLog,
  getBlockedLog,
  clearSearchLog,
  clearBlockedLog
} from "./stats.js";

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
  await renderStats();
}

/* ------------------------------- Tabs ---------------------------------- */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $("statsTab").classList.toggle("hidden", tab !== "stats");
    $("controlsTab").classList.toggle("hidden", tab !== "controls");
    if (tab === "stats") renderStats();
  });
});

/* ---------------------------- Statistics ------------------------------- */

$("rangeSelect").addEventListener("change", renderStats);

$("clearStatsBtn").addEventListener("click", async () => {
  if (
    confirm(
      "Clear all recorded statistics, searches and blocked attempts? This cannot be undone."
    )
  ) {
    await Promise.all([clearStats(), clearSearchLog(), clearBlockedLog()]);
    renderStats();
  }
});

$("exportBtn").addEventListener("click", exportCsv);

function currentDays() {
  const days = parseInt($("rangeSelect").value, 10);
  return days === 0 ? null : days;
}

async function renderStats() {
  try {
    const days = currentDays();
    const { sites, byCategory, totalSeconds, totalVisits } = await aggregate(
      days
    );

    $("kpiTime").textContent = formatDuration(totalSeconds);
    $("kpiVisits").textContent = totalVisits;
    $("kpiSites").textContent = sites.length;

    renderDonut(byCategory, totalSeconds);
    renderLegend(byCategory, totalSeconds);
    renderSites(sites);

    renderSearchLog(await getSearchLog(days));
    renderBlockedLog(await getBlockedLog(days));
  } catch (err) {
    console.error("[Guardian] renderStats failed:", err);
    const empty = $("statsEmpty");
    if (empty) {
      empty.style.display = "block";
      empty.textContent = "Could not load statistics: " + err.message;
    }
  }
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderSearchLog(entries) {
  const body = $("searchBody");
  body.innerHTML = "";
  $("searchEmpty").style.display = entries.length ? "none" : "block";
  for (const e of entries.slice(0, 300)) {
    const tr = document.createElement("tr");
    const q = document.createElement("td");
    q.textContent = e.query; // textContent avoids HTML injection
    tr.innerHTML = `<td class="muted">${fmtTime(e.ts)}</td><td>${e.engine}</td>`;
    tr.appendChild(q);
    body.appendChild(tr);
  }
}

function reasonLabel(reason) {
  if (reason === "proxy") return "Proxy page";
  if (reason === "content") return "Content match";
  return "Blocked site";
}

function renderBlockedLog(entries) {
  const body = $("blockedBody");
  body.innerHTML = "";
  $("blockedEmpty").style.display = entries.length ? "none" : "block";
  for (const e of entries.slice(0, 300)) {
    const meta = CATEGORY_META[e.category] || CATEGORY_META.other;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="muted">${fmtTime(e.ts)}</td>
      <td>${e.domain}</td>
      <td><span class="badge" style="background:${meta.color}">${meta.label}</span></td>
      <td class="muted">${reasonLabel(e.reason)}</td>`;
    body.appendChild(tr);
  }
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCsv() {
  const days = currentDays();
  const { sites } = await aggregate(days);
  const searches = await getSearchLog(days);
  const blocked = await getBlockedLog(days);

  const lines = [];
  lines.push("SITES");
  lines.push(["domain", "category", "visits", "seconds"].join(","));
  for (const s of sites) {
    lines.push([s.domain, s.category, s.visits, s.seconds].map(csvCell).join(","));
  }
  lines.push("");
  lines.push("SEARCHES");
  lines.push(["timestamp", "engine", "query"].join(","));
  for (const e of searches) {
    lines.push(
      [new Date(e.ts).toISOString(), e.engine, e.query].map(csvCell).join(",")
    );
  }
  lines.push("");
  lines.push("BLOCKED_ATTEMPTS");
  lines.push(["timestamp", "domain", "category", "reason"].join(","));
  for (const e of blocked) {
    lines.push(
      [new Date(e.ts).toISOString(), e.domain, e.category, e.reason]
        .map(csvCell)
        .join(",")
    );
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const label = days ? `${days}d` : "all";
  a.href = url;
  a.download = `guardian-report-${label}-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderDonut(byCategory, totalSeconds) {
  const donut = $("donut");
  const center = $("donutCenter");
  const entries = Object.entries(byCategory)
    .filter(([, v]) => v.seconds > 0)
    .sort((a, b) => b[1].seconds - a[1].seconds);

  if (totalSeconds <= 0 || entries.length === 0) {
    donut.style.background = "#33406b";
    center.textContent = "No data";
    return;
  }

  let acc = 0;
  const segments = entries.map(([cat, v]) => {
    const start = (acc / totalSeconds) * 360;
    acc += v.seconds;
    const end = (acc / totalSeconds) * 360;
    const color = (CATEGORY_META[cat] || CATEGORY_META.other).color;
    return `${color} ${start}deg ${end}deg`;
  });
  donut.style.background = `conic-gradient(${segments.join(", ")})`;
  center.textContent = formatDuration(totalSeconds);
}

function renderLegend(byCategory, totalSeconds) {
  const legend = $("legend");
  legend.innerHTML = "";
  const entries = Object.entries(byCategory).sort(
    (a, b) => b[1].seconds - a[1].seconds
  );
  if (entries.length === 0) {
    legend.innerHTML = `<span class="muted">Nothing tracked in this period.</span>`;
    return;
  }
  for (const [cat, v] of entries) {
    const meta = CATEGORY_META[cat] || CATEGORY_META.other;
    const pct = totalSeconds > 0 ? Math.round((v.seconds / totalSeconds) * 100) : 0;
    const li = document.createElement("div");
    li.className = "li";
    li.innerHTML = `
      <span class="dot" style="background:${meta.color}"></span>
      <span>${meta.label}</span>
      <span class="v">${formatDuration(v.seconds)} · ${pct}%</span>`;
    legend.appendChild(li);
  }
}

function renderSites(sites) {
  const body = $("sitesBody");
  const empty = $("statsEmpty");
  body.innerHTML = "";
  if (sites.length === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  for (const s of sites.slice(0, 100)) {
    const meta = CATEGORY_META[s.category] || CATEGORY_META.other;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.domain}</td>
      <td><span class="badge" style="background:${meta.color}">${meta.label}</span></td>
      <td class="num">${s.visits}</td>
      <td class="num">${formatDuration(s.seconds)}</td>`;
    body.appendChild(tr);
  }
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
