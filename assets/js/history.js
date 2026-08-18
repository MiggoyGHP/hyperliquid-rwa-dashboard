// Historical funding rates page: renders data/funding/* baked by
// scripts/refresh_funding.py. No live API calls. The dataset (~1M rows,
// ~30 MB) dwarfs the ~5 MB localStorage quota, so it lives in memory as
// parallel typed arrays and only the visible page hits the DOM. localStorage
// holds only two small preferences: the summary watchlist and the tz choice.
import { HOURS_PER_YEAR, fmtAprPct, fmtPct } from "./funding.js";
import { classify, DISPLAY_NAMES } from "./classify.js";

const $ = id => document.getElementById(id);
const PER_PAGE = 500;

const WATCH_KEY = "ndad.hist.watchlist";
const TZ_KEY = "ndad.tz"; // "utc" | "local" — also read by the dashboard clock

function loadWatch() {
  try { return new Set(JSON.parse(localStorage.getItem(WATCH_KEY)) || []); }
  catch { return new Set(); }
}
function saveWatch() { localStorage.setItem(WATCH_KEY, JSON.stringify([...state.watch])); }

const state = {
  inst: [],          // {coin, sym, dex, cat, name, rank, start, end}
  t: null,           // Float64Array, ms epoch, ascending within each instrument slice
  r: null,           // Float64Array, hourly decimal rate
  instId: null,      // Uint16Array -> index into inst
  scratch: null,     // Uint32Array(N) reused by applyFilter
  idx: null,         // Uint32Array view over scratch: current filtered row set
  filter: { fromMs: 0, toMs: 0, cat: "all", q: "" },
  utc: localStorage.getItem(TZ_KEY) === "utc", // local time by default
  bakedMs: 0,        // index.json generatedAt, for the header badge
  sortKey: "time",
  sortDir: -1,
  page: 0,
  // The watchlist scopes the per-instrument summary and the CSV export ONLY.
  // The category chips + text filter scope the main hourly table ONLY.
  watch: new Set(),  // coin keys ("ETH", "xyz:NVDA") picked for the summary
  summary: [],       // per-instrument aggregates for watched coins in range
  sumSortKey: "apr",
  sumSortDir: -1,
};

/* ---------------- loading ---------------- */

// The baker keeps timestamps strictly ascending, so this should never drop
// anything. It stays because it is the last line of defence: a stale bundle
// from a cached deploy would otherwise silently inflate every sum on the page
// and the period counts along with them — the failure that shipped once.
function dedupe(t, r, onDrop) {
  let bad = 0;
  for (let i = 1; i < t.length; i++) if (t[i] <= t[i - 1]) { bad++; }
  if (!bad) return [t, r];
  const outT = [], outR = [];
  for (let i = 0; i < t.length; i++) {
    if (outT.length && t[i] <= outT[outT.length - 1]) continue;
    outT.push(t[i]); outR.push(r[i]);
  }
  onDrop(t.length - outT.length);
  return [outT, outR];
}

async function loadAll() {
  const index = await (await fetch("data/funding/index.json")).json();
  const metaNames = {}; // proper names from baked meta (Bitcoin, Apple, …), best-effort
  const metaP = fetch("data/meta.json").then(r => r.json())
    .then(m => m.tickers.forEach(t => { metaNames[t.coin] = t.name; }))
    .catch(() => {});
  const results = await Promise.allSettled(index.dexes.map(async d =>
    (await fetch("data/funding/" + d.file)).json()));
  await metaP;

  const failed = [];
  const slices = []; // [coin, t[], r[]]
  let dropped = 0;
  results.forEach((res, i) => {
    if (res.status === "rejected") { failed.push(index.dexes[i].file); return; }
    for (const [coin, s] of Object.entries(res.value.coins)) {
      if (s.t.length) slices.push([coin, ...dedupe(s.t, s.r, n => (dropped += n))]);
    }
  });
  if (dropped) console.warn(`history: ignored ${dropped} duplicate funding record(s) — run scripts/funding_audit.py`);
  if (failed.length) {
    const note = $("hist-note");
    note.hidden = false;
    note.textContent = `Some funding bundles failed to load (${failed.join(", ")}) — showing the rest.`;
  }
  if (!slices.length) throw new Error("no funding data");

  const n = slices.reduce((sum, s) => sum + s[1].length, 0);
  state.t = new Float64Array(n);
  state.r = new Float64Array(n);
  state.instId = new Uint16Array(n);
  state.scratch = new Uint32Array(n);

  // Alphabetical instrument order once, so the instrument column sorts by a
  // precomputed rank instead of comparing strings a million times.
  slices.sort((a, b) => a[0].localeCompare(b[0]));
  let off = 0;
  slices.forEach(([coin, t, r], rank) => {
    const { dex, sym, cat } = classify(coin);
    state.inst.push({
      coin, sym, dex, cat,
      name: metaNames[coin] ?? DISPLAY_NAMES[sym] ?? "",
      rank, start: off, end: off + t.length,
    });
    for (let i = 0; i < t.length; i++) {
      state.t[off + i] = t[i] * 1000; // baked as epoch seconds
      state.r[off + i] = r[i];
      state.instId[off + i] = rank;
    }
    off += t.length;
  });

  state.bakedMs = Date.parse(index.generatedAt);
  renderBakedBadge();
  reportHealth();
}

// health.json is written by every bake (scripts/funding_audit.py). Anything but
// "ok" means the sentinel found something it could not repair on its own, and
// the numbers on this page may be built on incomplete data — say so rather than
// rendering a confident-looking table over it. Best-effort: an older deploy
// without the file just shows nothing.
async function reportHealth() {
  try {
    const h = await (await fetch("data/funding/health.json")).json();
    if (h.status === "ok") return;
    const bits = [];
    if (h.unresolved?.length) bits.push(`${h.unresolved.length} unexplained gap(s)`);
    if (h.conflicts?.length) bits.push(`${h.conflicts.length} conflicting record(s)`);
    if (h.duplicates) bits.push(`${h.duplicates} duplicate(s)`);
    const note = $("hist-note");
    note.hidden = false;
    note.textContent = `Data health: ${bits.join(", ") || "degraded"} — see data/funding/health.json.`;
  } catch { /* no health file on this deploy */ }
}

/* ---------------- filter / sort ---------------- */

// First index in [lo, hi) with t >= target (slices are ascending).
function lowerBound(t, lo, hi, target) {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function instMatches(inst) {
  if (state.filter.cat !== "all" && inst.cat !== state.filter.cat) return false;
  const q = state.filter.q;
  return !q || inst.sym.toLowerCase().includes(q)
    || inst.name.toLowerCase().includes(q)
    || inst.coin.toLowerCase().includes(q);
}

function applyFilter() {
  const { fromMs, toMs } = state.filter;
  let n = 0;
  for (const inst of state.inst) {
    if (!instMatches(inst)) continue;
    const lo = lowerBound(state.t, inst.start, inst.end, fromMs);
    const hi = lowerBound(state.t, lo, inst.end, toMs + 1);
    for (let i = lo; i < hi; i++) state.scratch[n++] = i;
  }
  state.idx = state.scratch.subarray(0, n);
}

// Per-instrument aggregates over the watchlist for the current range. Walks
// each instrument's contiguous slice (same bounds as applyFilter) rather than
// state.idx, whose sort order interleaves instruments. Independent of the
// table's category/text filters.
function computeSummary() {
  const { fromMs, toMs } = state.filter;
  const out = [];
  if (state.watch.size) {
    for (const inst of state.inst) {
      if (!state.watch.has(inst.coin)) continue;
      const lo = lowerBound(state.t, inst.start, inst.end, fromMs);
      const hi = lowerBound(state.t, lo, inst.end, toMs + 1);
      const n = hi - lo;
      if (!n) continue;
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += state.r[i];
      out.push({ inst, total: sum, n, apr: (sum / n) * HOURS_PER_YEAR });
    }
  }
  state.summary = out;
}

function sortIdx() {
  const { t, r, instId, inst } = state;
  const dir = state.sortDir;
  let cmp;
  switch (state.sortKey) {
    case "inst":
      cmp = (a, b) => (inst[instId[a]].rank - inst[instId[b]].rank) * dir || t[a] - t[b];
      break;
    case "rate":
    case "apr":
      cmp = (a, b) => (r[a] - r[b]) * dir;
      break;
    default: // time
      cmp = (a, b) => (t[a] - t[b]) * dir;
  }
  state.idx.sort(cmp);
}

// Refilter/resort can take ~1-2s on the full history; paint "sorting…" first.
function update() {
  $("pager-text").textContent = "sorting…";
  setTimeout(() => {
    applyFilter();
    computeSummary();
    renderSummary();
    sortIdx();
    state.page = 0;
    render();
  }, 0);
}

/* ---------------- formatting ---------------- */

const fmtHourly = r => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(4)}%`;
const pad = x => String(x).padStart(2, "0");

function fmtTime(ms) {
  if (state.utc) return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// e.g. "UTC+08:00" for the viewer's zone.
function utcOffsetStr() {
  const m = -new Date().getTimezoneOffset();
  const a = Math.abs(m);
  return `UTC${m < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function renderBakedBadge() {
  if (!state.bakedMs) return;
  $("asof-text").textContent =
    `funding baked ${fmtTime(state.bakedMs)} ${state.utc ? "UTC" : utcOffsetStr()}`;
}

// datetime-local inputs are timezone-naive; interpret them in the active zone.
function inputToMs(v) {
  if (!v) return null;
  return state.utc ? Date.parse(v + "Z") : new Date(v).getTime();
}

function msToInput(ms) {
  if (state.utc) return new Date(ms).toISOString().slice(0, 16);
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------- rendering ---------------- */

const COLS = [
  { key: "time", label: () => `Time (${state.utc ? "UTC" : "local"})`, left: true },
  { key: "inst", label: () => "Instrument", left: true },
  { key: "rate", label: () => "Hourly funding" },
  { key: "apr", label: () => "Annualized" },
];

const catTag = inst =>
  (inst.cat !== "stock" ? `<span class="tag tag-${inst.cat}">${inst.cat}</span>` : "") +
  (inst.dex ? `<span class="tag-dex">${inst.dex}</span>` : "");

/* ---------------- per-instrument summary ---------------- */

const SUM_COLS = [
  { key: "inst", label: "Instrument", left: true },
  { key: "total", label: "Funding received (range)", title: "Raw sum of hourly rates over the range — not annualized" },
  { key: "n", label: "Periods (hrs)", title: "Record count. Hourly since the hourly-funding switch; early main-dex history is 8-hour periods." },
  { key: "apr", label: "Annualized", title: "Range funding scaled to a year: total × 8760 / periods" },
  // future: { key: "usd", label: "Accrued (USDC)" } once wallet position sizes exist;
  // computeSummary rows just need a matching field.
];

function renderSummary() {
  const dir = state.sumSortDir;
  const key = state.sumSortKey;
  state.summary.sort((a, b) => {
    switch (key) {
      case "inst": return (a.inst.rank - b.inst.rank) * dir;
      case "total": return (a.total - b.total) * dir;
      case "n": return (a.n - b.n) * dir;
      default: return (a.apr - b.apr) * dir; // apr
    }
  });

  const tbl = $("sum-tbl");
  tbl.tHead.innerHTML = `<tr>${SUM_COLS.map(c =>
    `<th class="sortable${c.left ? " left" : ""}" data-key="${c.key}"${c.title ? ` title="${c.title}"` : ""}>${c.label} ${key === c.key ? `<span class="arr">${dir < 0 ? "▼" : "▲"}</span>` : ""}</th>`
  ).join("")}</tr>`;
  tbl.tHead.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.key;
    if (state.sumSortKey === k) state.sumSortDir *= -1;
    else { state.sumSortKey = k; state.sumSortDir = k === "inst" ? 1 : -1; }
    renderSummary();
  }));

  const sign = x => x >= 0 ? "num-pos" : "num-neg";
  tbl.tBodies[0].innerHTML = state.summary.length ? state.summary.map(s => `<tr>
    <td class="txt left"><b>${s.inst.sym}</b>${catTag(s.inst)}${s.inst.name && s.inst.name !== s.inst.sym ? `<span class="nm">${s.inst.name}</span>` : ""}</td>
    <td class="${sign(s.total)}">${fmtPct(s.total, 3)}</td>
    <td class="muted">${s.n.toLocaleString()}</td>
    <td class="${sign(s.apr)}">${fmtAprPct(s.apr)}</td>
  </tr>`).join("")
    : `<tr><td class="muted left" colspan="4">${state.watch.size
      ? "no records in this range for the selected instruments"
      : "use the search box above to add instruments to the summary"}</td></tr>`;

  $("sum-count").textContent = `${state.watch.size} selected`;
}

/* ---------------- watchlist picker ---------------- */

function renderWatchMenu() {
  const menu = $("watch-menu");
  const q = $("watch-search").value.trim().toLowerCase();
  if (!q) { menu.hidden = true; return; }
  const hits = state.inst.filter(inst => !state.watch.has(inst.coin)
    && (inst.sym.toLowerCase().includes(q)
      || inst.name.toLowerCase().includes(q)
      || inst.coin.toLowerCase().includes(q))).slice(0, 20);
  if (!hits.length) { menu.hidden = true; return; }
  menu.innerHTML = hits.map(inst =>
    `<button type="button" data-coin="${inst.coin}"><b>${inst.sym}</b>${catTag(inst)}${inst.name && inst.name !== inst.sym ? `<span class="nm">${inst.name}</span>` : ""}</button>`
  ).join("");
  menu.hidden = false;
}

function renderWatchChips() {
  $("watch-chips").innerHTML = [...state.watch].sort().map(coin => {
    const inst = state.inst.find(i => i.coin === coin);
    return `<button class="chip" aria-pressed="true" data-coin="${coin}" title="Remove from summary">` +
      `${inst ? inst.sym : coin}${inst && inst.dex ? `<span class="tag-dex">${inst.dex}</span>` : ""} ×</button>`;
  }).join("");
}

function updateCsvBtn() {
  const btn = $("csv-btn");
  btn.disabled = state.watch.size === 0;
  btn.title = btn.disabled
    ? "Add instruments to the summary watchlist first"
    : "Download watchlist rows + summary as CSV";
}

// Watchlist edits leave the main table alone — only the summary re-renders.
function watchChanged() {
  saveWatch();
  renderWatchChips();
  computeSummary();
  renderSummary();
  updateCsvBtn();
}

/* ---------------- CSV export ---------------- */

// Exports the watchlist over the selected range in the active timezone:
// a per-instrument summary block, a blank line, then hourly rows grouped by
// instrument ascending in time (independent of the table's filters/sort).
// Built in chunks with a yield between each so a full-history export doesn't
// freeze the tab; Blob accepts the parts array without one giant join.
async function exportCsv() {
  const btn = $("csv-btn");
  if (!state.watch.size) return;
  btn.disabled = true;
  const oldLabel = btn.textContent;
  try {
    const { fromMs, toMs } = state.filter;
    const tz = state.utc ? "UTC" : `local (${utcOffsetStr()})`;
    const parts = [
      `# NDAD funding summary,from=${fmtTime(fromMs)},to=${fmtTime(toMs)},tz=${tz}\n`,
      "instrument,dex,category,periods,funding_range,annualized\n",
    ];
    for (const s of state.summary) {
      parts.push(`${s.inst.sym},${s.inst.dex || "main"},${s.inst.cat},${s.n},${s.total},${s.apr}\n`);
    }
    parts.push("\n# hourly records\n");
    parts.push(`${state.utc ? "time_utc" : "time_local"},instrument,dex,category,hourly_rate,annualized_rate\n`);

    const idx = [];
    for (const inst of state.inst) {
      if (!state.watch.has(inst.coin)) continue;
      const lo = lowerBound(state.t, inst.start, inst.end, fromMs);
      const hi = lowerBound(state.t, lo, inst.end, toMs + 1);
      for (let i = lo; i < hi; i++) idx.push(i);
    }
    const csvTime = ms => state.utc ? new Date(ms).toISOString() : fmtTime(ms);
    const CHUNK = 50000;
    for (let start = 0; start < idx.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, idx.length);
      const rows = [];
      for (let k = start; k < end; k++) {
        const i = idx[k];
        const inst = state.inst[state.instId[i]];
        const r = state.r[i];
        rows.push(`${csvTime(state.t[i])},${inst.sym},${inst.dex || "main"},${inst.cat},${r},${r * HOURS_PER_YEAR}`);
      }
      parts.push(rows.join("\n") + "\n");
      btn.textContent = `preparing… ${Math.round(end / idx.length * 100)}%`;
      await new Promise(res => setTimeout(res, 0));
    }
    const day = ms => msToInput(ms).slice(0, 10); // day in the active zone
    const url = URL.createObjectURL(new Blob(parts, { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `funding-watchlist_${day(fromMs)}_${day(toMs)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    btn.textContent = oldLabel;
    updateCsvBtn();
  }
}

/* ---------------- controls ---------------- */

function setPressed(container, pressedEl) {
  container.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", String(c === pressedEl)));
}

function applyPreset(preset) {
  // Funding pays on the hour; align to the top of the next hour (ceil so a
  // just-baked record for the current hour is never excluded).
  const now = Math.ceil(Date.now() / 3600e3) * 3600e3;
  const spans = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5 };
  state.filter.toMs = now;
  state.filter.fromMs = preset === "all"
    ? state.t.reduce((min, v) => Math.min(min, v), Infinity)
    : now - spans[preset];
  $("from").value = msToInput(state.filter.fromMs);
  $("to").value = msToInput(state.filter.toMs);
}

function wireControls() {
  $("preset-chips").querySelectorAll(".chip").forEach(chip =>
    chip.addEventListener("click", () => {
      setPressed($("preset-chips"), chip);
      applyPreset(chip.dataset.preset);
      update();
    }));

  const onDateEdit = () => {
    // Minutes are noise — funding is hourly on the hour. Snap at the string
    // level (zone-correct even for :30-offset zones) and write it back so the
    // input displays what the filter uses.
    const snap = el => { if (el.value) el.value = el.value.slice(0, 14) + "00"; };
    snap($("from"));
    snap($("to"));
    const from = inputToMs($("from").value);
    const to = inputToMs($("to").value);
    if (from === null || to === null) return;
    state.filter.fromMs = from;
    state.filter.toMs = to;
    setPressed($("preset-chips"), null); // custom range: no preset active
    update();
  };
  $("from").addEventListener("change", onDateEdit);
  $("to").addEventListener("change", onDateEdit);

  $("tz-toggle").addEventListener("click", () => {
    state.utc = !state.utc;
    localStorage.setItem(TZ_KEY, state.utc ? "utc" : "local");
    const btn = $("tz-toggle");
    btn.textContent = state.utc ? "UTC" : "local";
    btn.setAttribute("aria-pressed", String(state.utc));
    // same instants, re-expressed in the new zone
    $("from").value = msToInput(state.filter.fromMs);
    $("to").value = msToInput(state.filter.toMs);
    renderBakedBadge();
    render();
  });

  $("cat-chips").querySelectorAll(".chip").forEach(chip =>
    chip.addEventListener("click", () => {
      setPressed($("cat-chips"), chip);
      state.filter.cat = chip.dataset.cat;
      update();
    }));

  let debounce;
  $("search").addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.filter.q = $("search").value.trim().toLowerCase();
      update();
    }, 200);
  });

  let watchDebounce;
  $("watch-search").addEventListener("input", () => {
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(renderWatchMenu, 200);
  });
  $("watch-search").addEventListener("keydown", e => {
    if (e.key === "Escape") $("watch-menu").hidden = true;
  });
  $("watch-search").addEventListener("blur", () =>
    setTimeout(() => { $("watch-menu").hidden = true; }, 150));
  // pointerdown fires before the input's blur, so the pick always lands
  $("watch-menu").addEventListener("pointerdown", e => {
    const b = e.target.closest("button[data-coin]");
    if (!b) return;
    e.preventDefault();
    state.watch.add(b.dataset.coin);
    watchChanged();
    $("watch-search").value = "";
    $("watch-menu").hidden = true;
    $("watch-search").focus();
  });
  $("watch-chips").addEventListener("click", e => {
    const b = e.target.closest(".chip[data-coin]");
    if (!b) return;
    state.watch.delete(b.dataset.coin);
    watchChanged();
  });

  $("csv-btn").addEventListener("click", exportCsv);

  $("prev").addEventListener("click", () => { if (state.page > 0) { state.page--; render(); } });
  $("next").addEventListener("click", () => {
    if ((state.page + 1) * PER_PAGE < state.idx.length) { state.page++; render(); }
  });
}

function render() {
  const tbl = $("hist-tbl");
  tbl.tHead.innerHTML = `<tr>${COLS.map(c =>
    `<th class="sortable${c.left ? " left" : ""}" data-key="${c.key}">${c.label()} ${state.sortKey === c.key ? `<span class="arr">${state.sortDir < 0 ? "▼" : "▲"}</span>` : ""}</th>`
  ).join("")}</tr>`;
  tbl.tHead.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.key;
    if (state.sortKey === k) state.sortDir *= -1;
    else { state.sortKey = k; state.sortDir = k === "inst" ? 1 : -1; }
    $("pager-text").textContent = "sorting…";
    setTimeout(() => { sortIdx(); state.page = 0; render(); }, 0);
  }));

  const n = state.idx.length;
  const startRow = state.page * PER_PAGE;
  const rows = [];
  for (let k = startRow; k < Math.min(startRow + PER_PAGE, n); k++) {
    const i = state.idx[k];
    const inst = state.inst[state.instId[i]];
    const r = state.r[i];
    const cls = r >= 0 ? "num-pos" : "num-neg";
    rows.push(`<tr>
      <td class="muted left">${fmtTime(state.t[i])}</td>
      <td class="txt left"><b>${inst.sym}</b>${catTag(inst)}${inst.name && inst.name !== inst.sym ? `<span class="nm">${inst.name}</span>` : ""}</td>
      <td class="${cls}">${fmtHourly(r)}</td>
      <td class="${cls}">${fmtAprPct(r * HOURS_PER_YEAR)}</td>
    </tr>`);
  }
  tbl.tBodies[0].innerHTML = rows.length ? rows.join("")
    : `<tr><td class="muted left" colspan="4">no rows in this range</td></tr>`;

  $("pager-text").textContent = n
    ? `rows ${(startRow + 1).toLocaleString()}–${Math.min(startRow + PER_PAGE, n).toLocaleString()} of ${n.toLocaleString()}`
    : "0 rows";
  $("prev").disabled = state.page === 0;
  $("next").disabled = startRow + PER_PAGE >= n;
}

/* ---------------- boot ---------------- */

async function boot() {
  try {
    await loadAll();
  } catch (e) {
    console.error(e);
    $("asof-text").textContent = "failed to load funding data";
    $("hist-tbl").tBodies[0].innerHTML =
      `<tr><td class="muted left" colspan="4">Could not load data/funding/ — run scripts/refresh_funding.py and redeploy.</td></tr>`;
    return;
  }
  // drop watchlist entries for coins that no longer exist in the bake
  const known = new Set(state.inst.map(i => i.coin));
  state.watch = new Set([...loadWatch()].filter(c => known.has(c)));
  saveWatch();

  wireControls();
  const tzBtn = $("tz-toggle"); // markup defaults to local; honor a saved UTC pref
  tzBtn.textContent = state.utc ? "UTC" : "local";
  tzBtn.setAttribute("aria-pressed", String(state.utc));

  renderWatchChips();
  updateCsvBtn();
  applyPreset("7d"); // matches the chip pre-pressed in history.html
  applyFilter();
  computeSummary();
  renderSummary();
  sortIdx();
  render();
}

boot();
