"""Bake stock OHLC + options-chain JSON for the dashboard.

Data sources:
  - Yahoo Finance via yfinance: daily OHLC candles + risk-free rate (^IRX).
  - Cboe delayed quotes API: options chains (bid/ask/IV/OI/volume + greeks).
    Yahoo's free options feed stopped returning bid/ask/OI (verified 2026-08),
    so Cboe is the options source of truth. Cboe supplies delta directly;
    Black-Scholes is only a fallback for rows missing it.
  - Hyperliquid public API: mark prices, used only to sanity-check the
    coin->Yahoo mapping.

Outputs (all under data/):
  meta.json           refresh timestamp, risk-free rate, ticker index, errors
  ohlc/<SYM>.json     ~2y of daily candles
  options/<SYM>.json  option chains with computed Black-Scholes delta

Failure policy: a ticker that fails keeps its previous good JSON (files are
only replaced on success). Exit code is 1 only if more than half of the
tickers failed (guards against committing a gutted dataset when Yahoo blocks
the runner wholesale).

Usage:
  python scripts/refresh_data.py                 # all tickers
  python scripts/refresh_data.py --tickers TSLA,NVDA,AAPL
"""
import argparse
import json
import math
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone, date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from tickers import TICKERS, EXCLUDED, NAMES, DEX, coin_name
from black_scholes import call_delta, put_delta

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PACE_SECONDS = 0.35
PRICE_MISMATCH_PCT = 12.0


def log(msg):
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


def with_retries(fn, attempts=3, backoff=2.0):
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 - deliberate catch-all with retry
            last = e
            if i < attempts - 1:
                time.sleep(backoff * (i + 1))
    raise last


def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def rnd(x, nd=2):
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    return round(x, nd)


def fetch_hl_marks():
    """coin (no prefix) -> mark price for live xyz assets."""
    req = urllib.request.Request(
        "https://api.hyperliquid.xyz/info",
        data=json.dumps({"type": "metaAndAssetCtxs", "dex": DEX}).encode(),
        headers={"Content-Type": "application/json"},
    )
    meta, ctxs = json.load(urllib.request.urlopen(req, timeout=30))
    marks, live_coins = {}, []
    for asset, ctx in zip(meta["universe"], ctxs):
        name = coin_name(asset["name"])
        if not asset.get("isDelisted"):
            live_coins.append(name)
            try:
                marks[name] = float(ctx["markPx"])
            except (KeyError, TypeError, ValueError):
                pass
    return marks, live_coins


def fetch_risk_free(yf):
    try:
        h = with_retries(lambda: yf.Ticker("^IRX").history(period="5d"))
        rate = float(h["Close"].dropna().iloc[-1]) / 100.0
        if 0.0 < rate < 0.15:
            return rate, "^IRX"
    except Exception:
        pass
    return 0.04, "fallback"


def bake_ohlc(yf, sym):
    hist = with_retries(lambda: yf.Ticker(sym).history(period="2y", interval="1d", auto_adjust=False))
    hist = hist.dropna(subset=["Close"])
    if hist.empty:
        raise RuntimeError("empty OHLC history")
    candles = [
        {
            "t": idx.strftime("%Y-%m-%d"),
            "o": rnd(row["Open"]), "h": rnd(row["High"]),
            "l": rnd(row["Low"]), "c": rnd(row["Close"]),
            "v": int(row["Volume"]) if row["Volume"] == row["Volume"] else 0,
        }
        for idx, row in hist.iterrows()
    ]
    spot = candles[-1]["c"]
    write_json(DATA / "ohlc" / f"{sym}.json", {
        "symbol": sym,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "candles": candles,
    })
    return spot


OCC_SYMBOL = re.compile(r"^[A-Z]+(\d{6})([CP])(\d{8})")


def fetch_cboe_chain(sym):
    url = f"https://cdn.cboe.com/api/global/delayed_quotes/options/{sym}.json"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(req, timeout=60))["data"]


def bake_options(sym, r, max_dte):
    data = with_retries(lambda: fetch_cboe_chain(sym))
    spot = float(data.get("current_price") or 0) or None
    today = date.today()
    by_expiry = {}
    for o in data.get("options", []):
        m = OCC_SYMBOL.match(o["option"])
        if not m:
            continue
        yymmdd, cp, k = m.groups()
        expiry = f"20{yymmdd[:2]}-{yymmdd[2:4]}-{yymmdd[4:6]}"
        strike = int(k) / 1000.0
        bid, ask, oi = rnd(o.get("bid")), rnd(o.get("ask")), int(o.get("open_interest") or 0)
        if not (bid or ask or oi):  # dead quote: no market, no interest
            continue
        dte = (date.fromisoformat(expiry) - today).days
        if dte < 0:
            continue
        iv = rnd(o.get("iv"), 4) or None
        delta = rnd(o.get("delta"), 4)
        if not delta and iv and spot:  # Cboe rarely omits delta; fall back to BS
            fn = call_delta if cp == "C" else put_delta
            delta = rnd(fn(spot, strike, max(dte, 0) / 365.0, iv, r), 4)
        row = {
            "strike": strike, "bid": bid, "ask": ask,
            "last": rnd(o.get("last_trade_price")) or None,
            "volume": int(o.get("volume") or 0), "oi": oi,
            "iv": iv, "delta": delta,
        }
        slot = by_expiry.setdefault(expiry, {"expiry": expiry, "dte": dte, "calls": [], "puts": []})
        slot["calls" if cp == "C" else "puts"].append(row)

    expiries = sorted(by_expiry.values(), key=lambda e: e["expiry"])
    keep = [e for e in expiries if e["dte"] <= max_dte]
    for e in expiries[-2:]:  # always keep the two longest-dated (LEAPs)
        if e not in keep:
            keep.append(e)
    for e in keep:
        e["calls"].sort(key=lambda x: x["strike"])
        e["puts"].sort(key=lambda x: x["strike"])
    if not keep:
        return 0
    write_json(DATA / "options" / f"{sym}.json", {
        "symbol": sym, "spot": spot, "riskFreeRate": rnd(r, 4),
        "source": "cboe-delayed",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "expiries": keep,
    })
    return len(keep)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", help="comma-separated coin subset, e.g. TSLA,NVDA")
    ap.add_argument("--max-dte", type=int, default=400)
    args = ap.parse_args()

    import yfinance as yf

    selected = {c: y for c, y in TICKERS.items()
                if not args.tickers or c in args.tickers.upper().split(",")}
    if not selected:
        sys.exit("no tickers selected")

    log(f"baking {len(selected)} tickers")
    try:
        hl_marks, live_coins = fetch_hl_marks()
    except Exception as e:
        log(f"WARN: Hyperliquid price check unavailable: {e}")
        hl_marks, live_coins = {}, []
    unmapped = sorted(set(live_coins) - set(TICKERS) - set(EXCLUDED))
    if unmapped:
        log(f"WARN: unmapped xyz coins: {unmapped}")

    r, r_source = fetch_risk_free(yf)
    log(f"risk-free rate {r:.4f} ({r_source})")

    errors, index = [], []
    for i, (coin, sym) in enumerate(sorted(selected.items()), 1):
        entry = {"coin": f"{DEX}:{coin}", "yahoo": sym,
                 "name": NAMES.get(sym, sym), "hasOptions": False}
        try:
            spot = bake_ohlc(yf, sym)
            entry["spot"] = spot
            mark = hl_marks.get(coin)
            if mark and spot:
                diff = abs(mark - spot) / spot * 100
                if diff > PRICE_MISMATCH_PCT:
                    errors.append({"ticker": coin, "stage": "price-check",
                                   "error": f"HL mark {mark} vs Yahoo close {spot} ({diff:.0f}% apart)"})
            time.sleep(PACE_SECONDS)
            try:
                n_exp = bake_options(sym, r, args.max_dte)
            except Exception as e:  # no chain at Cboe is normal for some names
                n_exp = 0
                if "404" not in str(e):
                    errors.append({"ticker": coin, "stage": "options", "error": str(e)[:300]})
            entry["hasOptions"] = n_exp > 0
            entry["expiries"] = n_exp
            log(f"({i}/{len(selected)}) {sym}: spot {spot}, {n_exp} expiries")
        except Exception as e:
            errors.append({"ticker": coin, "stage": "bake", "error": str(e)[:300]})
            log(f"({i}/{len(selected)}) {sym}: FAILED - {e}")
            # keep previous good files; reflect their presence in the index
            entry["hasOptions"] = (DATA / "options" / f"{sym}.json").exists()
            entry["stale"] = True
        if (DATA / "ohlc" / f"{sym}.json").exists():
            index.append(entry)
        time.sleep(PACE_SECONDS)

    write_json(DATA / "meta.json", {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "riskFreeRate": rnd(r, 4), "riskFreeSource": r_source,
        "dex": DEX,
        "tickers": index,
        "errors": errors,
        "unmappedCoins": unmapped,
    })

    failed = {e["ticker"] for e in errors if e["stage"] == "bake"}
    log(f"done: {len(index)} tickers indexed, {len(failed)} failed")
    if len(failed) > len(selected) / 2:
        sys.exit(1)


if __name__ == "__main__":
    main()
