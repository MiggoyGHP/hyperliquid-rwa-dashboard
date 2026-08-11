// Live client for Hyperliquid's public info API (CORS-open, no key needed).
import { DEXES } from "./classify.js";

const API = "https://api.hyperliquid.xyz/info";
const PAGE = 500; // fundingHistory returns at most 500 hourly records per call
const CACHE_PREFIX = "fh1:"; // bump the prefix to invalidate old cache layouts
const MAX_CACHED = 12; // localStorage is ~5 MB; each ticker ~120 KB

async function request(body) {
  for (let attempt = 0; ; attempt++) {
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
}

// Hyperliquid's public rate limit is weight-based (~1200/min per IP).
// fundingHistory-type requests are heavy, so they pace to ~1 call/second;
// metaAndAssetCtxs snapshots are cheap and get their own faster lane so
// polling 9 dexes doesn't starve history fetches.
function makeLane(spacingMs) {
  let queue = Promise.resolve();
  let lastCall = 0;
  return body => {
    const run = async () => {
      const wait = lastCall + spacingMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastCall = Date.now();
      return request(body);
    };
    // serialize all calls through one queue so parallel callers still pace
    const p = queue.then(run);
    queue = p.catch(() => {});
    return p;
  };
}
const post = makeLane(1100);      // fundingHistory
const postLight = makeLane(250);  // metaAndAssetCtxs

// Every asset's live context (mark price, current hourly funding, …) across
// the main dex (BTC/ETH/HYPE, bare names) and every HIP-3 builder dex
// (prefixed names like "xyz:TSLA"). Keys never collide. Calls onPartial with
// the growing map after each dex arrives so callers can render progressively.
export async function getAssetCtxs(onPartial) {
  const out = new Map();
  const addAll = ([meta, ctxs]) => meta.universe.forEach((asset, i) => {
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
  const results = await Promise.allSettled(DEXES.map(dex =>
    postLight({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) })
      .then(res => { addAll(res); onPartial?.(out); })
  ));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.warn(`metaAndAssetCtxs failed for dex "${DEXES[i] || "main"}"`, r.reason);
  });
  if (out.size === 0) throw new Error("all metaAndAssetCtxs requests failed");
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
