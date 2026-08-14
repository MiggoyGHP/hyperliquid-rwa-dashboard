"""Bake hourly funding-rate history for every listed instrument.

Covers all live assets on every HIP-3 builder dex plus the main-dex crypto
perps in tickers.CRYPTO (BTC/ETH/HYPE). History goes back to true inception
(fundingHistory with startTime=0): main-dex coins reach May 2023 with 8h-spaced
early records, xyz stocks start 2025-11-13 — never assume hourly spacing.

Outputs (all under data/funding/ except the OI snapshots):
  index.json          manifest: which dex bundles exist, counts, errors.
                      The frontend iterates this instead of hardcoding dexes.
  summary.json        per-coin trailing 30d mean funding, annualized:
                      {"generatedAt", "windowDays", "coins": {coin: {apr30, days, n}}}
                      The dashboard hero board ranks by this.
  main.json           dex "" (main-dex whitelist coins only)
  <dex>.json          one bundle per builder dex:
                      {"dex", "generatedAt", "coins": {coin: {t, r, p}}}
                      t = epoch seconds ascending, r = hourly decimal rate,
                      p = premium (null when the API omits it)
  ../oi/snapshots.json  append-only open-interest/volume series, one point per
                      run: {"generatedAt", "coins": {coin: {t, oi, px, vlm}}}
                      t = epoch seconds, oi = coin units, px = mark price,
                      vlm = trailing-24h USD notional. Hyperliquid exposes no
                      OI history endpoint, so this accumulates going forward.

Incremental: each run resumes every coin from its last baked timestamp, so
only the first run (or a new listing) pays the full backfill. Coins that
delist keep their history and simply stop growing. A coin that fails keeps
its previous arrays untouched.

Usage:
  python scripts/refresh_funding.py                  # all dexes
  python scripts/refresh_funding.py --dexes main,xyz --max-pages 3   # smoke test
"""
import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from tickers import CRYPTO
from refresh_data import write_json, with_retries, log

ROOT = Path(__file__).resolve().parent.parent
FUNDING_DIR = ROOT / "data" / "funding"
OI_PATH = ROOT / "data" / "oi" / "snapshots.json"
API = "https://api.hyperliquid.xyz/info"

# Keep in sync with DEXES in assets/js/classify.js ("" = main dex).
DEXES = ["", "xyz", "para", "hyna", "mkts", "km", "flx", "vntl", "cash"]

PACE_SECONDS = 0.6  # fundingHistory is weight-heavy (browser client uses 1.1s)
PAGE = 500          # max records per fundingHistory call
MAX_PAGES = 120     # BTC needs ~56 pages back to May 2023; headroom for growth

HOURS_PER_YEAR = 24 * 365  # match assets/js/funding.js
WINDOW_DAYS = 30


def post(body):
    req = urllib.request.Request(
        API,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    return with_retries(lambda: json.load(urllib.request.urlopen(req, timeout=30)))


def dex_filename(dex: str) -> str:
    return "main.json" if dex == "" else f"{dex}.json"


def dex_label(dex: str) -> str:
    return dex or "main"


def fetch_live_coins(dex: str):
    """(coin names, {coin: (oi, px, vlm)}) for non-delisted assets on a dex.

    Builder-dex names arrive prefixed. The snapshot half feeds the append-only
    OI series; a coin with a malformed ctx just skips its snapshot this run.
    """
    meta, ctxs = post({"type": "metaAndAssetCtxs", **({"dex": dex} if dex else {})})
    coins, snaps = [], {}
    for asset, ctx in zip(meta["universe"], ctxs):
        if asset.get("isDelisted"):
            continue
        name = asset["name"]
        coins.append(name)
        try:
            snaps[name] = (round(float(ctx["openInterest"]), 3),
                           round(float(ctx["markPx"]), 6),
                           round(float(ctx["dayNtlVlm"])))
        except (KeyError, TypeError, ValueError):
            pass
    if dex == "":
        coins = [c for c in coins if c in CRYPTO]
        snaps = {c: v for c, v in snaps.items() if c in CRYPTO}
    return coins, snaps


def fetch_coin_history(coin: str, start_ms: int):
    """(t_seconds, rate, premium) tuples from start_ms onward, ascending."""
    out = []
    for _page in range(MAX_PAGES):
        batch = post({"type": "fundingHistory", "coin": coin, "startTime": start_ms})
        if not isinstance(batch, list) or not batch:
            break
        for rec in batch:
            try:
                premium = round(float(rec["premium"]), 8)
            except (KeyError, TypeError, ValueError):
                premium = None
            out.append((rec["time"] // 1000, round(float(rec["fundingRate"]), 10), premium))
        if len(batch) < PAGE:
            break
        start_ms = batch[-1]["time"] + 1
        time.sleep(PACE_SECONDS)
    return out


def bake_dex(dex: str, errors: list, snapshots: dict):
    """Update one dex bundle in place. Returns (live, failed, records) counts.

    Also deposits this dex's OI/volume snapshot into the shared `snapshots`
    dict; a dex that fails to answer simply contributes nothing this run.
    """
    path = FUNDING_DIR / dex_filename(dex)
    bundle = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"coins": {}}
    coins = bundle["coins"]

    live, snaps = with_retries(lambda: fetch_live_coins(dex))
    snapshots.update(snaps)
    if not live and not coins:
        log(f"dex {dex_label(dex)}: no live assets, skipping")
        return 0, 0, 0

    failed = 0
    for coin in live:
        entry = coins.get(coin)
        start_ms = entry["t"][-1] * 1000 + 1 if entry and entry["t"] else 0
        try:
            rows = fetch_coin_history(coin, start_ms)
        except Exception as e:  # noqa: BLE001 - keep the coin's previous data
            failed += 1
            errors.append({"coin": coin, "error": str(e)})
            log(f"  {coin}: FAILED ({e})")
            continue
        if entry is None:
            entry = coins[coin] = {"t": [], "r": [], "p": []}
        for t, r, p in rows:
            entry["t"].append(t)
            entry["r"].append(r)
            entry["p"].append(p)
        if rows:
            log(f"  {coin}: +{len(rows)} records (total {len(entry['t'])})")
        time.sleep(PACE_SECONDS)

    records = sum(len(c["t"]) for c in coins.values())
    write_json(path, {
        "dex": dex,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "coins": coins,
    })
    log(f"dex {dex_label(dex)}: {len(coins)} coins, {records} records ({failed} failed)")
    return len(live), failed, records


def append_snapshots(snapshots, now_s):
    """Append one OI/volume point per captured coin to the snapshot series.

    Only coins fetched this run get an append (a --dexes subset run leaves
    everything else untouched); an unreadable existing file is never clobbered.
    """
    if not snapshots:
        log("oi snapshots: nothing captured this run, keeping old file")
        return
    if OI_PATH.exists():
        try:
            data = json.loads(OI_PATH.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001 - corrupt file: leave for manual fix
            log(f"oi snapshots: existing file unreadable ({e}) — skipping write")
            return
    else:
        data = {"coins": {}}
    coins = data["coins"]
    for coin, (oi, px, vlm) in snapshots.items():
        entry = coins.setdefault(coin, {"t": [], "oi": [], "px": [], "vlm": []})
        if entry["t"] and entry["t"][-1] == now_s:
            continue  # same-second rerun
        entry["t"].append(now_s)
        entry["oi"].append(oi)
        entry["px"].append(px)
        entry["vlm"].append(vlm)
    data["generatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    write_json(OI_PATH, data)
    log(f"oi snapshots: appended {len(snapshots)} coins (file has {len(coins)})")


def summarize_coins(coins, now_s, out):
    """Trailing 30d mean funding per coin, annualized like funding.js windowStats."""
    cutoff = now_s - WINDOW_DAYS * 86400
    for coin, entry in coins.items():
        t, r = entry["t"], entry["r"]
        if not t:
            continue
        total = 0.0
        n = 0
        prev = None
        for i in range(len(t) - 1, -1, -1):
            if t[i] < cutoff:
                break
            if t[i] == prev:  # intraday top-up runs can duplicate an hour
                continue
            prev = t[i]
            total += r[i]
            n += 1
        if not n:
            continue
        full = t[0] <= cutoff + 3600  # 1h slack, same as windowStats partialDays
        days = WINDOW_DAYS if full else max(1, round((now_s - t[0]) / 86400))
        out[coin] = {"apr30": round(total / n * HOURS_PER_YEAR, 6), "days": days, "n": n}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dexes", help="comma-separated subset (use 'main' for the main dex)")
    ap.add_argument("--max-pages", type=int, help="cap fundingHistory pages per coin (smoke tests)")
    args = ap.parse_args()

    if args.max_pages:
        global MAX_PAGES
        MAX_PAGES = args.max_pages

    dexes = DEXES
    if args.dexes:
        wanted = {("" if d == "main" else d) for d in args.dexes.split(",")}
        dexes = [d for d in DEXES if d in wanted]

    errors = []
    total_live = total_failed = 0
    snapshots = {}
    for dex in dexes:
        try:
            live, failed, _records = bake_dex(dex, errors, snapshots)
        except Exception as e:  # noqa: BLE001 - one dead dex shouldn't kill the run
            errors.append({"coin": f"{dex_label(dex)}:*", "error": str(e)})
            log(f"dex {dex_label(dex)}: FAILED ({e})")
            continue
        total_live += live
        total_failed += failed

    now_s = int(time.time())
    append_snapshots(snapshots, now_s)

    # Manifest and summary cover every bundle on disk, not just this run's
    # subset, so a --dexes smoke test never hides other dexes from the frontend.
    manifest_dexes = []
    summary_coins = {}
    for dex in DEXES:
        path = FUNDING_DIR / dex_filename(dex)
        if not path.exists():
            continue
        bundle = json.loads(path.read_text(encoding="utf-8"))
        manifest_dexes.append({
            "dex": dex,
            "file": dex_filename(dex),
            "coins": len(bundle["coins"]),
            "records": sum(len(c["t"]) for c in bundle["coins"].values()),
        })
        summarize_coins(bundle["coins"], now_s, summary_coins)

    write_json(FUNDING_DIR / "index.json", {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dexes": manifest_dexes,
        "errors": errors,
    })
    write_json(FUNDING_DIR / "summary.json", {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "windowDays": WINDOW_DAYS,
        "coins": summary_coins,
    })
    log(f"done: {total_live} live coins, {total_failed} failed, {len(manifest_dexes)} bundles")

    if total_live and total_failed > total_live / 2:
        log("more than half of coins failed — exiting 1")
        sys.exit(1)


if __name__ == "__main__":
    main()
