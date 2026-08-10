import { getAssetCtxs, getFundingHistory, getRecentFunding } from "./hyperliquid.js";
import { getMeta, getOhlc, getOptions } from "./baked.js";
import {
  fundingWindows, annualizedSeries, cumulativeSeries, worstRolling30d,
  fmtAprPct, fmtUsd, HOURS_PER_YEAR,
} from "./funding.js";
import { renderFundingChart, renderCumulativeChart, renderCandles, legend } from "./charts.js";
import { initChain } from "./optionsTable.js";
import { VARIANTS, defaultStrike, compute } from "./strategy.js";
import { renderRiskReward } from "./riskpanel.js";

const $ = id => document.getElementById(id);
const COLOR = { pos: "#17A67E", neg: "#D9536F", violet: "#8B6FE8" };

const state = {
  meta: null,
  rows: [],               // joined baked+live ticker rows
  histories: new Map(),   // coin -> { t, r }
  windows: new Map(),     // coin -> fundingWindows result
  selected: null,
  sortKey: "nowApr", sortDir: -1,
  calc: { variant: "stock", expiry: null, strike: null, options: null, ohlc: null },
};

const aprClass = x => (x === null || x === undefined ? "muted" : x >= 0 ? "num-pos" : "num-neg");
const nowApr = row => (Number.isFinite(row.ctx?.funding) ? row.ctx.funding * HOURS_PER_YEAR : null);

/* ---------------- boot ---------------- */
async function boot() {
  let ctxs;
  try {
    [state.meta, ctxs] = await Promise.all([getMeta(), getAssetCtxs()]);
  } catch (e) {
    $("live-badge-text").textContent = "data failed to load — refresh to retry";
    $("live-badge").classList.remove("live");
    console.error(e);
    return;
  }
  $("live-badge-text").textContent = "live funding · Hyperliquid";
  const asOf = new Date(state.meta.generatedAt);
  $("baked-badge-text").textContent = `stocks & options as of ${asOf.toISOString().slice(0, 10)}`;

  state.rows = state.meta.tickers
    .map(t => ({ ...t, sym: t.coin.split(":")[1], ctx: ctxs.get(t.coin) }))
    .filter(t => t.ctx);

  renderBoard();
  renderOverview();
  refreshLoop();
  prefetchTopWindows();
}

async function refreshLoop() {
  // keep the "live" promise honest: refresh funding contexts every minute
  setInterval(async () => {
    try {
      const ctxs = await getAssetCtxs();
      state.rows.forEach(r => { r.ctx = ctxs.get(r.coin) || r.ctx; });
      renderBoard();
      renderOverview();
    } catch { /* transient */ }
  }, 60_000);
  setInterval(() => { $("board-time").textContent = new Date().toUTCString().slice(17, 25) + " UTC"; }, 1000);
}

/* ---------------- hero board ---------------- */
function renderBoard() {
  const top = [...state.rows]
    .filter(r => nowApr(r) !== null)
    .sort((a, b) => nowApr(b) - nowApr(a))
    .slice(0, 8);
  $("board-rows").innerHTML = top.map(r => `
    <button class="board-row" data-coin="${r.coin}">
      <span><span class="sym">${r.sym}</span><span class="nm">${r.name}</span></span>
      <span class="apr ${nowApr(r) >= 0 ? "pos" : "neg"}">${fmtAprPct(nowApr(r))}</span>
    </button>`).join("");
  $("board-rows").querySelectorAll("[data-coin]").forEach(el =>
    el.addEventListener("click", () => select(el.dataset.coin)));
}

/* ---------------- overview table ---------------- */
const COLS = [
  { key: "sym", label: "Ticker", sortable: true },
  { key: "spot", label: "Stock close", sortable: true },
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

  const rows = [...state.rows].sort((a, b) => {
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
      <td class="txt"><b>${r.sym}</b><span class="nm">${r.name}</span></td>
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

  const pending = state.rows.filter(r => !state.windows.has(r.coin)).length;
  $("overview-note").innerHTML = pending
    ? `Trailing columns are fetched live per ticker (${pending} remaining). <a href="#" id="load-all">Load all now</a> — takes a minute or two the first time; cached after that.`
    : "All trailing windows loaded from live Hyperliquid history.";
  const la = $("load-all");
  if (la) la.addEventListener("click", async e => {
    e.preventDefault(); la.replaceWith("loading…");
    for (const r of state.rows) await loadWindows(r.coin);
  });
}

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
  const top = [...state.rows].sort((a, b) => (nowApr(b) ?? -9) - (nowApr(a) ?? -9)).slice(0, 10);
  for (const r of top) {
    while (holdPrefetch > 0) await new Promise(res => setTimeout(res, 500));
    await loadWindows(r.coin);
  }
}

/* ---------------- ticker detail ---------------- */
async function select(coin) {
  const row = state.rows.find(r => r.coin === coin);
  if (!row) return;
  state.selected = coin;
  ["detail", "options", "strategy"].forEach(id => { $(id).hidden = false; });
  $("options").hidden = !row.hasOptions;
  $("detail-title").textContent = `${row.name} (${row.sym})`;
  $("detail-sub").innerHTML = `Perp <b>${row.coin}</b> on Hyperliquid vs ${row.sym} on the stock exchange.` +
    (row.hasOptions ? "" : " <b>No listed options for this name</b> — hedge with the real stock only.");
  $("detail").scrollIntoView({ behavior: "smooth" });
  renderOverview();

  // Baked data (candles, options) arrives in well under a second; the live
  // funding history can take ~15s of paced API calls on a cold cache.
  // Render each piece the moment its data is ready.
  $("funding-tiles").innerHTML =
    `<div class="loading"><span class="spin"></span>fetching this ticker's full funding history from Hyperliquid — first visit takes ~15 seconds, instant after that…</div>`;

  const histP = loadFullHistory(coin);
  const [ohlc, options] = await Promise.all([
    getOhlc(row.yahoo).catch(() => null),
    row.hasOptions ? getOptions(row.yahoo).catch(() => null) : Promise.resolve(null),
  ]);

  if (ohlc) {
    $("candles-title").textContent = `${row.sym} — daily candles`;
    renderCandles($("candles-chart"), ohlc.candles);
    legend($("candles-legend"), [[COLOR.pos, "up day"], [COLOR.neg, "down day"]]);
  }
  state.calc.options = options;
  state.calc.ohlc = ohlc;
  if (options) chain.load(options);
  initCalculator(row, options);

  const hist = await histP;
  if (state.selected !== coin) return; // user moved on while we fetched

  if (hist) {
    const w = state.windows.get(coin);
    const tile = (lbl, wnd, note) => `
      <div class="tile"><span class="lbl">${lbl}</span>
        <span class="val ${aprClass(wnd.apr)}">${fmtAprPct(wnd.apr)}</span>
        <span class="sub">${note ?? `${fmtAprPct(wnd.sum, 3)} over the window`}</span></div>`;
    $("funding-tiles").innerHTML =
      tile("Latest hour", w.h1, "annualized") +
      tile("Last 8 hours", w.h8) +
      tile("Last 24 hours", w.h24) +
      tile("Last 7 days", w.d7) +
      tile("Last 30 days", w.d30) +
      `<div class="tile"><span class="lbl">Since listing</span>
        <span class="val ${aprClass(w.all.sum)}">${fmtAprPct(w.all.sum, 1)}</span>
        <span class="sub">total collected · ${fmtAprPct(w.all.apr)} annualized</span></div>`;

    renderFundingChart($("funding-chart"), annualizedSeries(hist));
    legend($("funding-legend"), [[COLOR.pos, "shorts collect"], [COLOR.neg, "shorts pay"]]);
    renderCumulativeChart($("cumfunding-chart"), cumulativeSeries(hist));
    initCalculator(row, options); // re-init so the APR default uses real windows
  } else {
    $("funding-tiles").innerHTML = `<div class="err">Couldn't load funding history right now — the live API may be rate-limiting. Try again in a minute.</div>`;
  }
}

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
  pick.innerHTML = Object.entries(VARIANTS).map(([k, v]) => {
    const disabled = k !== "stock" && !options;
    return `<button class="chip" data-variant="${k}" aria-pressed="${state.calc.variant === k}" ${disabled ? "disabled" : ""}>
      ${v.label}<small>${v.small}</small></button>`;
  }).join("");
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
  });

  if (!calc) {
    $("yield-big").textContent = "—";
    $("yield-frac").textContent = "This combination has no usable quotes right now.";
    $("yield-capital").textContent = "";
    $("ledger").innerHTML = "";
    renderRiskReward({ calc: null }, riskEls());
    return;
  }

  const y = calc.annualized;
  $("yield-big").textContent = y === null ? "∞" : fmtAprPct(y);
  $("yield-big").className = "big " + (y === null ? "num-pos" : aprClass(y));
  $("yield-frac").innerHTML =
    `= <b>${fmtUsd(calc.net)}</b> net funding over ${$("in-days").value} days ÷ <b>${fmtUsd(calc.denom)}</b> to enter the hedge (${calc.legDesc}), annualized`;
  $("yield-capital").innerHTML =
    `Capital basis (adds ${fmtUsd(calc.perpMargin)} perp margin${calc.extraCollateral ? ` + ${fmtUsd(calc.extraCollateral)} put collateral` : ""}): <b class="${aprClass(calc.capitalAnnualized)}">${fmtAprPct(calc.capitalAnnualized)}</b> annualized`;

  $("ledger").innerHTML = `
    <tr><td>Funding collected (${$("in-apr").value}% APR × ${$("in-days").value}d)</td><td class="num-pos">+${fmtUsd(calc.grossFunding)}</td></tr>
    <tr><td class="indent">Hedge carry (option time value used up)</td><td class="${calc.carry > 0 ? "num-neg" : "muted"}">${calc.carry >= 0 ? "−" + fmtUsd(calc.carry) : "+" + fmtUsd(-calc.carry)}</td></tr>
    <tr><td class="indent">Perp fees (enter + exit)</td><td class="num-neg">−${fmtUsd(calc.fees)}</td></tr>
    <tr class="total"><td>Net over the period</td><td class="${aprClass(calc.net)}">${fmtUsd(calc.net)}</td></tr>
    <tr><td>Cash to enter hedge leg (the denominator)</td><td>${fmtUsd(calc.denom)}</td></tr>`;

  const warn = calc.warnings.length ? `⚠ ${calc.warnings.join(" ")}` : "";
  $("calc-note").textContent = warn;

  renderRiskReward({
    calc,
    worst30d: state.histories.has(row.coin) ? worstRolling30d(state.histories.get(row.coin)) : null,
    coin: row.sym,
  }, riskEls());
}

const riskEls = () => ({
  rewardList: $("reward-list"), riskList: $("risk-list"),
  maxReward: $("max-reward"), maxRisk: $("max-risk"),
});

boot();
