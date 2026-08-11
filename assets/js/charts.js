// Thin wrappers around TradingView lightweight-charts v4 (global from CDN).
const LWC = window.LightweightCharts;

const COLOR = {
  pos: "#17A67E",
  neg: "#D9536F",
  violet: "#8B6FE8",
  ink2: "#9DB8AE",
  ink3: "#6E877D",
  grid: "rgba(42, 74, 64, 0.45)",
  posFill: "rgba(23, 166, 126, 0.22)",
  negFill: "rgba(217, 83, 111, 0.22)",
};

const BASE_OPTS = {
  layout: {
    background: { type: "solid", color: "transparent" },
    textColor: COLOR.ink2,
    fontFamily: "'Spline Sans Mono', monospace",
    fontSize: 11,
  },
  grid: {
    vertLines: { color: "transparent" },
    horzLines: { color: COLOR.grid },
  },
  rightPriceScale: { borderVisible: false },
  timeScale: { borderVisible: false },
  crosshair: {
    horzLine: { labelBackgroundColor: "#16302A" },
    vertLine: { labelBackgroundColor: "#16302A" },
  },
  handleScroll: { mouseWheel: false },
  autoSize: true,
};

const charts = new Map(); // container id -> chart, so re-renders replace cleanly

function freshChart(el, extra = {}) {
  const prev = charts.get(el.id);
  if (prev) prev.remove();
  const chart = LWC.createChart(el, { ...BASE_OPTS, ...extra });
  charts.set(el.id, chart);
  return chart;
}

// ~6,500 hourly points must fit on a laptop width; the default minBarSpacing
// (0.5px) silently caps zoom-out at ~900 points.
const HOURLY_TIMESCALE = { ...BASE_OPTS.timeScale, timeVisible: true, minBarSpacing: 0.001 };

// Hourly funding, annualized %, with a zero line: above = shorts collect.
export function renderFundingChart(el, points) {
  const chart = freshChart(el, { timeScale: HOURLY_TIMESCALE });
  const series = chart.addBaselineSeries({
    baseValue: { type: "price", price: 0 },
    topLineColor: COLOR.pos, topFillColor1: COLOR.posFill, topFillColor2: "transparent",
    bottomLineColor: COLOR.neg, bottomFillColor1: "transparent", bottomFillColor2: COLOR.negFill,
    lineWidth: 2,
    priceFormat: { type: "custom", formatter: v => v.toFixed(1) + "%" },
  });
  series.setData(points);
  series.createPriceLine({ price: 0, color: COLOR.ink3, lineWidth: 1, lineStyle: 3, axisLabelVisible: false });
  chart.timeScale().fitContent();
  return chart;
}

// Cumulative % collected since listing.
export function renderCumulativeChart(el, points) {
  const chart = freshChart(el, { timeScale: HOURLY_TIMESCALE });
  const series = chart.addAreaSeries({
    lineColor: COLOR.pos, topColor: COLOR.posFill, bottomColor: "transparent",
    lineWidth: 2,
    priceFormat: { type: "custom", formatter: v => v.toFixed(1) + "%" },
  });
  series.setData(points);
  series.createPriceLine({ price: 0, color: COLOR.ink3, lineWidth: 1, lineStyle: 3, axisLabelVisible: false });
  chart.timeScale().fitContent();
  return chart;
}

// Exponential moving average of daily closes; SMA-seeded, plotted from the
// first bar where the window is full.
export function emaSeries(candles, period) {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((a, c) => a + c.c, 0) / period;
  const out = [{ time: candles[period - 1].t, value: ema }];
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].c * k + ema * (1 - k);
    out.push({ time: candles[i].t, value: ema });
  }
  return out;
}

// Daily OHLC candles plus optional line overlays: { data, color, scale? }.
// scale "left" gets its own %-formatted axis (used for the funding overlay).
export function renderCandles(el, candles, overlays = []) {
  const hasLeft = overlays.some(o => o.scale === "left");
  const chart = freshChart(el, hasLeft ? { leftPriceScale: { visible: true, borderVisible: false } } : {});
  const series = chart.addCandlestickSeries({
    upColor: COLOR.pos, downColor: COLOR.neg,
    wickUpColor: COLOR.pos, wickDownColor: COLOR.neg,
    borderVisible: false,
  });
  series.setData(candles.map(c => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));
  for (const o of overlays) {
    const line = chart.addLineSeries({
      color: o.color, lineWidth: 1.5,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      ...(o.scale === "left"
        ? { priceScaleId: "left", priceFormat: { type: "custom", formatter: v => v.toFixed(0) + "%" } }
        : {}),
    });
    line.setData(o.data);
  }
  chart.timeScale().fitContent();
  return chart;
}

export function clearChart(el) {
  const prev = charts.get(el.id);
  if (prev) { prev.remove(); charts.delete(el.id); }
}

export function legend(el, items) {
  el.innerHTML = items
    .map(([color, label]) => `<span><span class="sw" style="background:${color}"></span>${label}</span>`)
    .join("");
}
