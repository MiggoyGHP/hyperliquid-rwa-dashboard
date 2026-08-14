// Funding-window math. Input: { t: [ms…], r: [hourly decimal rate…] } ascending.

export const HOURS_PER_YEAR = 24 * 365;

// Simple sum of hourly rates in [since, now] as a decimal (compounding is
// negligible at funding magnitudes; stated in the methodology).
// partialDays: days of data actually available when history starts after the
// window does (so the mean can be flagged as partial), else null. The 1-hour
// slack keeps an asset exactly N days old from being flagged.
function windowStats(hist, sinceMs, nowMs = Date.now()) {
  let sum = 0, n = 0;
  for (let i = hist.t.length - 1; i >= 0 && hist.t[i] >= sinceMs; i--) {
    sum += hist.r[i];
    n++;
  }
  const partialDays = hist.t.length && sinceMs > 0 && hist.t[0] > sinceMs + 3600e3
    ? Math.max(1, Math.round((nowMs - hist.t[0]) / 864e5)) : null;
  return { sum, n, apr: n ? (sum / n) * HOURS_PER_YEAR : null, partialDays };
}

export function fundingWindows(hist, nowMs = Date.now()) {
  const H = 3600e3;
  const latest = hist.r.length ? hist.r[hist.r.length - 1] : null;
  return {
    h1: { sum: latest ?? 0, n: latest === null ? 0 : 1, apr: latest === null ? null : latest * HOURS_PER_YEAR },
    h8: windowStats(hist, nowMs - 8 * H, nowMs),
    h24: windowStats(hist, nowMs - 24 * H, nowMs),
    d7: windowStats(hist, nowMs - 7 * 24 * H, nowMs),
    d30: windowStats(hist, nowMs - 30 * 24 * H, nowMs),
    d60: windowStats(hist, nowMs - 60 * 24 * H, nowMs),
    d90: windowStats(hist, nowMs - 90 * 24 * H, nowMs),
    all: windowStats(hist, 0, nowMs),
  };
}

// Series for charts.
export function annualizedSeries(hist) {
  return hist.t.map((t, i) => ({ time: Math.floor(t / 1000), value: hist.r[i] * HOURS_PER_YEAR * 100 }));
}

export function cumulativeSeries(hist) {
  let acc = 0;
  return hist.t.map((t, i) => {
    acc += hist.r[i];
    return { time: Math.floor(t / 1000), value: acc * 100 };
  });
}

// Daily mean funding APR (%) keyed by UTC date. Daily buckets, not hourly
// points: this overlays on daily candles, and mixing hourly times into the
// shared time scale would space the candles out to slivers.
export function dailyAprSeries(hist) {
  const D = 24 * 3600e3;
  const byDay = new Map();
  hist.t.forEach((t, i) => {
    const d = Math.floor(t / D);
    const slot = byDay.get(d) || { sum: 0, n: 0 };
    slot.sum += hist.r[i];
    slot.n++;
    byDay.set(d, slot);
  });
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, { sum, n }]) => ({
      time: new Date(d * D).toISOString().slice(0, 10),
      value: (sum / n) * HOURS_PER_YEAR * 100,
    }));
}

// Worst funding stretch a short actually lived through: minimum rolling
// N-day sum of hourly rates, as a decimal. Positive result => never bad.
// Returns null when the history is shorter than the window.
export function worstRolling(hist, days) {
  const W = days * 24 * 3600e3;
  if (!hist.t.length) return null;
  let worst = Infinity, sum = 0, lo = 0;
  for (let hi = 0; hi < hist.t.length; hi++) {
    sum += hist.r[hi];
    while (hist.t[lo] < hist.t[hi] - W) { sum -= hist.r[lo]; lo++; }
    if (hist.t[hi] - hist.t[0] >= W && sum < worst) worst = sum;
  }
  return worst === Infinity ? null : worst;
}

export const worstRolling30d = hist => worstRolling(hist, 30);

// Stability lens on a funding stream: is the mean persistent across windows,
// how often does it flip negative, what was the worst stretch, and how noisy
// is the day-to-day take. All rates are decimals in APR units except posShare.
export function stabilityStats(hist, nowMs = Date.now()) {
  const D = 24 * 3600e3;
  const w = days => windowStats(hist, nowMs - days * D, nowMs);
  const w7 = w(7), w30 = w(30), w60 = w(60), w90 = w(90);
  const n = hist.r.length;
  const posShare = n ? hist.r.filter(r => r > 0).length / n : null;

  // Volatility of the stream: std dev of daily funding sums, annualized (√365).
  const byDay = new Map();
  hist.t.forEach((t, i) => {
    const d = Math.floor(t / D);
    byDay.set(d, (byDay.get(d) || 0) + hist.r[i]);
  });
  const daily = [...byDay.values()];
  let aprVol = null;
  if (daily.length >= 2) {
    const m = daily.reduce((a, b) => a + b, 0) / daily.length;
    aprVol = Math.sqrt(daily.reduce((a, b) => a + (b - m) ** 2, 0) / daily.length) * Math.sqrt(365);
  }

  return {
    mean7: w7.apr, mean30: w30.apr, mean60: w60.apr, mean90: w90.apr,
    part7: w7.partialDays, part30: w30.partialDays, part60: w60.partialDays, part90: w90.partialDays,
    meanAll: windowStats(hist, 0, nowMs).apr,
    posShare,
    worst7: worstRolling(hist, 7),
    worst30: worstRolling(hist, 30),
    aprVol,
  };
}

export const fmtPct = (x, dp = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(dp)}%`;

export const fmtAprPct = (x, dp = 1) =>
  x === null || x === undefined || Number.isNaN(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(dp)}%`;

export const fmtUsd = (x, dp = 0) =>
  x === null || x === undefined || Number.isNaN(x) ? "—"
    : (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const fmtCompactUsd = x => {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x), s = x < 0 ? "-$" : "$";
  if (a >= 1e9) return s + (a / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(0) + "K";
  return s + a.toFixed(0);
};
