// Historical funding rates page: renders data/funding/* baked by
// scripts/refresh_funding.py. No live API calls and no localStorage — the
// dataset (~1M rows, ~30 MB) dwarfs the ~5 MB quota, so it lives in memory
// as parallel typed arrays and only the visible page hits the DOM.
import { HOURS_PER_YEAR, fmtAprPct } from "./funding.js";
import { classify, DISPLAY_NAMES } from "./classify.js";

const $ = id => document.getElementById(id);
const PER_PAGE = 500;

const state = {
  inst: [],          // {coin, sym, dex, cat, name, rank, start, end}
  t: null,           // Float64Array, ms epoch, ascending within each instrument slice
  r: null,           // Float64Array, hourly decimal rate
  p: null,           // Float64Array, premium (NaN = missing)
  instId: null,      // Uint16Array -> index into inst
  scratch: null,     // Uint32Array(N) reused by applyFilter
  idx: null,         // Uint32Array view over scratch: current filtered row set
  filter: { fromMs: 0, toMs: 0, cat: "all", q: "" },
  utc: true,
  sortKey: "time",
  sortDir: -1,
  page: 0,
};

/* ---------------- loading ---------------- */

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
  const slices = []; // [coin, t[], r[], p[]]
  results.forEach((res, i) => {
    if (res.status === "rejected") { failed.push(index.dexes[i].file); return; }
    for (const [coin, s] of Object.entries(res.value.coins)) {
      if (s.t.length) slices.push([coin, s.t, s.r, s.p]);
    }
  });
  if (failed.length) {
    const note = $("hist-note");
    note.hidden = false;
    note.textContent = `Some funding bundles failed to load (${failed.join(", ")}) — showing the rest.`;
  }
  if (!slices.length) throw new Error("no funding data");

  const n = slices.reduce((sum, s) => sum + s[1].length, 0);
  state.t = new Float64Array(n);
  state.r = new Float64Array(n);
  state.p = new Float64Array(n);
  state.instId = new Uint16Array(n);
  state.scratch = new Uint32Array(n);

  // Alphabetical instrument order once, so the instrument column sorts by a
  // precomputed rank instead of comparing strings a million times.
  slices.sort((a, b) => a[0].localeCompare(b[0]));
  let off = 0;
  slices.forEach(([coin, t, r, p], rank) => {
    const { dex, sym, cat } = classify(coin);
    state.inst.push({
      coin, sym, dex, cat,
      name: metaNames[coin] ?? DISPLAY_NAMES[sym] ?? "",
      rank, start: off, end: off + t.length,
    });
    for (let i = 0; i < t.length; i++) {
      state.t[off + i] = t[i] * 1000; // baked as epoch seconds
      state.r[off + i] = r[i];
      state.p[off + i] = p[i] === null ? NaN : p[i]; // Number(null) is 0, not NaN
      state.instId[off + i] = rank;
    }
    off += t.length;
  });

  $("asof-text").textContent = `funding baked ${index.generatedAt.slice(0, 16).replace("T", " ")} UTC`;
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

function sortIdx() {
  const { t, r, p, instId, inst } = state;
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
    case "premium": // NaN (missing) sorts last regardless of direction
      cmp = (a, b) => {
        const pa = p[a], pb = p[b];
        if (Number.isNaN(pa)) return Number.isNaN(pb) ? 0 : 1;
        if (Number.isNaN(pb)) return -1;
        return (pa - pb) * dir;
      };
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
    sortIdx();
    state.page = 0;
    render();
  }, 0);
}

/* ---------------- formatting ---------------- */

const fmtHourly = r => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(4)}%`;
const fmtPremium = p => Number.isNaN(p) ? "—" : `${p >= 0 ? "+" : ""}${(p * 100).toFixed(3)}%`;
const pad = x => String(x).padStart(2, "0");

function fmtTime(ms) {
  if (state.utc) return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  { key: "time", label: () => `Time (${state.utc ? "UTC" : "local"})` },
  { key: "inst", label: () => "Instrument" },
  { key: "rate", label: () => "Hourly funding" },
  { key: "apr", label: () => "Annualized" },
  { key: "premium", label: () => "Premium" },
];

const catTag = inst =>
  (inst.cat !== "stock" ? `<span class="tag tag-${inst.cat}">${inst.cat}</span>` : "") +
  (inst.dex ? `<span class="tag-dex">${inst.dex}</span>` : "");

function render() {
  const tbl = $("hist-tbl");
  tbl.tHead.innerHTML = `<tr>${COLS.map(c =>
    `<th class="sortable" data-key="${c.key}">${c.label()} ${state.sortKey === c.key ? `<span class="arr">${state.sortDir < 0 ? "▼" : "▲"}</span>` : ""}</th>`
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
      <td class="muted" style="text-align:left">${fmtTime(state.t[i])}</td>
      <td class="txt" style="text-align:left"><b>${inst.sym}</b>${catTag(inst)}${inst.name && inst.name !== inst.sym ? `<span class="nm">${inst.name}</span>` : ""}</td>
      <td class="${cls}">${fmtHourly(r)}</td>
      <td class="${cls}">${fmtAprPct(r * HOURS_PER_YEAR)}</td>
      <td class="muted">${fmtPremium(state.p[i])}</td>
    </tr>`);
  }
  tbl.tBodies[0].innerHTML = rows.length ? rows.join("")
    : `<tr><td class="muted" colspan="5" style="text-align:left">no rows in this range</td></tr>`;

  $("pager-text").textContent = n
    ? `rows ${(startRow + 1).toLocaleString()}–${Math.min(startRow + PER_PAGE, n).toLocaleString()} of ${n.toLocaleString()}`
    : "0 rows";
  $("prev").disabled = state.page === 0;
  $("next").disabled = startRow + PER_PAGE >= n;
}

/* ---------------- controls ---------------- */

function setPressed(container, pressedEl) {
  container.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", String(c === pressedEl)));
}

function applyPreset(preset) {
  const now = Date.now();
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
    const btn = $("tz-toggle");
    btn.textContent = state.utc ? "UTC" : "local";
    btn.setAttribute("aria-pressed", String(state.utc));
    // same instants, re-expressed in the new zone
    $("from").value = msToInput(state.filter.fromMs);
    $("to").value = msToInput(state.filter.toMs);
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

  $("prev").addEventListener("click", () => { if (state.page > 0) { state.page--; render(); } });
  $("next").addEventListener("click", () => {
    if ((state.page + 1) * PER_PAGE < state.idx.length) { state.page++; render(); }
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  try {
    await loadAll();
  } catch (e) {
    console.error(e);
    $("asof-text").textContent = "failed to load funding data";
    $("hist-tbl").tBodies[0].innerHTML =
      `<tr><td class="muted" colspan="5" style="text-align:left">Could not load data/funding/ — run scripts/refresh_funding.py and redeploy.</td></tr>`;
    return;
  }
  wireControls();
  applyPreset("7d"); // matches the chip pre-pressed in history.html
  applyFilter();
  sortIdx();
  render();
}

boot();
