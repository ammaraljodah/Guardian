import { CATEGORIES } from "./categories.js";
import {
  getSettings,
  saveSettings,
  setPin,
  verifyPin,
  toDomain,
  domainMatches
} from "./store.js";
import {
  aggregate,
  clearStats,
  formatDuration,
  CATEGORY_META,
  getSearchLog,
  getBlockedLog,
  getVisitLog,
  getKeyLog,
  getVisitLogPage,
  getSearchLogPage,
  getKeyLogPage,
  getBlockedLogPage,
  clearSearchLog,
  clearBlockedLog,
  clearVisitLog,
  clearKeyLog,
  migrateLegacyLogs,
  KEY_BUCKET_MS
} from "./stats.js";

const PAGE_SIZE = 500;

// Current page (0-based) for each paginated log table.
const logPage = { history: 0, search: 0, key: 0, blocked: 0 };

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
  await migrateLegacyLogs().catch((e) =>
    console.error("[Guardian] log migration failed:", e)
  );
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
    confirm(
      "Clear all recorded statistics, searches, keyboard activity and blocked attempts? This cannot be undone."
    )
  ) {
    await Promise.all([
      clearStats(),
      clearSearchLog(),
      clearBlockedLog(),
      clearVisitLog(),
      clearKeyLog()
    ]);
    resetLogPages();
    renderStats();
  }
});

$("exportBtn").addEventListener("click", exportCsv);

$("unblockAllBtn").addEventListener("click", clearAllCustomBlocks);

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

    await Promise.all([
      renderHistoryPage(),
      renderSearchPage(),
      renderKeyPage(),
      renderBlockedPage()
    ]);
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

function fmtTimeSec(ts) {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function fmtKeyBucket(entry) {
  const start = entry.bucket ?? entry.downTs;
  const end = start + KEY_BUCKET_MS;
  return `${fmtTimeSec(start)} – ${fmtTimeSec(end)}`;
}

function displayKeyText(entry) {
  if (entry.text != null) return entry.text;
  if (entry.key != null) return entry.key.length === 1 ? entry.key : `[${entry.key}]`;
  return "";
}

/* ------------------------- Paginated log tables ------------------------ */

// Draw a "Prev  Page X of Y (N total)  Next" bar into the given container.
// `key` is the logPage field; `onChange` re-renders the owning table.
function renderPager(containerId, key, total, onChange) {
  const el = $(containerId);
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (logPage[key] >= pages) logPage[key] = pages - 1;
  const page = logPage[key];

  if (total <= PAGE_SIZE) {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  el.style.display = "flex";
  el.innerHTML = "";

  const prev = document.createElement("button");
  prev.className = "secondary";
  prev.textContent = "‹ Prev";
  prev.disabled = page <= 0;
  prev.addEventListener("click", () => {
    if (logPage[key] > 0) {
      logPage[key]--;
      onChange();
    }
  });

  const info = document.createElement("span");
  info.className = "pager-info";
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  info.textContent = `${from}–${to} of ${total} · page ${page + 1}/${pages}`;

  const next = document.createElement("button");
  next.className = "secondary";
  next.textContent = "Next ›";
  next.disabled = page >= pages - 1;
  next.addEventListener("click", () => {
    if (logPage[key] < pages - 1) {
      logPage[key]++;
      onChange();
    }
  });

  el.appendChild(prev);
  el.appendChild(info);
  el.appendChild(next);
}

async function renderHistoryPage() {
  const days = currentDays();
  const settings = await getSettings();
  const { entries, total } = await getVisitLogPage({
    days,
    offset: logPage.history * PAGE_SIZE,
    limit: PAGE_SIZE
  });
  renderHistoryLog(entries, settings, total);
  renderPager("historyPager", "history", total, renderHistoryPage);
}

async function renderSearchPage() {
  const days = currentDays();
  const { entries, total } = await getSearchLogPage({
    days,
    offset: logPage.search * PAGE_SIZE,
    limit: PAGE_SIZE
  });
  renderSearchLog(entries, total);
  renderPager("searchPager", "search", total, renderSearchPage);
}

async function renderKeyPage() {
  const days = currentDays();
  const { entries, total } = await getKeyLogPage({
    days,
    offset: logPage.key * PAGE_SIZE,
    limit: PAGE_SIZE
  });
  renderKeyLog(entries, total);
  renderPager("keyPager", "key", total, renderKeyPage);
}

async function renderBlockedPage() {
  const days = currentDays();
  const { entries, total } = await getBlockedLogPage({
    days,
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
    const allowed = domainMatches(e.domain, settings.allowlist || []);
    const blocked = domainMatches(e.domain, settings.customBlocked || []);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="muted">${fmtTime(e.ts)}</td>
      <td>${e.domain}</td>
      <td><span class="badge" style="background:${meta.color}">${meta.label}</span></td>
      <td class="num">${e.count || 1}</td>`;

    const actions = document.createElement("td");
    actions.className = "history-actions";

    const allowBtn = document.createElement("button");
    allowBtn.className = "secondary";
    allowBtn.textContent = allowed ? "Allowed" : "Allow";
    allowBtn.disabled = allowed;
    allowBtn.addEventListener("click", () => alwaysAllow(e.domain));

    const blockBtn = document.createElement("button");
    blockBtn.className = "danger";
    blockBtn.textContent = blocked ? "Blocked" : "Block";
    blockBtn.disabled = blocked;
    blockBtn.addEventListener("click", () => alwaysBlock(e.domain));

    actions.appendChild(allowBtn);
    actions.appendChild(blockBtn);
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

function renderSearchLog(entries, total = entries.length) {
  const body = $("searchBody");
  body.innerHTML = "";
  $("searchEmpty").style.display = total ? "none" : "block";
  for (const e of entries) {
    const tr = document.createElement("tr");
    const q = document.createElement("td");
    q.textContent = e.query; // textContent avoids HTML injection
    tr.innerHTML = `<td class="muted">${fmtTime(e.ts)}</td><td>${e.engine}</td>`;
    tr.appendChild(q);
    body.appendChild(tr);
  }
}

function renderKeyLog(entries, total = entries.length) {
  const body = $("keyBody");
  body.innerHTML = "";
  $("keyEmpty").style.display = total ? "none" : "block";
  for (const e of entries) {
    const tr = document.createElement("tr");
    const text = displayKeyText(e);
    const textCell = document.createElement("td");
    textCell.textContent = text;
    textCell.title = text;
    tr.innerHTML = `
      <td class="muted">${fmtKeyBucket(e)}</td>
      <td>${e.domain}</td>
      <td class="num">${e.count || 1}</td>`;
    tr.appendChild(textCell);
    body.appendChild(tr);
  }
}

function reasonLabel(reason) {
  if (reason === "proxy") return "Proxy page";
  if (reason === "content") return "Content match";
  return "Blocked site";
}

function renderBlockedLog(entries, total = entries.length) {
  const body = $("blockedBody");
  body.innerHTML = "";
  $("blockedEmpty").style.display = total ? "none" : "block";
  for (const e of entries) {
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
  const history = await getVisitLog(days);
  const searches = await getSearchLog(days);
  const keys = await getKeyLog(days);
  const blocked = await getBlockedLog(days);

  const lines = [];
  lines.push("SITES");
  lines.push(["domain", "category", "visits", "seconds"].join(","));
  for (const s of sites) {
    lines.push([s.domain, s.category, s.visits, s.seconds].map(csvCell).join(","));
  }
  lines.push("");
  lines.push("VISIT_HISTORY");
  lines.push(["timestamp", "domain", "category", "hits", "url"].join(","));
  for (const e of history) {
    lines.push(
      [new Date(e.ts).toISOString(), e.domain, e.category, e.count || 1, e.url || ""]
        .map(csvCell)
        .join(",")
    );
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
  lines.push("KEYBOARD");
  lines.push(["period_start", "period_end", "domain", "keystrokes", "text"].join(","));
  for (const e of keys) {
    const start = e.bucket ?? e.downTs;
    const end = start + KEY_BUCKET_MS;
    lines.push(
      [
        new Date(start).toISOString(),
        new Date(end).toISOString(),
        e.domain,
        e.count || 1,
        displayKeyText(e)
      ]
        .map(csvCell)
        .join(",")
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

async function alwaysAllow(domain) {
  const s = await getSettings();
  if (!domainMatches(domain, s.allowlist)) s.allowlist.push(domain);
  s.customBlocked = (s.customBlocked || []).filter(
    (d) => !domainMatches(domain, [d])
  );
  await saveSettings(s);
  await render();
  await renderStats();
}

async function alwaysBlock(domain) {
  const s = await getSettings();
  if (!domainMatches(domain, s.customBlocked)) s.customBlocked.push(domain);
  s.allowlist = (s.allowlist || []).filter((d) => !domainMatches(domain, [d]));
  await saveSettings(s);
  await render();
  await renderStats();
}

async function clearAllCustomBlocks() {
  if (
    !confirm(
      "Remove all custom blocked sites? Category rules still block matching sites unless you allow them."
    )
  ) {
    return;
  }
  const s = await getSettings();
  s.customBlocked = [];
  await saveSettings(s);
  await render();
  await renderStats();
}

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
