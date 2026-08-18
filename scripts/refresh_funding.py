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
  health.json         integrity status from scripts/funding_audit.py, written
                      every run: {"generatedAt", "status", "duplicatesRemoved",
                      "gapsHealed", "unresolved", "conflicts", ...}. The history
                      page shows a badge from this; CI fails on a bad status.
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

Self-healing: every bundle is normalized on load (deduped, sorted, arrays
realigned) and audited afterwards, and detected gaps are refilled with targeted
startTime/endTime fetches. Timestamps are kept strictly ascending on append,
which is what makes duplicates unrepresentable rather than merely unlikely --
the original bug shipped 1,373 duplicate records because nothing enforced that
invariant and nothing checked for it. See scripts/funding_audit.py.

Usage:
  python scripts/refresh_funding.py                  # all dexes
  python scripts/refresh_funding.py --dexes main,xyz --max-pages 3   # smoke test
  python scripts/refresh_funding.py --no-heal        # skip the gap-refill pass
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
from funding_audit import audit_coins, audit_series, describe, is_clean, load_known_gaps

ROOT = Path(__file__).resolve().parent.parent
FUNDING_DIR = ROOT / "data" / "funding"
OI_PATH = ROOT / "data" / "oi" / "snapshots.json"
API = "https://api.hyperliquid.xyz/info"

# Keep in sync with DEXES in assets/js/classify.js ("" = main dex).
DEXES = ["", "xyz", "para", "hyna", "mkts", "km", "flx", "vntl", "cash"]

PACE_SECONDS = 0.6  # fundingHistory is weight-heavy (browser client uses 1.1s)
PAGE = 500          # max records per fundingHistory call
MAX_PAGES = 120     # BTC needs ~56 pages back to May 2023; headroom for growth
MAX_HEAL_CALLS = 50 # per run: a venue-wide outage must not blow the rate budget
                    # or stall the job for hours. Leftovers heal next run.

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


def parse_records(batch):
    """API records -> (t_seconds, rate, premium) tuples.

    Note the truncation: Hyperliquid stamps funding with millisecond settlement
    jitter (06:00:00.026, not 06:00:00.000), and we keep whole seconds. Anything
    that resumes from a stored timestamp must therefore round *up* to the next
    second, or it lands before the record it already holds -- see bake_dex.
    """
    out = []
    for rec in batch:
        try:
            premium = round(float(rec["premium"]), 8)
        except (KeyError, TypeError, ValueError):
            premium = None
        out.append((rec["time"] // 1000, round(float(rec["fundingRate"]), 10), premium))
    return out


def fetch_coin_history(coin: str, start_ms: int):
    """(t_seconds, rate, premium) tuples from start_ms onward, ascending."""
    out = []
    for _page in range(MAX_PAGES):
        batch = post({"type": "fundingHistory", "coin": coin, "startTime": start_ms})
        if not isinstance(batch, list) or not batch:
            break
        out.extend(parse_records(batch))
        if len(batch) < PAGE:
            break
        start_ms = batch[-1]["time"] + 1
        time.sleep(PACE_SECONDS)
    return out


def fetch_window(coin: str, start_ms: int, end_ms: int):
    """Records inside an explicit window -- the targeted refill for one gap.

    fundingHistory honours endTime, so healing a hole costs a single bounded
    call instead of replaying the coin's whole history.
    """
    batch = post({"type": "fundingHistory", "coin": coin,
                  "startTime": start_ms, "endTime": end_ms})
    return parse_records(batch) if isinstance(batch, list) else []


def normalize_entry(entry):
    """Force one coin's arrays to strictly ascending, deduped, aligned.

    Returns (removed, conflicts). Duplicates keep the first-fetched copy;
    a duplicate whose rate or premium *differs* is reported as a conflict
    rather than silently resolved, because that would mean the venue restated
    a settled rate and a human should decide which one is authoritative.
    """
    t, r, p = entry["t"], entry["r"], entry["p"]
    n = min(len(t), len(r), len(p))
    if n == len(t) == len(r) == len(p) and all(t[i] > t[i - 1] for i in range(1, n)):
        return 0, []  # already clean: the common path, no allocation

    order = sorted(range(n), key=lambda i: t[i])  # stable -> ties keep fetch order
    out_t, out_r, out_p, conflicts = [], [], [], []
    for i in order:
        if out_t and t[i] == out_t[-1]:
            if r[i] != out_r[-1] or p[i] != out_p[-1]:
                conflicts.append({"t": t[i],
                                  "kept": {"r": out_r[-1], "p": out_p[-1]},
                                  "dropped": {"r": r[i], "p": p[i]}})
            continue
        out_t.append(t[i])
        out_r.append(r[i])
        out_p.append(p[i])
    entry["t"], entry["r"], entry["p"] = out_t, out_r, out_p
    return len(t) - len(out_t), conflicts


def merge_rows(entry, rows):
    """Add rows the entry does not already hold. Returns how many landed."""
    have = set(entry["t"])
    fresh = [row for row in rows if row[0] not in have]
    if not fresh:
        return 0
    for t, r, p in fresh:
        entry["t"].append(t)
        entry["r"].append(r)
        entry["p"].append(p)
    normalize_entry(entry)  # reuse the sorter rather than inserting in place
    return len(fresh)


def heal_gaps(coins, known, budget, health):
    """Refill detected holes with targeted window fetches.

    A gap that survives a refill is real -- Hyperliquid simply never settled
    that hour -- so it is left for known_gaps.json (or triage) rather than
    retried forever. Budget is shared across dexes and decremented in place.
    """
    for coin, entry in coins.items():
        if budget[0] <= 0 or not entry["t"]:
            continue
        gaps = [(slot, cad) for slot, cad in audit_series(entry["t"])["missing"]
                if (coin, slot) not in known]
        for slot, cadence in gaps:
            if budget[0] <= 0:
                log("  heal budget exhausted -- remaining gaps retry next run")
                return
            budget[0] -= 1
            try:
                rows = fetch_window(coin, (slot - cadence) * 1000, (slot + cadence) * 1000)
            except Exception as e:  # noqa: BLE001 - a failed heal is not fatal
                log(f"  {coin}: heal at {slot} FAILED ({e})")
                continue
            added = merge_rows(entry, rows)
            health["gapsHealed"] += added
            log(f"  {coin}: heal {slot} -> {'+%d records' % added if added else 'venue has none'}")
            time.sleep(PACE_SECONDS)


def bake_dex(dex: str, errors: list, snapshots: dict, known, budget, health, heal=True):
    """Update one dex bundle in place. Returns (live, failed, records) counts.

    Also deposits this dex's OI/volume snapshot into the shared `snapshots`
    dict; a dex that fails to answer simply contributes nothing this run.
    """
    path = FUNDING_DIR / dex_filename(dex)
    bundle = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"coins": {}}
    coins = bundle["coins"]

    # Repair whatever is already on disk before adding to it, so a bundle
    # corrupted by an older build heals itself on the next run.
    for coin, entry in coins.items():
        removed, conflicts = normalize_entry(entry)
        if removed:
            health["duplicatesRemoved"] += removed
            log(f"  {coin}: dropped {removed} duplicate record(s)")
        for c in conflicts:
            health["conflicts"].append({"coin": coin, **c})

    live, snaps = with_retries(lambda: fetch_live_coins(dex))
    snapshots.update(snaps)
    if not live and not coins:
        log(f"dex {dex_label(dex)}: no live assets, skipping")
        return 0, 0, 0

    failed = 0
    for coin in live:
        entry = coins.get(coin)
        # Round up to the next whole second: the stored timestamp dropped the
        # record's millisecond remainder, so resuming at stored+1ms would
        # re-fetch it and append a duplicate (every run, every coin).
        start_ms = (entry["t"][-1] + 1) * 1000 if entry and entry["t"] else 0
        try:
            rows = fetch_coin_history(coin, start_ms)
        except Exception as e:  # noqa: BLE001 - keep the coin's previous data
            failed += 1
            errors.append({"coin": coin, "error": str(e)})
            log(f"  {coin}: FAILED ({e})")
            continue
        if entry is None:
            entry = coins[coin] = {"t": [], "r": [], "p": []}
        # Strictly ascending on append. This is the invariant that makes
        # duplicates unrepresentable no matter what the API returns.
        added = 0
        for t, r, p in rows:
            if entry["t"] and t <= entry["t"][-1]:
                continue
            entry["t"].append(t)
            entry["r"].append(r)
            entry["p"].append(p)
            added += 1
        if added:
            log(f"  {coin}: +{added} records (total {len(entry['t'])})")
        time.sleep(PACE_SECONDS)

    if heal:
        heal_gaps(coins, known, budget, health)

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
            if t[i] == prev:  # belt-and-braces: bake_dex keeps t strictly
                continue      # ascending, so this should never fire
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
    ap.add_argument("--no-heal", action="store_true", help="skip the gap-refill pass")
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
    known = load_known_gaps()
    budget = [MAX_HEAL_CALLS]
    health = {"duplicatesRemoved": 0, "gapsHealed": 0, "conflicts": []}
    for dex in dexes:
        try:
            live, failed, _records = bake_dex(dex, errors, snapshots, known, budget,
                                              health, heal=not args.no_heal)
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
    all_coins = {}
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
        all_coins.update(bundle["coins"])

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

    # Audit what actually landed on disk. Repairs already happened above, so a
    # non-clean result here is residue needing judgement, not a pending chore.
    report = audit_coins(all_coins, known)
    report.update(health)
    clean = is_clean(report)
    write_json(FUNDING_DIR / "health.json", {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": "ok" if clean else "degraded",
        **report,
    })
    log("integrity: " + " | ".join([
        f"repaired {health['duplicatesRemoved']} duplicate(s)",
        f"healed {health['gapsHealed']} gap record(s)",
        f"{len(report['unresolved'])} unresolved",
        f"{len(report['conflicts'])} conflict(s)",
    ]))
    if not clean:
        for line in describe(report):
            log("  " + line)

    log(f"done: {total_live} live coins, {total_failed} failed, {len(manifest_dexes)} bundles")

    if total_live and total_failed > total_live / 2:
        log("more than half of coins failed — exiting 1")
        sys.exit(1)
    if not clean:
        log("integrity anomalies remain — exiting 1 (data is written; triage the report)")
        sys.exit(1)


if __name__ == "__main__":
    main()
