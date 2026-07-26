/**
 * Guardian parent dashboard — talks to the local FastAPI backend.
 * Unified view of settings + logs across all Chrome profiles on this PC.
 */
import { CATEGORIES } from "./categories.js";

const PAGE_SIZE = 500;
const logPage = { history: 0, search: 0, key: 0, blocked: 0 };
const KEY_BUCKET_MS = 3 * 60 * 1000;

const CATEGORY_META = {
  social: { label: "Social Media", color: "#5b8def" },
  games: { label: "Games", color: "#7c5cff" },
  video: { label: "Video / Streaming", color: "#22c55e" },
  adult: { label: "Adult", color: "#ef4444" },
  gambling: { label: "Gambling", color: "#f59e0b" },
  proxies: { label: "Proxies", color: "#ec4899" },
  other: { label: "Other", color: "#64748b" }
};

const $ = (id) => document.getElementById(id);
const setupView = $("setupView");
const lockView = $("lockView");
const dashboard = $("dashboard");

let toastTimer = null;
function ensureToast() {
  let el = document.getElementById("toast");
  if (el) return el;
  el = document.createElement("div");
  el.id = "toast";
  el.className = "toast";
  el.setAttribute("role", "status");
  document.body.appendChild(el);
  return el;
}

function showToast(message, { ok = true, sub = "" } = {}) {
  const el = ensureToast();
  el.className = `toast show ${ok ? "ok" : "err"}`;
  el.innerHTML = sub
    ? `${message}<span class="toast-sub">${sub}</span>`
    : message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function show(el) {
  [setupView, lockView, dashboard].forEach((v) => v.classList.add("hidden"));
  el.classList.remove("hidden");
  const lockBtn = $("lockBtn");
  if (lockBtn) lockBtn.classList.toggle("hidden", el !== dashboard);
}

async function lockDashboard() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (e) {
    /* ignore */
  }
  show(lockView);
  $("lockPin").value = "";
  $("lockPin").focus();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {})
    },
    ...opts
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    throw new Error(formatApiDetail(data, res.statusText));
  }
  return data;
}

function formatApiDetail(data, fallback) {
  const detail = data && (data.detail || data.error);
  if (!detail) return fallback || "Request failed";
  if (typeof detail === "string") return detail;
  if (detail.message) return detail.message;
  try {
    return JSON.stringify(detail);
  } catch (e) {
    return fallback || "Request failed";
  }
}

function domainMatches(domain, list) {
  if (!domain) return false;
  return (list || []).some((b) => domain === b || domain.endsWith("." + b));
}

function toDomain(input) {
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

function categoryOf(domain) {
  for (const [id, cat] of Object.entries(CATEGORIES)) {
    if (domainMatches(domain, cat.domains)) return id;
  }
  return "other";
}

function formatDuration(seconds) {
  seconds = Math.round(seconds);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function enrichStats(data) {
  const sites = (data.sites || []).map((s) => ({
    ...s,
    category: categoryOf(s.domain)
  }));
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

async function getSettings() {
  return api("/api/settings");
}

async function saveSettings(partial) {
  return api("/api/settings", { method: "PUT", body: JSON.stringify(partial) });
}

/* ------------------------------ Boot flow ------------------------------ */

async function boot() {
  try {
    const st = await fetch("/api/setup-status").then((r) => r.json());
    if (!st.setup) {
      show(setupView);
      return;
    }
  } catch (e) {
    document.body.innerHTML =
      "<p style='padding:2rem;font-family:sans-serif'>Guardian backend is not reachable. Start the backend service, then reload.</p>";
    return;
  }
  // Always require the PIN when opening the parent page — never unlock from
  // a leftover cookie after Chrome was closed and reopened.
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (e) {
    /* ignore */
  }
  show(lockView);
  $("lockPin").focus();
}

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
  try {
    await api("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ pin, confirm })
    });
    await openDashboard();
  } catch (e) {
    err.textContent = e.message;
  }
});

$("unlockBtn").addEventListener("click", unlock);
$("lockPin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") unlock();
});
$("lockBtn").addEventListener("click", lockDashboard);

async function unlock() {
  const err = $("lockError");
  err.textContent = "";
  const pin = $("lockPin").value.trim();
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ pin })
    });
    $("lockPin").value = "";
    await openDashboard();
  } catch (e) {
    const msg = (e && e.message) || "";
    err.textContent =
      msg && msg !== "Incorrect PIN"
        ? msg
        : "Incorrect PIN.";
    $("lockPin").value = "";
  }
}

async function openDashboard() {
  show(dashboard);
  await render();
  await renderStats();
}

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

$("rangeSelect").addEventListener("change", () => {
  resetLogPages();
  renderStats();
});

function resetLogPages() {
  logPage.history = 0;
  logPage.search = 0;
  logPage.key = 0;
  logPage.blocked = 0;
}

$("clearStatsBtn").addEventListener("click", async () => {
  if (
    !confirm(
      "Clear all recorded statistics, searches, keyboard activity and blocked attempts? This cannot be undone."
    )
  ) {
    return;
  }
  await Promise.all([
    api("/api/stats", { method: "DELETE" }),
    api("/api/logs/search", { method: "DELETE" }),
    api("/api/logs/blocked", { method: "DELETE" }),
    api("/api/logs/visit", { method: "DELETE" }),
    api("/api/logs/key", { method: "DELETE" })
  ]);
  resetLogPages();
  renderStats();
});

$("exportBtn").addEventListener("click", exportCsv);
$("unblockAllBtn").addEventListener("click", clearAllCustomBlocks);

function currentDays() {
  const days = parseInt($("rangeSelect").value, 10);
  return days === 0 ? null : days;
}

function cutoffTs(days) {
  if (!days || days <= 0) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

async function getLogPage(store, { days, offset = 0, limit = 500 }) {
  const cutoff = cutoffTs(days);
  const q = new URLSearchParams({ cmd: "getPage", offset, limit });
  if (cutoff) q.set("cutoff", String(cutoff));
  const countQ = new URLSearchParams({ cmd: "count" });
  if (cutoff) countQ.set("cutoff", String(cutoff));
  const [page, count] = await Promise.all([
    api(`/api/logs/${store}?${q}`),
    api(`/api/logs/${store}?${countQ}`)
  ]);
  return { entries: page.entries || [], total: count.count || 0 };
}

async function renderStats() {
  try {
    const days = currentDays();
    const q = days == null ? "" : `?days=${days}`;
    const raw = await api(`/api/stats${q}`);
    const { sites, byCategory, totalSeconds, totalVisits } = enrichStats(raw);

    $("kpiTime").textContent = formatDuration(totalSeconds);
    $("kpiVisits").textContent = String(totalVisits);
    $("kpiSites").textContent = String(sites.length);
    $("statsEmpty").style.display = sites.length ? "none" : "block";

    renderDonut(byCategory, totalSeconds);
    renderLegend(byCategory, totalSeconds);
    renderSites(sites);

    await Promise.all([
      renderHistoryPage(),
      renderSearchPage(),
      renderKeyPage(),
      renderBlockedPage()
    ]);
  } catch (err) {
    console.error("[Guardian] renderStats failed:", err);
  }
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch (e) {
    return String(ts);
  }
}

function fmtTimeSec(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch (e) {
    return String(ts);
  }
}

function fmtKeyBucket(entry) {
  const start = entry.bucket || entry.downTs || entry.ts;
  const end = (entry.upTs || start) + 1;
  return `${fmtTime(start)} – ${fmtTimeSec(end)}`;
}

function displayKeyText(entry) {
  return (entry.text || "").replace(/\n/g, "↵ ").replace(/\t/g, "→ ");
}

function renderPager(containerId, key, total, onChange) {
  const el = $(containerId);
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = logPage[key];
  if (total <= PAGE_SIZE) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "flex";
  el.innerHTML = `
    <button type="button" data-dir="-1" ${page <= 0 ? "disabled" : ""}>Prev</button>
    <span class="pager-info">Page ${page + 1} / ${pages} (${total})</span>
    <button type="button" data-dir="1" ${page + 1 >= pages ? "disabled" : ""}>Next</button>`;
  el.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      logPage[key] = Math.max(0, page + parseInt(btn.dataset.dir, 10));
      onChange();
    });
  });
}

async function renderHistoryPage() {
  const { entries, total } = await getLogPage("visit", {
    days: currentDays(),
    offset: logPage.history * PAGE_SIZE,
    limit: PAGE_SIZE
  });
  const settings = await getSettings();
  renderHistoryLog(entries, settings, total);
  renderPager("historyPager", "history", total, renderHistoryPage);
}

async function renderSearchPage() {
  const { entries, total } = await getLogPage("search", {
    days: currentDays(),
    offset: logPage.search * PAGE_SIZE,
    limit: PAGE_SIZE
  });
  renderSearchLog(entries, total);
  renderPager("searchPager", "search", total, renderSearchPage);
}

async function renderKeyPage() {
  const { entries, total } = await getLogPage("key", {
    days: currentDays(),
    offset: logPage.key * PAGE_SIZE,
    limit: PAGE_SIZE
  });
  renderKeyLog(entries, total);
  renderPager("keyPager", "key", total, renderKeyPage);
}

async function renderBlockedPage() {
  const { entries, total } = await getLogPage("blocked", {
    days: currentDays(),
    offset: logPage.blocked * PAGE_SIZE,
    limit: PAGE_SIZE
  });
  renderBlockedLog(entries, total);
  renderPager("blockedPager", "blocked", total, renderBlockedPage);
}

function renderHistoryLog(entries, settings, total = entries.length) {
  const body = $("historyBody");
  body.innerHTML = "";
  $("historyEmpty").style.display = total ? "none" : "block";
  for (const e of entries) {
    const meta = CATEGORY_META[e.category] || CATEGORY_META.other;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtTime(e.ts)}</td>
      <td>${e.domain}</td>
      <td><span class="badge" style="background:${meta.color}">${meta.label}</span></td>
      <td class="num">${e.count || 1}</td>
      <td class="history-actions">
        <button type="button" class="secondary" data-allow="${e.domain}">Allow</button>
        <button type="button" class="danger" data-block="${e.domain}">Block</button>
      </td>`;
    body.appendChild(tr);
  }
  body.querySelectorAll("[data-allow]").forEach((btn) => {
    btn.addEventListener("click", () => alwaysAllow(btn.dataset.allow, btn));
  });
  body.querySelectorAll("[data-block]").forEach((btn) => {
    btn.addEventListener("click", () => alwaysBlock(btn.dataset.block, btn));
  });
}

function renderSearchLog(entries, total = entries.length) {
  const body = $("searchBody");
  body.innerHTML = "";
  $("searchEmpty").style.display = total ? "none" : "block";
  for (const e of entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtTime(e.ts)}</td>
      <td>${e.engine || ""}</td>
      <td>${e.query || ""}</td>`;
    body.appendChild(tr);
  }
}

function renderKeyLog(entries, total = entries.length) {
  const body = $("keyBody");
  body.innerHTML = "";
  $("keyEmpty").style.display = total ? "none" : "block";
  for (const e of entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtKeyBucket(e)}</td>
      <td>${e.domain || ""}</td>
      <td class="num">${e.count || 0}</td>
      <td style="font-family:monospace;font-size:12px;white-space:pre-wrap">${displayKeyText(e)}</td>`;
    body.appendChild(tr);
  }
}

function reasonLabel(reason) {
  if (reason === "proxy") return "Proxy / unblocker";
  if (reason === "content") return "Content match";
  return "Blocked";
}

function renderBlockedLog(entries, total = entries.length) {
  const body = $("blockedBody");
  body.innerHTML = "";
  $("blockedEmpty").style.display = total ? "none" : "block";
  for (const e of entries) {
    const meta = CATEGORY_META[e.category] || CATEGORY_META.other;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtTime(e.ts)}</td>
      <td>${e.domain}</td>
      <td><span class="badge" style="background:${meta.color}">${meta.label}</span></td>
      <td>${reasonLabel(e.reason)}</td>`;
    body.appendChild(tr);
  }
}

function csvCell(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function exportCsv() {
  const days = currentDays();
  const q = days == null ? "" : `?days=${days}`;
  const raw = await api(`/api/stats${q}`);
  const { sites } = enrichStats(raw);
  const cutoff = cutoffTs(days);
  const cq = new URLSearchParams({ cmd: "getAll" });
  if (cutoff) cq.set("cutoff", String(cutoff));

  const [visits, searches, keys, blocked] = await Promise.all([
    api(`/api/logs/visit?${cq}`),
    api(`/api/logs/search?${cq}`),
    api(`/api/logs/key?${cq}`),
    api(`/api/logs/blocked?${cq}`)
  ]);

  const lines = [];
  lines.push(["domain", "category", "visits", "seconds"].join(","));
  for (const s of sites) {
    lines.push([s.domain, s.category, s.visits, s.seconds].map(csvCell).join(","));
  }
  lines.push("");
  lines.push(["timestamp", "domain", "category", "hits", "url"].join(","));
  for (const e of visits.entries || []) {
    lines.push(
      [new Date(e.ts).toISOString(), e.domain, e.category, e.count || 1, e.url || ""]
        .map(csvCell)
        .join(",")
    );
  }
  lines.push("");
  lines.push(["timestamp", "engine", "query"].join(","));
  for (const e of searches.entries || []) {
    lines.push(
      [new Date(e.ts).toISOString(), e.engine || "", e.query || ""].map(csvCell).join(",")
    );
  }
  lines.push("");
  lines.push(["timestamp", "domain", "keys", "text"].join(","));
  for (const e of keys.entries || []) {
    lines.push(
      [new Date(e.ts).toISOString(), e.domain || "", e.count || 0, e.text || ""]
        .map(csvCell)
        .join(",")
    );
  }
  lines.push("");
  lines.push(["timestamp", "domain", "category", "reason"].join(","));
  for (const e of blocked.entries || []) {
    lines.push(
      [new Date(e.ts).toISOString(), e.domain, e.category, e.reason].map(csvCell).join(",")
    );
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `guardian-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderDonut(byCategory, totalSeconds) {
  const el = $("donut");
  const center = $("donutCenter");
  if (!totalSeconds) {
    el.style.background = "var(--border)";
    center.textContent = "No data";
    return;
  }
  let cursor = 0;
  const parts = [];
  for (const [id, rec] of Object.entries(byCategory)) {
    const meta = CATEGORY_META[id] || CATEGORY_META.other;
    const pct = (rec.seconds / totalSeconds) * 360;
    parts.push(`${meta.color} ${cursor}deg ${cursor + pct}deg`);
    cursor += pct;
  }
  el.style.background = `conic-gradient(${parts.join(",")})`;
  center.textContent = formatDuration(totalSeconds);
}

function renderLegend(byCategory, totalSeconds) {
  const el = $("legend");
  el.innerHTML = "";
  const entries = Object.entries(byCategory).sort(
    (a, b) => b[1].seconds - a[1].seconds
  );
  for (const [id, rec] of entries) {
    const meta = CATEGORY_META[id] || CATEGORY_META.other;
    const pct = totalSeconds
      ? Math.round((rec.seconds / totalSeconds) * 100)
      : 0;
    const row = document.createElement("div");
    row.className = "li";
    row.innerHTML = `
      <span class="dot" style="background:${meta.color}"></span>
      <span>${meta.label}</span>
      <span class="v">${formatDuration(rec.seconds)} (${pct}%)</span>`;
    el.appendChild(row);
  }
}

function renderSites(sites) {
  const body = $("sitesBody");
  body.innerHTML = "";
  for (const s of sites) {
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
      const categories = { ...s.categories, [cb.dataset.cat]: cb.checked };
      await saveSettings({ categories });
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

async function alwaysAllow(domain, btn) {
  if (btn) btn.disabled = true;
  try {
    const s = await getSettings();
    const allowlist = [...(s.allowlist || [])];
    const already = domainMatches(domain, allowlist);
    if (!already) allowlist.push(domain);
    const customBlocked = (s.customBlocked || []).filter(
      (d) => !domainMatches(domain, [d])
    );
    await saveSettings({ allowlist, customBlocked });
    showToast(
      already ? `${domain} is already allowed` : `Allowed ${domain}`,
      {
        ok: true,
        sub: "The extension will pick this up within a few seconds."
      }
    );
    await render();
    await renderStats();
  } catch (e) {
    showToast(`Could not allow ${domain}`, { ok: false, sub: e.message });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function alwaysBlock(domain, btn) {
  if (btn) btn.disabled = true;
  try {
    const s = await getSettings();
    const customBlocked = [...(s.customBlocked || [])];
    const already = domainMatches(domain, customBlocked);
    if (!already) customBlocked.push(domain);
    const allowlist = (s.allowlist || []).filter(
      (d) => !domainMatches(domain, [d])
    );
    await saveSettings({ allowlist, customBlocked });
    showToast(
      already ? `${domain} is already on the block list` : `Blocked ${domain}`,
      {
        ok: true,
        sub: "Open tabs for this site will close within a few seconds."
      }
    );
    await render();
    await renderStats();
  } catch (e) {
    showToast(`Could not block ${domain}`, { ok: false, sub: e.message });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function clearAllCustomBlocks() {
  if (
    !confirm(
      "Remove all custom blocked sites? Category rules still block matching sites unless you allow them."
    )
  ) {
    return;
  }
  await saveSettings({ customBlocked: [] });
  await render();
  await renderStats();
}

$("addBlockBtn").addEventListener("click", async () => {
  const input = $("blockInput");
  const domain = toDomain(input.value) || input.value.trim().toLowerCase();
  if (!domain) {
    showToast("Enter a domain to block", { ok: false });
    return;
  }
  try {
    const s = await getSettings();
    const customBlocked = [...(s.customBlocked || [])];
    if (!customBlocked.includes(domain)) customBlocked.push(domain);
    await saveSettings({ customBlocked });
    input.value = "";
    showToast(`Blocked ${domain}`, {
      ok: true,
      sub: "Open tabs for this site will close within a few seconds."
    });
    await render();
  } catch (e) {
    showToast(`Could not block ${domain}`, { ok: false, sub: e.message });
  }
});

$("addAllowBtn").addEventListener("click", async () => {
  const input = $("allowInput");
  const domain = toDomain(input.value) || input.value.trim().toLowerCase();
  if (!domain) return;
  const s = await getSettings();
  const allowlist = [...(s.allowlist || [])];
  if (!allowlist.includes(domain)) allowlist.push(domain);
  await saveSettings({ allowlist });
  input.value = "";
  render();
});

async function removeBlocked(domain) {
  const s = await getSettings();
  await saveSettings({
    customBlocked: (s.customBlocked || []).filter((d) => d !== domain)
  });
  render();
}

async function removeAllowed(domain) {
  const s = await getSettings();
  await saveSettings({
    allowlist: (s.allowlist || []).filter((d) => d !== domain)
  });
  render();
}

$("pauseBtn").addEventListener("click", async () => {
  await api("/api/pause", {
    method: "POST",
    body: JSON.stringify({ minutes: 15, resume: false })
  });
  render();
});

$("resumeBtn").addEventListener("click", async () => {
  await api("/api/pause", {
    method: "POST",
    body: JSON.stringify({ resume: true })
  });
  render();
});

$("changePinBtn").addEventListener("click", async () => {
  const msg = $("changeMsg");
  const pin = $("changePin").value.trim();
  if (pin.length < 4) {
    msg.textContent = "PIN must be at least 4 characters.";
    return;
  }
  try {
    await saveSettings({ pin });
    $("changePin").value = "";
    msg.style.color = "var(--ok)";
    msg.textContent = "PIN updated.";
  } catch (e) {
    msg.style.color = "var(--danger, #c00)";
    msg.textContent = e.message;
  }
});

boot();
