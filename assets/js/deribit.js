// Live client for Deribit's public options API (CORS-open, no key needed).
// Emits the same JSON shape as the baked Cboe chains (data/options/*.json)
// so the chain table and calculator consume it unchanged — plus
// contractMultiplier: 1 (Deribit BTC/ETH contracts are 1 coin, not 100 shares).

const API = "https://www.deribit.com/api/v2/";
const TTL_MS = 60_000; // quotes go stale fast; refetch after a minute

// Deribit answers unsupported currencies with HTTP 200 + a JSON-RPC error
// (code -32602, invalid params) — that means "no chain here", not "try again".
class NoChainError extends Error {}

async function request(path, params) {
  const url = API + path + "?" + new URLSearchParams(params);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      if (!json.error) return json.result;
      if (json.error.code === -32602) throw new NoChainError(json.error.message);
      if (attempt >= 4) throw new Error(`Deribit API error ${json.error.code}`);
    } else if (attempt >= 4) {
      throw new Error(`Deribit API ${res.status}`);
    }
    const backoff = res.status === 429 ? 4000 * (attempt + 1) : 1000 * (attempt + 1);
    await new Promise(r => setTimeout(r, backoff));
  }
}

// One paced lane (same pattern as hyperliquid.js) so a burst of coin clicks
// doesn't spam Deribit; 300ms spacing is well inside their public limits.
function makeLane(spacingMs) {
  let queue = Promise.resolve();
  let lastCall = 0;
  return (path, params) => {
    const run = async () => {
      const wait = lastCall + spacingMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastCall = Date.now();
      return request(path, params);
    };
    const p = queue.then(run);
    queue = p.catch(() => {});
    return p;
  };
}
const get = makeLane(300);

/* ---- Black-Scholes call delta (port of scripts/black_scholes.py) ---- */
// JS has no Math.erf; Abramowitz–Stegun 7.1.26 is accurate to ~1.5e-7.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
const normCdf = x => 0.5 * (1 + erf(x / Math.SQRT2));

function callDelta(spot, strike, tYears, iv, r) {
  if (!(spot > 0) || !(strike > 0)) return null;
  if (tYears <= 0) return spot > strike ? 1 : 0;
  if (iv === null || Number.isNaN(iv) || iv < 0.005) return null;
  const d1 = (Math.log(spot / strike) + (r + iv * iv / 2) * tYears) / (iv * Math.sqrt(tYears));
  return normCdf(d1);
}

/* ---- chain assembly ---- */
async function fetchChain(sym) {
  let instruments;
  try {
    instruments = await get("public/get_instruments", { currency: sym, kind: "option", expired: "false" });
  } catch (e) {
    if (e instanceof NoChainError) return null; // currency not listed on Deribit
    throw e;
  }
  if (!Array.isArray(instruments) || instruments.length === 0) return null;

  const [summaries, index] = await Promise.all([
    get("public/get_book_summary_by_currency", { currency: sym, kind: "option" }),
    get("public/get_index_price", { index_name: `${sym.toLowerCase()}_usd` }),
  ]);
  const indexPrice = index?.index_price;
  if (!indexPrice) return null;
  const summaryByName = new Map(summaries.map(s => [s.instrument_name, s]));

  const now = Date.now();
  const groups = new Map(); // expiration_timestamp -> { calls, puts }
  for (const inst of instruments) {
    const expTs = inst.expiration_timestamp;
    if (!(expTs > now)) continue;
    const s = summaryByName.get(inst.instrument_name);
    if (!s) continue;
    // Deribit quotes premiums, volume and OI in coin; convert prices to USD
    // so downstream math matches the baked equity chains. mark_iv is a percent.
    const iv = s.mark_iv == null ? null : s.mark_iv / 100;
    const tYears = (expTs - now) / (365 * 86400e3);
    const cd = callDelta(s.underlying_price || indexPrice, inst.strike, tYears, iv, 0);
    const row = {
      strike: inst.strike,
      bid: s.bid_price == null ? null : s.bid_price * indexPrice,
      ask: s.ask_price == null ? null : s.ask_price * indexPrice,
      last: s.last == null ? null : s.last * indexPrice,
      volume: s.volume ?? null,
      oi: s.open_interest ?? null,
      iv,
      delta: cd === null ? null : inst.option_type === "call" ? cd : cd - 1,
    };
    let g = groups.get(expTs);
    if (!g) groups.set(expTs, (g = { calls: [], puts: [] }));
    (inst.option_type === "call" ? g.calls : g.puts).push(row);
  }

  const expiries = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([expTs, g]) => ({
      expiry: new Date(expTs).toISOString().slice(0, 10),
      dte: Math.max(0, Math.round((expTs - now) / 86400e3)),
      calls: g.calls.sort((a, b) => a.strike - b.strike),
      puts: g.puts.sort((a, b) => a.strike - b.strike),
    }));
  if (!expiries.length) return null;

  return {
    symbol: sym,
    spot: indexPrice,
    riskFreeRate: 0,
    source: "deribit-live",
    generatedAt: new Date().toISOString(),
    contractMultiplier: 1,
    expiries,
  };
}

// Chain per coin, cached: 60s for live chains, all session for coins Deribit
// doesn't list (they won't sprout a chain mid-visit), evicted on failure.
const cache = new Map(); // sym -> { ts, permanent, promise }
export function getDeribitOptions(sym) {
  const hit = cache.get(sym);
  if (hit && (hit.permanent || Date.now() - hit.ts < TTL_MS)) return hit.promise;
  const entry = { ts: Date.now(), permanent: false };
  entry.promise = fetchChain(sym)
    .then(chain => {
      if (chain === null) entry.permanent = true;
      return chain;
    })
    .catch(err => { cache.delete(sym); throw err; });
  cache.set(sym, entry);
  return entry.promise;
}
