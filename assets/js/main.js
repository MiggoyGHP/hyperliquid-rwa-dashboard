import { getAssetCtxs, getFundingHistory, getRecentFunding } from "./hyperliquid.js";
import { getMeta, getOhlc, getOptions } from "./baked.js";
import { getDeribitOptions } from "./deribit.js";
import {
  fundingWindows, annualizedSeries, cumulativeSeries, dailyAprSeries, worstRolling30d, stabilityStats,
  fmtPct, fmtAprPct, fmtUsd, HOURS_PER_YEAR,
} from "./funding.js";
import { renderFundingChart, renderCumulativeChart, renderCandles, emaSeries, clearChart, legend } from "./charts.js";
import { initChain } from "./optionsTable.js";
import { VARIANTS, defaultStrike, compute } from "./strategy.js";
import { renderRiskReward } from "./riskpanel.js";
import { classify, DISPLAY_NAMES } from "./classify.js";

const $ = id => document.getElementById(id);
const COLOR = { pos: "#17A67E", neg: "#D9536F", violet: "#8B6FE8" };

const state = {
  meta: null,
  profiles: null,         // sym -> baked asset profile (data/profiles.json)
  summary: null,          // coin -> {apr30, days, n} baked 30d means (data/funding/summary.json)
  rows: [],               // joined baked+live ticker rows
  histories: new Map(),   // coin -> { t, r }
  windows: new Map(),     // coin -> fundingWindows result
  selected: null,
  catFilter: "all",
  sortKey: "nowApr", sortDir: -1,
  calc: { variant: "stock", expiry: null, strike: null, options: null, ohlc: null },
  overlays: { ema50: false, ema100: false, ema200: false, funding: false },
};

const aprClass = x => (x === null || x === undefined ? "muted" : x >= 0 ? "num-pos" : "num-neg");
const nowApr = row => (Number.isFinite(row.ctx?.funding) ? row.ctx.funding * HOURS_PER_YEAR : null);

// Trailing 30d mean APR: prefer a live-computed full window (fresher), else the
// baked daily summary. null unless a full 30 days of history backs the number.
function apr30(row) {
  const w = state.windows.get(row.coin)?.d30;
  if (w && w.n && !w.partialDays) return w.apr;
  const s = state.summary?.[row.coin];
  return s && s.days >= 30 ? s.apr30 : null;
}

// Hero ranking: 30d averages when available, else this hour's rate so the
// board never renders empty before summary.json is deployed/baked.
function heroRank() {
  const d30 = state.rows.map(r => ({ r, apr: apr30(r) })).filter(x => x.apr !== null);
  if (d30.length) return { mode: "d30", rows: d30.sort((a, b) => b.apr - a.apr) };
  return {
    mode: "now",
    rows: state.rows.map(r => ({ r, apr: nowApr(r) }))
      .filter(x => x.apr !== null)
      .sort((a, b) => b.apr - a.apr),
  };
}

/* ---------------- boot ---------------- */
// The table is live-first: every asset on every dex we poll gets a row,
// enriched with baked meta (name, spot, options) where a coin matches.
function buildRows(ctxs) {
  const metaByCoin = new Map(state.meta.tickers.map(t => [t.coin, t]));
  const rows = [];
  for (const ctx of ctxs.values()) {
    const { dex, sym, cat } = classify(ctx.coin);
    const m = metaByCoin.get(ctx.coin);
    // Builder-dex (HIP-3) assets all get rows; the main dex has ~180 crypto
    // perps and would drown the table, so it's limited to the baked set
    // (BTC/ETH/HYPE).
    if (!dex && !m) continue;
    rows.push({
      coin: ctx.coin, sym, dex, cat,
      kind: cat === "crypto" ? "crypto" : "rwa",
      baked: !!m,
      name: m?.name ?? DISPLAY_NAMES[sym] ?? sym,
      yahoo: m?.yahoo,
      hasOptions: m?.hasOptions ?? false,
      spot: m?.spot,
      ctx,
    });
  }
  return rows;
}

async function boot() {
  // best-effort: the About card just stays hidden if profiles are missing
  fetch("data/profiles.json").then(r => r.json())
    .then(p => { state.profiles = p.profiles; if (state.selected) renderAbout(state.rows.find(r => r.coin === state.selected)); })
    .catch(() => {});
  // best-effort: hero falls back to this hour's rate if the summary is missing
  fetch("data/funding/summary.json").then(r => (r.ok ? r.json() : null))
    .then(s => { if (s) { state.summary = s.coins; renderBoard(); } })
    .catch(() => {});
  try {
    state.meta = await getMeta();
    // First dexes to answer render immediately; the rest stream in.
    await getAssetCtxs(partial => {
      state.rows = buildRows(partial);
      renderBoard();
      renderOverview();
    });
  } catch (e) {
    $("live-badge-text").textContent = "data failed to load — refresh to retry";
    $("live-badge").classList.remove("live");
    console.error(e);
    return;
  }
  $("live-badge-text").textContent = "live funding · Hyperliquid";
  const asOf = new Date(state.meta.generatedAt);
  $("baked-badge-text").textContent = `stocks & options as of ${asOf.toISOString().slice(0, 10)}`;

  refreshLoop();
  prefetchTopWindows();
}

async function refreshLoop() {
  // keep the "live" promise honest: refresh funding contexts every minute
  setInterval(async () => {
    try {
      const ctxs = await getAssetCtxs();
      state.rows = buildRows(ctxs); // also picks up newly listed assets
      renderBoard();
      renderOverview();
    } catch { /* transient */ }
  }, 60_000);
  // local clock by default; "ndad.tz" (set by the history page toggle) can pin it to UTC
  const utc = localStorage.getItem("ndad.tz") === "utc";
  const pad = x => String(x).padStart(2, "0");
  const offMin = -new Date().getTimezoneOffset();
  const offStr = `UTC${offMin < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`;
  setInterval(() => {
    const d = new Date();
    $("board-time").textContent = utc
      ? d.toUTCString().slice(17, 25) + " UTC"
      : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${offStr}`;
  }, 1000);
}

/* ---------------- hero board ---------------- */
const BOARD_NOTES = {
  d30: `Ranked by average funding over the last 30 days, annualized (refreshed daily). Only assets with a full 30-day history. Click a ticker to study it below.`,
  now: `Live from Hyperliquid. "Annualized" = this hour's rate held for a year. Click a ticker to study it below.`,
};

function renderBoard() {
  const { mode, rows } = heroRank();
  const top = rows.slice(0, 8);
  $("board-rows").innerHTML = top.map(({ r, apr }) => `
    <button class="board-row" data-coin="${r.coin}">
      <span><span class="sym">${r.sym}</span>${catTags(r)}<span class="nm">${r.name}</span></span>
      <span class="apr ${apr >= 0 ? "pos" : "neg"}">${fmtAprPct(apr)}</span>
    </button>`).join("");
  $("board-note").textContent = BOARD_NOTES[mode];
  $("board-rows").querySelectorAll("[data-coin]").forEach(el =>
    el.addEventListener("click", () => select(el.dataset.coin)));
}

// Category pill for non-stocks + a muted dex badge for builder-dex perps.
const catTags = r =>
  (r.cat !== "stock" ? `<span class="tag tag-${r.cat}">${r.cat}</span>` : "") +
  (r.dex ? `<span class="tag-dex">${r.dex}</span>` : "");

/* ---------------- overview table ---------------- */
const COLS = [
  { key: "sym", label: "Ticker", sortable: true },
  { key: "spot", label: "Last close", sortable: true },
  { key: "mark", label: "Perp price", sortable: true },
  { key: "nowApr", label: "Funding now (APR)", sortable: true },
  { key: "h24", label: "24h (APR)", sortable: true },
  { key: "d7", label: "7d (APR)", sortable: true },
  { key: "d30", label: "30d (APR)", sortable: true },
  { key: "vol", label: "Perp 24h volume", sortable: true },
];

const fmtCompactUsd = x => {
  if (!Number.isFinite(x)) return "—";
  if (x >= 1e9) return "$" + (x / 1e9).toFixed(1) + "B";
  if (x >= 1e6) return "$" + (x / 1e6).toFixed(1) + "M";
  if (x >= 1e3) return "$" + (x / 1e3).toFixed(0) + "K";
  return "$" + x.toFixed(0);
};

function rowValue(r, key) {
  const w = state.windows.get(r.coin);
  switch (key) {
    case "sym": return r.sym;
    case "spot": return r.spot ?? null;
    case "mark": return r.ctx?.markPx ?? null;
    case "nowApr": return nowApr(r);
    case "h24": return w ? w.h24.apr : null;
    case "d7": return w ? w.d7.apr : null;
    case "d30": return w ? w.d30.apr : null;
    case "vol": return r.ctx?.dayNtlVlm ?? null;
    default: return null;
  }
}

function renderOverview() {
  const thead = $("overview-tbl").tHead;
  thead.innerHTML = `<tr>${COLS.map(c =>
    `<th class="sortable" data-key="${c.key}">${c.label} ${state.sortKey === c.key ? `<span class="arr">${state.sortDir < 0 ? "▼" : "▲"}</span>` : ""}</th>`
  ).join("")}</tr>`;
  thead.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.key;
    if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = k === "sym" ? 1 : -1; }
    renderOverview();
  }));

  const rows = state.rows.filter(r => state.catFilter === "all" || r.cat === state.catFilter).sort((a, b) => {
    const va = rowValue(a, state.sortKey), vb = rowValue(b, state.sortKey);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * state.sortDir;
  });

  const body = $("overview-tbl").tBodies[0];
  body.innerHTML = rows.map(r => {
    const w = state.windows.get(r.coin);
    const cell = v => v === null || v === undefined
      ? `<td class="muted">…</td>`
      : `<td class="${aprClass(v)}">${fmtAprPct(v)}</td>`;
    return `<tr class="pick" data-coin="${r.coin}" aria-selected="${state.selected === r.coin}">
      <td class="txt"><b>${r.sym}</b>${catTags(r)}<span class="nm">${r.name}</span></td>
      <td>${r.spot ? "$" + r.spot.toFixed(2) : "—"}</td>
      <td>${Number.isFinite(r.ctx?.markPx) ? "$" + r.ctx.markPx.toFixed(2) : "—"}</td>
      ${cell(nowApr(r))}
      ${cell(w ? w.h24.apr : null)}
      ${cell(w ? w.d7.apr : null)}
      ${cell(w ? w.d30.apr : null)}
      <td class="muted">${fmtCompactUsd(r.ctx?.dayNtlVlm)}</td>
    </tr>`;
  }).join("");
  body.querySelectorAll("tr[data-coin]").forEach(tr =>
    tr.addEventListener("click", () => select(tr.dataset.coin)));

  const pendingRows = rows.filter(r => !state.windows.has(r.coin));
  $("overview-note").innerHTML = pendingRows.length
    ? `Trailing columns are fetched live per ticker (${pendingRows.length} remaining in this tab). <a href="#" id="load-all">Load all now</a> — takes ~${Math.max(1, Math.ceil(pendingRows.length * 2.2 / 60))} min the first time; cached after that.`
    : "All trailing windows loaded from live Hyperliquid history.";
  const la = $("load-all");
  if (la) la.addEventListener("click", async e => {
    e.preventDefault(); la.replaceWith("loading…");
    for (const r of pendingRows) await loadWindows(r.coin);
  });

  renderTabCounts();
}

/* ---------------- category tabs ---------------- */
const CAT_COUNT_LABELS = { all: "All", stock: "Stocks", crypto: "Crypto", commodity: "Commodities", other: "Other" };

function renderTabCounts() {
  $("cat-tabs").querySelectorAll("[data-cat]").forEach(b => {
    const cat = b.dataset.cat;
    const n = cat === "all" ? state.rows.length : state.rows.filter(r => r.cat === cat).length;
    b.textContent = `${CAT_COUNT_LABELS[cat]} (${n})`;
  });
}

$("cat-tabs").querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => {
  state.catFilter = b.dataset.cat;
  $("cat-tabs").querySelectorAll("[data-cat]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  renderOverview();
}));

// Overview needs only ~30 days (2 API calls); full history loads on selection.
async function loadWindows(coin) {
  if (state.windows.has(coin)) return;
  try {
    const hist = await getRecentFunding(coin);
    state.windows.set(coin, fundingWindows(hist));
    renderOverview();
  } catch (e) { console.warn("recent funding failed", coin, e); }
}

let holdPrefetch = 0; // selections take priority over background prefetch

async function loadFullHistory(coin) {
  if (state.histories.has(coin)) return state.histories.get(coin);
  holdPrefetch++;
  try {
    const hist = await getFundingHistory(coin);
    state.histories.set(coin, hist);
    state.windows.set(coin, fundingWindows(hist));
    renderOverview();
    return hist;
  } catch (e) { console.warn("history failed", coin, e); return null; }
  finally { holdPrefetch--; }
}

async function prefetchTopWindows() {
  const top = heroRank().rows.slice(0, 10).map(x => x.r);
  for (const r of top) {
    while (holdPrefetch > 0) await new Promise(res => setTimeout(res, 500));
    await loadWindows(r.coin);
  }
}

/* ---------------- ticker detail ---------------- */

// $3.21T / $45.2B / $850M — market caps don't need more precision than this.
function fmtBigUsd(x) {
  const a = Math.abs(x);
  if (a >= 1e12) return `$${(x / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(0)}M`;
  return fmtUsd(x);
}

// About card: baked profile (description + market cap / sector / network) for
// the selected asset, keyed by symbol so multi-dex listings share one entry.
function renderAbout(row) {
  const p = row && state.profiles?.[row.sym];
  $("about-card").hidden = !p;
  if (!p) return;
  $("about-desc").textContent = p.desc;
  const fact = (lbl, val) => `<span class="fact"><span class="k">${lbl}</span>${val}</span>`;
  $("about-facts").innerHTML =
    (p.mcap ? fact(p.mcapKind === "aum" ? "Fund assets" : "Market cap", fmtBigUsd(p.mcap)) : "") +
    (p.sector ? fact("Sector", p.sector) : "") +
    (p.industry ? fact("Industry", p.industry) : "") +
    (p.network ? fact("Network", p.network) : "");
}

async function select(coin) {
  const row = state.rows.find(r => r.coin === coin);
  if (!row) return;
  state.selected = coin;
  // Assets without baked data (most builder-dex perps) get a funding-only
  // view: no candles, options chain or calculator — those need Yahoo/Cboe data.
  $("detail").hidden = false;
  $("options").hidden = !row.baked || !row.hasOptions;
  $("strategy").hidden = true; // yield calculator hidden pending rework — was: !row.baked
  $("candles-card").hidden = !row.baked;
  $("detail-title").textContent = `${row.name} (${row.sym})`;
  $("detail-sub").innerHTML = !row.baked
    ? `Perp <b>${row.coin}</b> on Hyperliquid${row.dex ? ` builder dex <b>${row.dex}</b>` : ""}. Live funding only — no candle, options or strategy data is baked for this asset.`
    : row.kind === "crypto"
    ? `Perp <b>${row.coin}</b> on Hyperliquid (main dex). Crypto asset — hedge by holding spot ${row.sym} on any exchange.`
    : `Perp <b>${row.coin}</b> on Hyperliquid vs ${row.sym} on the stock exchange.` +
      (row.hasOptions ? "" : " <b>No listed options for this name</b> — hedge with the real stock only.");
  renderAbout(row);
  $("detail").scrollIntoView({ behavior: "smooth" });
  renderOverview();

  // Baked data (candles, options) arrives in well under a second; the live
  // funding history can take ~15s of paced API calls on a cold cache.
  // Render each piece the moment its data is ready.
  $("funding-tiles").innerHTML =
    `<div class="loading"><span class="spin"></span>fetching this ticker's full funding history from Hyperliquid — first visit takes ~15 seconds, instant after that…</div>`;
  $("stability-tiles").innerHTML = "";

  const histP = loadFullHistory(coin);
  let options = null;
  if (row.baked) {
    let ohlc;
    [ohlc, options] = await Promise.all([
      getOhlc(row.yahoo).catch(() => null),
      row.hasOptions ? getOptions(row.yahoo).catch(() => null)
        : row.kind === "crypto" ? getDeribitOptions(row.sym).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (state.selected !== coin) return; // user moved on while we fetched

    $("candles-title").textContent = `${row.sym} — daily candles`;
    $("candles-sub").textContent = row.kind === "crypto"
      ? "Daily candles from Hyperliquid's own candle API (refreshed daily)."
      : "The real stock on the real exchange (Yahoo Finance daily data, refreshed after each US close).";
    state.calc.options = options;
    state.calc.ohlc = ohlc;
    fundingOverlayChip.disabled = !state.histories.has(coin);
    drawCandles(row);
    if (options) chain.load(options);
    if (row.kind === "crypto") {
      // Crypto chains come live from Deribit: reveal the section only once a
      // chain actually exists (BTC/ETH yes, HYPE no — Deribit doesn't list it).
      $("options").hidden = !options;
      if (options) $("detail-sub").innerHTML +=
        ` Deribit lists options on <b>${row.sym}</b> — chain and option-hedged variants below.`;
    }
    initCalculator(row, options);
  } else {
    state.calc.options = null;
    state.calc.ohlc = null;
  }

  const hist = await histP;
  if (state.selected !== coin) return; // user moved on while we fetched
  fundingOverlayChip.disabled = !hist;
  if (row.baked && hist && state.overlays.funding) drawCandles(row);

  if (hist) {
    const w = state.windows.get(coin);
    const tile = (lbl, wnd, note) => `
      <div class="tile"><span class="lbl">${lbl}</span>
        <span class="val ${aprClass(wnd.apr)}">${fmtAprPct(wnd.apr)}</span>
        <span class="sub">${wnd.partialDays != null
          ? `only ${wnd.partialDays}d of data · ${fmtAprPct(wnd.sum, 3)} over window`
          : note ?? `${fmtAprPct(wnd.sum, 3)} over the window`}</span></div>`;
    $("funding-tiles").innerHTML =
      tile("Latest hour", w.h1, "annualized") +
      tile("Last 8 hours", w.h8) +
      tile("Last 24 hours", w.h24) +
      tile("Last 7 days", w.d7) +
      tile("Last 30 days", w.d30) +
      tile("Last 60 days", w.d60) +
      tile("Last 90 days", w.d90) +
      `<div class="tile"><span class="lbl">Since ${hist.t.length ? new Date(hist.t[0]).toISOString().slice(0, 10) : "listing"}</span>
        <span class="val ${aprClass(w.all.sum)}">${fmtAprPct(w.all.sum, 1)}</span>
        <span class="sub">total collected · ${fmtAprPct(w.all.apr)} annualized</span></div>`;

    const s = stabilityStats(hist);
    const sTile = (lbl, val, sub, cls = "muted") => `
      <div class="tile"><span class="lbl">${lbl}</span>
        <span class="val ${cls}">${val}</span>
        ${sub ? `<span class="sub">${sub}</span>` : ""}</div>`;
    const cov = p => p != null ? `only ${p}d of data` : "";
    $("stability-tiles").innerHTML =
      sTile("Mean APR — 7d", fmtAprPct(s.mean7), cov(s.part7), aprClass(s.mean7)) +
      sTile("Mean APR — 30d", fmtAprPct(s.mean30), cov(s.part30), aprClass(s.mean30)) +
      sTile("Mean APR — 60d", fmtAprPct(s.mean60), cov(s.part60), aprClass(s.mean60)) +
      sTile("Mean APR — 90d", fmtAprPct(s.mean90), cov(s.part90), aprClass(s.mean90)) +
      sTile("Mean APR — all history", fmtAprPct(s.meanAll), `${hist.t.length.toLocaleString()} hourly records`, aprClass(s.meanAll)) +
      sTile("Hours positive", s.posShare === null ? "—" : (s.posShare * 100).toFixed(0) + "%",
        "share of hours shorts collected", s.posShare === null ? "muted" : s.posShare >= 0.7 ? "num-pos" : "num-neg") +
      sTile("Worst 7-day stretch", fmtPct(s.worst7), "lowest rolling 7d take, % of position", aprClass(s.worst7)) +
      sTile("Worst 30-day stretch", fmtPct(s.worst30), "lowest rolling 30d take, % of position", aprClass(s.worst30)) +
      sTile("APR volatility (ann.)", s.aprVol === null ? "—" : (s.aprVol * 100).toFixed(1) + "%",
        "std dev of daily funding, annualized");

    renderFundingChart($("funding-chart"), annualizedSeries(hist));
    legend($("funding-legend"), [[COLOR.pos, "shorts collect"], [COLOR.neg, "shorts pay"]]);
    renderCumulativeChart($("cumfunding-chart"), cumulativeSeries(hist));
    if (row.baked) initCalculator(row, options); // re-init so the APR default uses real windows
  } else {
    $("funding-tiles").innerHTML = `<div class="err">Couldn't load funding history right now — the live API may be rate-limiting. Try again in a minute.</div>`;
  }
}

/* ---------------- candle overlays ---------------- */
const OVERLAY_STYLE = {
  ema50: { label: "50 EMA", color: "#D9A441" },
  ema100: { label: "100 EMA", color: "#5B9BD3" },
  ema200: { label: "200 EMA", color: "#C9D8D2" },
  funding: { label: "funding APR (left axis)", color: COLOR.violet },
};

function drawCandles(row) {
  const ohlc = state.calc.ohlc;
  if (!ohlc) {
    clearChart($("candles-chart"));
    $("candles-legend").innerHTML = "";
    return;
  }
  const overlays = [];
  const items = [[COLOR.pos, "up day"], [COLOR.neg, "down day"]];
  for (const key of ["ema50", "ema100", "ema200"]) {
    if (!state.overlays[key]) continue;
    overlays.push({ data: emaSeries(ohlc.candles, parseInt(key.slice(3), 10)), color: OVERLAY_STYLE[key].color });
    items.push([OVERLAY_STYLE[key].color, OVERLAY_STYLE[key].label]);
  }
  const hist = state.histories.get(row.coin);
  if (state.overlays.funding && hist) {
    overlays.push({ data: dailyAprSeries(hist), color: OVERLAY_STYLE.funding.color, scale: "left" });
    items.push([OVERLAY_STYLE.funding.color, OVERLAY_STYLE.funding.label]);
  }
  renderCandles($("candles-chart"), ohlc.candles, overlays);
  legend($("candles-legend"), items);
}

const fundingOverlayChip = $("candle-overlays").querySelector('[data-ov="funding"]');
$("candle-overlays").querySelectorAll("[data-ov]").forEach(b => b.addEventListener("click", () => {
  state.overlays[b.dataset.ov] = !state.overlays[b.dataset.ov];
  b.setAttribute("aria-pressed", String(state.overlays[b.dataset.ov]));
  const row = state.rows.find(r => r.coin === state.selected);
  if (row) drawCandles(row);
}));

/* ---------------- options chain ---------------- */
const chain = initChain({
  selectEl: $("expiry-select"),
  tableEl: $("chain-tbl"),
  toggleEl: $("all-strikes"),
  infoEl: $("chain-info"),
});
/* ---------------- calculator ---------------- */
function initCalculator(row, options) {
  const w = state.windows.get(row.coin);
  const defaultApr = w?.d30?.apr ?? w?.all?.apr ?? nowApr(row) ?? 0;
  $("in-apr").value = (defaultApr * 100).toFixed(1);
  $("options-title").textContent = `${row.sym} options chain`;

  const pick = $("variant-pick");
  // Crypto rows hedge with spot instead of stock; with a live Deribit chain
  // they also get the two option-hedged variants, same math as equities.
  const labelOverride = row.kind === "crypto"
    ? { stock: { label: `Hold spot ${row.sym}`, small: "1 coin hedges 1 coin. Buy on any exchange." } }
    : {};
  if (row.kind === "crypto" && !options) {
    state.calc.variant = "stock";
    pick.innerHTML = `<button class="chip" data-variant="stock" aria-pressed="true">
      Hold spot ${row.sym}<small>1 coin hedges 1 coin. Buy on any exchange.</small></button>`;
  } else {
    pick.innerHTML = Object.entries(VARIANTS).map(([k, v]) => {
      const { label, small } = labelOverride[k] ?? v;
      const disabled = k !== "stock" && !options;
      return `<button class="chip" data-variant="${k}" aria-pressed="${state.calc.variant === k}" ${disabled ? "disabled" : ""}>
        ${label}<small>${small}</small></button>`;
    }).join("");
  }
  pick.querySelectorAll("[data-variant]").forEach(b => b.addEventListener("click", () => {
    state.calc.variant = b.dataset.variant;
    pick.querySelectorAll("[data-variant]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    if (state.calc.variant === "ditm") {
      const best = bestDitmExpiry(options, parseInt($("in-days").value, 10) || 30);
      if (best) $("in-expiry").value = best;
    }
    syncOptionPickers(row);
    recalc(row);
  }));
  if (!options) state.calc.variant = "stock";

  // option expiry / strike pickers
  if (options) {
    const usable = options.expiries.filter(e => e.dte > 0);
    $("in-expiry").innerHTML = usable.map(e => `<option value="${e.expiry}">${e.expiry} (${e.dte}d)</option>`).join("");
    const preferred = usable.find(e => e.dte >= 40 && e.dte <= 130) || usable[usable.length - 1];
    if (preferred) $("in-expiry").value = preferred.expiry;
    $("in-expiry").onchange = () => { syncOptionPickers(row); recalc(row); };
    $("in-strike").onchange = () => { state.calc.strike = parseFloat($("in-strike").value); recalc(row); };
  }
  syncOptionPickers(row);

  ["in-size", "in-days", "in-apr", "in-lev"].forEach(id => { $(id).oninput = () => recalc(row); });
  recalc(row);
}

// For the deep-ITM hedge, the cheapest expiry is the one whose time value,
// pro-rated over the holding period, costs the least — usually a long-dated one.
function bestDitmExpiry(options, days) {
  if (!options) return null;
  const spot = options.spot;
  let best = null, bestCost = Infinity;
  for (const e of options.expiries) {
    if (e.dte < Math.max(days * 0.8, 7)) continue;
    const deep = e.calls.filter(c => c.delta >= 0.9 && c.ask > 0);
    if (!deep.length) continue;
    const c = deep.reduce((a, b) => (b.delta < a.delta ? b : a));
    const tv = Math.max(c.ask - Math.max(spot - c.strike, 0), 0);
    const cost = tv * Math.min(days, e.dte) / e.dte;
    if (cost < bestCost) { bestCost = cost; best = e.expiry; }
  }
  return best;
}

function currentExpiryChain(row) {
  const options = state.calc.options;
  if (!options) return null;
  const exp = options.expiries.find(e => e.expiry === $("in-expiry").value) || options.expiries.find(e => e.dte > 0);
  return exp || null;
}

function syncOptionPickers(row) {
  const isOpt = state.calc.variant !== "stock";
  $("opt-expiry-wrap").style.display = isOpt ? "" : "none";
  $("opt-strike-wrap").style.display = isOpt ? "" : "none";
  if (!isOpt) return;
  const exp = currentExpiryChain(row);
  if (!exp) return;
  const spot = state.calc.options.spot || row.spot;
  const strikes = state.calc.variant === "ditm"
    ? exp.calls.filter(c => c.ask > 0).map(c => c.strike)
    : exp.calls.filter(c => c.ask > 0 && exp.puts.some(p => p.strike === c.strike && p.bid > 0)).map(c => c.strike);
  const def = defaultStrike(state.calc.variant, exp, spot);
  $("in-strike").innerHTML = strikes.map(k => `<option value="${k}">$${k}</option>`).join("");
  if (def !== null) $("in-strike").value = String(def);
  state.calc.strike = parseFloat($("in-strike").value);
}

function recalc(row) {
  const spot = state.calc.options?.spot || row.spot;
  const exp = state.calc.variant === "stock" ? null : currentExpiryChain(row);
  const calc = compute({
    variant: state.calc.variant,
    usd: parseFloat($("in-size").value) || 0,
    days: parseInt($("in-days").value, 10) || 30,
    apr: (parseFloat($("in-apr").value) || 0) / 100,
    leverage: parseInt($("in-lev").value, 10) || 2,
    spot,
    maxLeverage: row.ctx?.maxLeverage,
    expiryChain: exp ? { ...exp, pickedStrike: state.calc.strike } : null,
    contractMultiplier: state.calc.options?.contractMultiplier ?? 100,
  });

  if (!calc) {
    $("yield-big").textContent = "—";
    $("yield-frac").textContent = "This combination has no usable quotes right now.";
    $("yield-capital").textContent = "";
    $("ledger").innerHTML = "";
    renderRiskReward({ calc: null }, riskEls());
    return;
  }
  if (row.kind === "crypto") calc.legDesc = calc.legDesc.replace("shares", row.sym);

  const y = calc.annualized;
  $("yield-big").textContent = fmtUsd(calc.net);
  $("yield-big").className = "big " + aprClass(calc.net);
  const carryPart = calc.carry >= 0
    ? `minus ${fmtUsd(calc.carry)} hedge carry and ${fmtUsd(calc.fees)} perp fees`
    : `plus ${fmtUsd(-calc.carry)} carry credit, minus ${fmtUsd(calc.fees)} perp fees`;
  $("yield-frac").innerHTML =
    `= <b>${fmtUsd(calc.grossFunding)}</b> funding at ${$("in-apr").value}% APR on the <b>${fmtUsd(calc.notional)}</b> position over ${$("in-days").value} days, ${carryPart}`;
  $("yield-capital").innerHTML =
    `Yield on hedge cash (÷ ${fmtUsd(calc.denom)} to enter the hedge): <b class="${y === null ? "num-pos" : aprClass(y)}">${y === null ? "∞" : fmtAprPct(y)}</b> annualized · ` +
    `with ${fmtUsd(calc.perpMargin)} perp margin${calc.extraCollateral ? ` + ${fmtUsd(calc.extraCollateral)} put collateral` : ""}: <b class="${aprClass(calc.capitalAnnualized)}">${fmtAprPct(calc.capitalAnnualized)}</b>`;

  $("ledger").innerHTML = `
    <tr><td>Funding collected (${$("in-apr").value}% APR × ${$("in-days").value}d)</td><td class="num-pos">+${fmtUsd(calc.grossFunding)}</td></tr>
    <tr><td class="indent">Hedge carry (option time value used up)</td><td class="${calc.carry > 0 ? "num-neg" : "muted"}">${calc.carry >= 0 ? "−" + fmtUsd(calc.carry) : "+" + fmtUsd(-calc.carry)}</td></tr>
    <tr><td class="indent">Perp fees (enter + exit)</td><td class="num-neg">−${fmtUsd(calc.fees)}</td></tr>
    <tr class="total"><td>Net over the period</td><td class="${aprClass(calc.net)}">${fmtUsd(calc.net)}</td></tr>
    <tr><td>Cash to enter hedge leg (${calc.legDesc})</td><td>${fmtUsd(calc.denom)}</td></tr>`;

  const warn = calc.warnings.length ? `⚠ ${calc.warnings.join(" ")}` : "";
  $("calc-note").textContent = warn;

  renderRiskReward({
    calc,
    worst30d: state.histories.has(row.coin) ? worstRolling30d(state.histories.get(row.coin)) : null,
    coin: row.sym,
    kind: row.kind,
  }, riskEls());
}

const riskEls = () => ({
  rewardList: $("reward-list"), riskList: $("risk-list"),
  maxReward: $("max-reward"), maxRisk: $("max-risk"),
});

boot();
