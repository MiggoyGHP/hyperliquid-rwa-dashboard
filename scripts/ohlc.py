"""On-demand OHLC + funding inspector for any Hyperliquid perp.

Ad-hoc lookup tool, not part of any bake pipeline: nothing here writes to data/
and no workflow calls it. Answers "what did this thing do, and did the carry
hold while it did" for one coin over one window.

Price comes live from the candleSnapshot API (keyless, CORS-open). Funding is
read from the already-baked data/funding bundles, so joining it costs no extra
request -- but those are baked daily, so the funding columns run out a day or
two before the candles do. Coverage is printed per bar rather than hidden.

Three API facts this works around, each verified against the live endpoint:
  - candleSnapshot needs the dex-prefixed name. "xyz:CL" returns bars; bare
    "CL" returns HTTP 500. Bare names are resolved locally, see resolve_coin.
  - it keeps only the most recent ~5000 bars per interval and ignores any
    startTime older than that, silently. Measured horizons: 1m 3.6d, 5m 17d,
    15m 52d, 1h 208d, 4h 833d; 1d is under the cap and reaches listing. A
    window entirely behind the horizon comes back empty, so a short window
    far in the past returns nothing rather than an error -- both cases are
    reported rather than passed off as "no trading happened".
  - it snaps startTime down to a bar boundary, so bounds are re-filtered.

Funding is bucketed by each bar's [t, T] span rather than by calendar date.
That is what makes one code path serve every interval: daily bars open at
00:00 UTC and take 24 hourly records, 4h bars take 4, with no special case.

Usage:
  python scripts/ohlc.py xyz:CL                      # last 14 daily bars
  python scripts/ohlc.py CL                          # bare name resolves
  python scripts/ohlc.py xyz:CL --start 2026-08-01 --end 2026-08-18
  python scripts/ohlc.py BTC --interval 1h --days 3
  python scripts/ohlc.py xyz:CL --days 30 --json
  python scripts/ohlc.py --list                      # every known coin, by dex
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from tickers import coin_name

ROOT = Path(__file__).resolve().parent.parent
FUNDING_DIR = ROOT / "data" / "funding"
API = "https://api.hyperliquid.xyz/info"

# Files in data/funding that are not per-dex bundles (mirrors funding_audit.py).
NON_BUNDLE = {"index.json", "summary.json", "health.json", "known_gaps.json"}

# Coin keys are the only object keys in a bundle whose value opens with "t".
# Regex-scanning for them beats json.load when all we want is the name index.
COIN_KEY_RE = re.compile(rb'"([^"]+)"\s*:\s*\{\s*"t"')

HOUR_MS = 3_600_000
DAY_MS = 86_400_000
YEAR_MS = 365 * DAY_MS

# Intervals whose bars are a day or longer get a date-only time column.
DATE_ONLY = ("1d", "3d", "1w", "1M")
INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h",
             "8h", "12h", "1d", "3d", "1w", "1M"]


def die(msg, code=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def with_retries(fn, attempts=3, backoff=2.0):
    """Local copy rather than an import: an inspection tool should not have to
    load the bake pipeline to read candles."""
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 - deliberate catch-all with retry
            last = e
            if i < attempts - 1:
                time.sleep(backoff * (i + 1))
    raise last


def post(body):
    req = urllib.request.Request(
        API, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


# --- symbol resolution -------------------------------------------------------

def bundle_paths():
    """dex -> bundle path, from the funding index."""
    idx = json.loads((FUNDING_DIR / "index.json").read_bytes())
    return {d["dex"]: FUNDING_DIR / d["file"] for d in idx["dexes"]}


def known_coins():
    """prefixed coin -> dex, for every coin with baked funding.

    This is a complete index of tradable assets, not a subset: the four dexes
    absent from data/funding (km, flx, vntl, cash) were checked against the
    live meta endpoint and have zero non-delisted assets between them.
    """
    out = {}
    for dex, path in bundle_paths().items():
        if not path.exists():
            continue
        for match in COIN_KEY_RE.finditer(path.read_bytes()):
            out[match.group(1).decode()] = dex
    return out


def resolve_coin(sym, coins):
    """Accept "xyz:CL" as-is; resolve a bare "CL" to its one prefixed name."""
    if sym in coins:
        return sym
    if ":" in sym:
        die(f"unknown coin {sym!r}. Try --list.")
    hits = [c for c in coins if coin_name(c).upper() == sym.upper()]
    if not hits:
        die(f"unknown coin {sym!r}. Try --list.")
    if len(hits) > 1:
        die(f"{sym!r} is ambiguous across dexes: {', '.join(sorted(hits))}. "
            f"Pass the prefixed name.")
    return hits[0]


# --- candles -----------------------------------------------------------------

def fetch_candles(coin, interval, start_ms, end_ms):
    """Every bar the API still holds within [start_ms, end_ms].

    One request, deliberately: the venue retains only the most recent ~5000
    bars per interval, so there is no older page to walk back to. Asking again
    with an earlier startTime returns the same newest bars over and over.
    """
    raw = with_retries(lambda: post({
        "type": "candleSnapshot",
        "req": {"coin": coin, "interval": interval,
                "startTime": start_ms, "endTime": end_ms},
    }))
    if not isinstance(raw, list):
        return []

    seen, bars = set(), []
    for b in raw:
        # the API snaps startTime down to a bar boundary, so re-filter
        if b["t"] < start_ms or b["t"] > end_ms or b["t"] in seen:
            continue
        seen.add(b["t"])
        bars.append({
            "t": b["t"], "T": b["T"],
            "o": float(b["o"]), "h": float(b["h"]),
            "l": float(b["l"]), "c": float(b["c"]),
            "v": float(b["v"]), "n": int(b.get("n") or 0),
        })
    bars.sort(key=lambda b: b["t"])
    return bars


# --- funding -----------------------------------------------------------------

def load_funding(coin, dex):
    """(timestamps_seconds, hourly_rates, bundle_generated_at) for one coin."""
    path = bundle_paths().get(dex)
    if not path or not path.exists():
        return [], [], None
    bundle = json.loads(path.read_bytes())
    rec = bundle["coins"].get(coin)
    if not rec:
        return [], [], bundle.get("generatedAt")
    return rec["t"], rec["r"], bundle.get("generatedAt")


def attach_funding(bars, times, rates):
    """Sum the hourly rates falling inside each bar's span.

    Bucketing by span rather than by date is what lets one path serve every
    interval. Coverage (found vs expected) rides along because a bar holding 1
    of its 24 hours looks like flat carry unless you can see it is 1 of 24.
    """
    for bar in bars:
        span_ms = bar["T"] - bar["t"] + 1
        lo, hi = bar["t"] // 1000, bar["T"] // 1000
        hits = [r for t, r in zip(times, rates) if lo <= t <= hi]
        bar["fundingRecords"] = len(hits)
        bar["fundingExpected"] = max(1, round(span_ms / HOUR_MS))
        bar["funding"] = sum(hits) if hits else None
        # an APR extrapolated from partial coverage is a number that reads as
        # fact and is not one, so it is withheld rather than qualified
        complete = hits and len(hits) >= bar["fundingExpected"]
        bar["aprPct"] = sum(hits) * (YEAR_MS / span_ms) * 100 if complete else None
    return bars


# --- formatting --------------------------------------------------------------

def price_decimals(mx):
    """One decimal count for the whole table: columns stay aligned, but a
    sub-cent altcoin does not print as 0.00."""
    for cutoff, nd in ((100, 2), (10, 3), (1, 4), (0.01, 6)):
        if mx >= cutoff:
            return nd
    return 8


def fmt_pct(x, nd=2):
    return "n/a" if x is None else f"{x:+.{nd}f}%"


def fmt_vol(v):
    return f"{v:,.0f}" if abs(v) >= 1000 else f"{v:,.2f}"


def iso(ms, interval):
    dt = datetime.fromtimestamp(ms / 1000, timezone.utc)
    return dt.strftime("%Y-%m-%d" if interval in DATE_ONLY else "%Y-%m-%d %H:%M")


def summarize(bars):
    full = [b for b in bars if b["aprPct"] is not None]
    chgs = [b for b in bars if b["chgPct"] is not None]
    best = max(chgs, key=lambda b: b["chgPct"], default=None)
    worst = min(chgs, key=lambda b: b["chgPct"], default=None)
    return {
        "open": bars[0]["o"], "close": bars[-1]["c"],
        "high": max(b["h"] for b in bars), "low": min(b["l"] for b in bars),
        "netPct": (bars[-1]["c"] / bars[0]["o"] - 1) * 100,
        "volume": sum(b["v"] for b in bars),
        "trades": sum(b["n"] for b in bars),
        "bars": len(bars),
        "bestBar": best and {"t": best["t"], "chgPct": best["chgPct"]},
        "worstBar": worst and {"t": worst["t"], "chgPct": worst["chgPct"]},
        "meanAprPct": sum(b["aprPct"] for b in full) / len(full) if full else None,
        "fullyCoveredBars": len(full),
    }


def render(coin, dex, interval, bars, summary, funding_at, show_funding,
           short_by_ms, requested_start):
    nd = price_decimals(summary["high"])
    now_ms = int(time.time() * 1000)
    label_w = 10 if interval in DATE_ONLY else 17

    print(f"=== {coin} ({dex or 'main'} dex) {interval} "
          f"{iso(bars[0]['t'], interval)} -> {iso(bars[-1]['t'], interval)} ===")
    if short_by_ms:
        print(f"  NOTE: asked from {iso(requested_start, interval)}, but {interval} "
              f"history reaches back only {(bars[-1]['t'] - bars[0]['t']) / DAY_MS:.1f}d "
              f"({len(bars)} bars). The window is {short_by_ms / DAY_MS:.1f}d short at "
              f"the old end -- use a coarser interval to see further back.")
    print(f"  open {summary['open']:.{nd}f}   high {summary['high']:.{nd}f}   "
          f"low {summary['low']:.{nd}f}   close {summary['close']:.{nd}f}   "
          f"net {fmt_pct(summary['netPct'])}")
    if summary["bestBar"]:
        print(f"  best {iso(summary['bestBar']['t'], interval)} "
              f"{fmt_pct(summary['bestBar']['chgPct'])}   "
              f"worst {iso(summary['worstBar']['t'], interval)} "
              f"{fmt_pct(summary['worstBar']['chgPct'])}")
    print(f"  volume {fmt_vol(summary['volume'])} (base units)   "
          f"trades {summary['trades']:,}   bars {summary['bars']}")
    if show_funding:
        mean = summary["meanAprPct"]
        print(f"  mean APR {fmt_pct(mean, 1) if mean is not None else 'n/a'}"
              f" over {summary['fullyCoveredBars']} fully-covered bars")
    print()

    # 12 wide keeps an 8-decimal sub-cent price off the column to its left
    head = (f"{'Time':<{label_w}}{'Open':>12}{'High':>12}{'Low':>12}"
            f"{'Close':>12}{'Chg%':>9}{'Volume':>14}")
    if show_funding:
        head += f"{'Fund/bar':>11}{'APR':>9}{'Cov':>8}"
    print(head)
    print("-" * len(head))

    for b in bars:
        chg = fmt_pct(b["chgPct"]) if b["chgPct"] is not None else "-"
        row = (f"{iso(b['t'], interval):<{label_w}}"
               f"{b['o']:>12.{nd}f}{b['h']:>12.{nd}f}{b['l']:>12.{nd}f}"
               f"{b['c']:>12.{nd}f}{chg:>9}{fmt_vol(b['v']):>14}")
        if show_funding:
            fund = "n/a" if b["funding"] is None else f"{b['funding'] * 100:+.4f}%"
            apr = fmt_pct(b["aprPct"], 1) if b["aprPct"] is not None else "n/a"
            cov = f"{b['fundingRecords']}/{b['fundingExpected']}"
            row += f"{fund:>11}{apr:>9}{cov:>8}"
        if b["T"] >= now_ms:
            row += "  (in progress)"
        print(row)

    print()
    if show_funding:
        print(f"funding bundle baked {funding_at or 'unknown'}; bars newer than "
              f"that show Cov 0 -- run refresh_funding.py to close the gap")
    else:
        print(f"funding settles hourly, so it is not shown for {interval} bars")
    print("volume is base units, not USD. Bars are UTC; non-crypto perps trade "
          "weekends, so bars exist where the underlying venue has no session.")


def do_list():
    coins = known_coins()
    by_dex = {}
    for coin, dex in coins.items():
        by_dex.setdefault(dex, []).append(coin)
    for dex in sorted(by_dex):
        names = sorted(by_dex[dex])
        print(f"{dex or 'main':>6} ({len(names):>3}): "
              f"{' '.join(coin_name(c) for c in names)}")
    print(f"\n{len(coins)} coins. Bare names resolve automatically; pass the "
          f"prefixed name only when one is listed on two dexes.")


def parse_window(args, now_ms):
    """(start_ms, end_ms) from either --start/--end or --days."""
    if not args.start:
        return now_ms - int(args.days * DAY_MS), now_ms
    try:
        start = datetime.strptime(args.start, "%Y-%m-%d")
        start_ms = int(start.replace(tzinfo=timezone.utc).timestamp() * 1000)
        if not args.end:
            return start_ms, now_ms
        end = datetime.strptime(args.end, "%Y-%m-%d")
        # --end is an inclusive date, so reach to the last instant of that day
        end_ms = int(end.replace(tzinfo=timezone.utc).timestamp() * 1000) + DAY_MS - 1
        return start_ms, end_ms
    except ValueError:
        die("dates must be YYYY-MM-DD")


def main():
    ap = argparse.ArgumentParser(
        description="OHLC + funding for one Hyperliquid perp.")
    ap.add_argument("coin", nargs="?", help='e.g. "xyz:CL" or "CL"')
    ap.add_argument("--interval", default="1d", choices=INTERVALS)
    ap.add_argument("--days", type=float, default=14,
                    help="window ending now (default 14); ignored with --start")
    ap.add_argument("--start", help="UTC date YYYY-MM-DD, inclusive")
    ap.add_argument("--end", help="UTC date YYYY-MM-DD, inclusive (default now)")
    ap.add_argument("--json", action="store_true", help="emit the raw report")
    ap.add_argument("--list", action="store_true", help="list known coins, exit")
    args = ap.parse_args()

    if args.list:
        do_list()
        return
    if not args.coin:
        ap.error("a coin is required (or use --list)")

    coins = known_coins()
    coin = resolve_coin(args.coin, coins)
    dex = coins[coin]

    now_ms = int(time.time() * 1000)
    start_ms, end_ms = parse_window(args, now_ms)
    if start_ms >= end_ms:
        die("--start must precede --end")

    try:
        bars = fetch_candles(coin, args.interval, start_ms, end_ms)
    except Exception as e:  # noqa: BLE001 - surface the API failure, not a trace
        die(f"candle fetch failed for {coin}: {e}", 1)
    if not bars:
        die(f"no {args.interval} bars for {coin} in that range. The venue keeps "
            f"only the most recent ~5000 bars per interval, so a window this "
            f"far back is likely past the {args.interval} horizon -- try a "
            f"coarser --interval.", 1)

    times, rates, funding_at = load_funding(coin, dex)
    attach_funding(bars, times, rates)
    for i, bar in enumerate(bars):
        bar["chgPct"] = (bar["c"] / bars[i - 1]["c"] - 1) * 100 if i else None

    summary = summarize(bars)
    span_ms = bars[0]["T"] - bars[0]["t"] + 1
    # sub-hourly bars are shorter than the funding cadence, so a per-bar sum
    # would be mostly empty buckets rather than information
    show_funding = span_ms >= HOUR_MS
    # more than one bar of daylight at the old end means the retention horizon
    # cut the window short, not that the market was quiet
    short_by_ms = max(0, bars[0]["t"] - start_ms - span_ms)

    if args.json:
        print(json.dumps({
            "coin": coin, "dex": dex, "interval": args.interval,
            "requestedStart": iso(start_ms, args.interval),
            "start": iso(bars[0]["t"], args.interval),
            "end": iso(bars[-1]["t"], args.interval),
            "truncatedByDays": round(short_by_ms / DAY_MS, 2) if short_by_ms else 0,
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "fundingBundleGeneratedAt": funding_at,
            "fundingApplies": show_funding,
            "summary": summary,
            "bars": [dict(b, time=iso(b["t"], args.interval)) for b in bars],
        }, indent=2))
    else:
        render(coin, dex, args.interval, bars, summary, funding_at, show_funding,
               short_by_ms, start_ms)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        # piping a long table into head/more closes stdout early; that is the
        # pipe doing its job, not a failure worth a traceback
        try:
            sys.stdout.close()
        except OSError:
            pass
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
