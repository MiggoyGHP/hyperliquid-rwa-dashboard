// Live client for Hyperliquid's public info API (CORS-open, no key needed).
const API = "https://api.hyperliquid.xyz/info";
const DEX = "xyz";
const PAGE = 500; // fundingHistory returns at most 500 hourly records per call
const CACHE_PREFIX = "fh1:"; // bump the prefix to invalidate old cache layouts
const MAX_CACHED = 12; // localStorage is ~5 MB; each ticker ~120 KB

// Hyperliquid's public rate limit is weight-based (~1200/min per IP) and
// fundingHistory-type requests are heavy, so pace to ~1 call/second and back
// off hard on 429.
let queue = Promise.resolve();
let lastCall = 0;
function post(body) {
  const run = async () => {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    for (let attempt = 0; ; attempt++) {
      lastCall = Date.now();
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      if (attempt >= 4) throw new Error(`Hyperliquid API ${res.status}`);
      const backoff = res.status === 429 ? 4000 * (attempt + 1) : 1000 * (attempt + 1);
      await new Promise(r => setTimeout(r, backoff));
    }
  };
  // serialize all calls through one queue so parallel callers still pace
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
}

// One call: every xyz asset's live context (mark price, current hourly funding, …)
export async function getAssetCtxs() {
  const [meta, ctxs] = await post({ type: "metaAndAssetCtxs", dex: DEX });
  const out = new Map();
  meta.universe.forEach((asset, i) => {
    if (asset.isDelisted) return;
    const ctx = ctxs[i] || {};
    out.set(asset.name, {
      coin: asset.name,
      maxLeverage: asset.maxLeverage || 3,
      markPx: parseFloat(ctx.markPx),
      funding: parseFloat(ctx.funding), // current hourly rate (decimal)
      premium: parseFloat(ctx.premium),
      openInterest: parseFloat(ctx.openInterest),
      dayNtlVlm: parseFloat(ctx.dayNtlVlm),
    });
  });
  return out;
}

function readCache(coin) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + coin);
    if (!raw) return null;
    const { t, r } = JSON.parse(raw);
    if (!Array.isArray(t) || t.length !== r.length) return null;
    return { t, r };
  } catch { return null; }
}

function writeCache(coin, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + coin, JSON.stringify(data));
    // LRU bookkeeping
    const key = CACHE_PREFIX + "lru";
    const lru = (JSON.parse(localStorage.getItem(key)) || []).filter(c => c !== coin);
    lru.push(coin);
    while (lru.length > MAX_CACHED) {
      localStorage.removeItem(CACHE_PREFIX + lru.shift());
    }
    localStorage.setItem(key, JSON.stringify(lru));
  } catch { /* quota exceeded: live without the cache */ }
}

// Last ~30 days of funding only (2 pages) — enough for the overview table's
// trailing windows without burning the rate budget. In-memory for the session.
const recentCache = new Map();
export async function getRecentFunding(coin) {
  if (recentCache.has(coin)) return recentCache.get(coin);
  const full = readCache(coin);
  if (full && full.t.length) { recentCache.set(coin, full); return full; } // full history already cached
  const out = { t: [], r: [] };
  let startTime = Date.now() - 31 * 24 * 3600e3;
  for (let page = 0; page < 4; page++) {
    const batch = await post({ type: "fundingHistory", coin, startTime });
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const rec of batch) { out.t.push(rec.time); out.r.push(parseFloat(rec.fundingRate)); }
    if (batch.length < PAGE) break;
    startTime = batch[batch.length - 1].time + 1;
  }
  recentCache.set(coin, out);
  return out;
}

// Full hourly funding history for one coin, since listing.
// Cached in localStorage; revisits only fetch the new tail.
export async function getFundingHistory(coin, onProgress) {
  const cached = readCache(coin) || { t: [], r: [] };
  let startTime = cached.t.length ? cached.t[cached.t.length - 1] + 1
                                  : Date.parse("2025-10-01T00:00:00Z");
  for (let page = 0; page < 40; page++) {
    const batch = await post({ type: "fundingHistory", coin, startTime });
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const rec of batch) {
      cached.t.push(rec.time);
      cached.r.push(parseFloat(rec.fundingRate));
    }
    onProgress?.(cached.t.length);
    if (batch.length < PAGE) break;
    startTime = batch[batch.length - 1].time + 1;
  }
  writeCache(coin, cached);
  return cached; // { t: [ms…], r: [hourly rate…] } ascending
}
