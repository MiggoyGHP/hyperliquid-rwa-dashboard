"""Integrity sentinel for the baked funding bundles.

Funding series have a known shape: a fixed settlement cadence per venue-era,
one record per slot. That makes corruption detectable by construction rather
than by eyeball, which is how 1,373 duplicate records survived unnoticed until
a doubled row showed up on the history page.

Detection is slot-occupancy, not delta-chaining. Hyperliquid stamps funding
with millisecond jitter (06:00:00.026, not 06:00:00.000), and the baker stores
whole seconds, so a settlement that drifts across a second boundary yields
consecutive deltas of 3601 then 3599 — a compensating pair that nets to zero
drift. Comparing raw deltas flags all 74 of those as anomalies; snapping each
timestamp to its nearest expected slot flags none of them while still catching
every real gap. A tripwire that cries wolf is a tripwire everyone ignores.

Findings:
  duplicates      same timestamp stored twice (the historical baker bug)
  slotCollisions  two *distinct* timestamps landing in one slot — a new class,
                  e.g. the venue restating an hour; never seen so far
  missing         an empty slot: either a venue outage or a fetch failure
  offGrid         a record further than cadence/4 from any slot
  cadenceChanges  sustained cadence shift (the real 8h -> 1h switch of
                  2023-06-08 is the only one in the entire dataset)

Known-real gaps live in data/funding/known_gaps.json and are excluded from the
"unresolved" count, so the audit converges to green instead of alarming forever
about hours Hyperliquid genuinely never settled.

Usage:
  python scripts/funding_audit.py            # audit data/funding, exit 1 on residue
  python scripts/funding_audit.py --json     # machine-readable report
"""
import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FUNDING_DIR = ROOT / "data" / "funding"
KNOWN_GAPS_PATH = FUNDING_DIR / "known_gaps.json"

# Files in data/funding that are not per-dex bundles.
NON_BUNDLE = {"index.json", "summary.json", "health.json", "known_gaps.json"}

ERA_PROBE = 20    # deltas sampled to seed the opening cadence
ERA_CONFIRM = 3   # consecutive matching deltas required to accept a new cadence
DEFAULT_CADENCE = 3600


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds")


def _tol(cadence):
    """Slack when comparing two deltas: absorbs sub-second truncation wobble."""
    return max(2, cadence // 100)


def cadence_eras(t):
    """Split ascending timestamps into [(start, end, cadence)] segments.

    A cadence change is only accepted when the new spacing repeats ERA_CONFIRM
    times; that distinguishes a genuine schedule switch from a one-off gap,
    which shows a single odd delta and then returns to the old cadence.
    """
    if len(t) < 2:
        return [(0, len(t), DEFAULT_CADENCE)]
    deltas = [t[i] - t[i - 1] for i in range(1, len(t))]
    cadence = Counter(deltas[:ERA_PROBE]).most_common(1)[0][0] or DEFAULT_CADENCE
    segments, start = [], 0
    for i, d in enumerate(deltas):
        if d == cadence or abs(d - cadence) <= cadence // 4:
            continue
        ahead = deltas[i + 1:i + 1 + ERA_CONFIRM]
        if len(ahead) == ERA_CONFIRM and all(abs(x - d) <= _tol(d) for x in ahead):
            segments.append((start, i + 1, cadence))
            start, cadence = i + 1, d
    segments.append((start, len(t), cadence))
    return segments


def audit_series(t):
    """Findings for one coin's timestamp array (raw, may contain duplicates).

    Returns {"duplicates", "slotCollisions", "missing", "offGrid",
             "cadenceChanges"} where missing is [(slot_epoch, cadence)].
    """
    duplicates = len(t) - len(set(t))
    unique = sorted(set(t))
    eras = cadence_eras(unique)
    missing, off_grid, collisions = [], [], []

    for start, end, cadence in eras:
        segment = unique[start:end]
        if len(segment) < 2:
            continue
        origin, tol = segment[0], cadence // 4
        occupied = {}
        for ts in segment:
            slot = round((ts - origin) / cadence)
            if abs(ts - (origin + slot * cadence)) > tol:
                off_grid.append(ts)
                continue
            if slot in occupied:
                collisions.append((occupied[slot], ts))
            occupied[slot] = ts
        for slot in range(round((segment[-1] - origin) / cadence) + 1):
            if slot not in occupied:
                missing.append((origin + slot * cadence, cadence))

    changes = [{"t": unique[eras[i][0]], "from": eras[i - 1][2], "to": eras[i][2]}
               for i in range(1, len(eras))]
    return {"duplicates": duplicates, "slotCollisions": collisions,
            "missing": missing, "offGrid": off_grid, "cadenceChanges": changes}


def load_known_gaps(path=KNOWN_GAPS_PATH):
    """{(coin, epoch)} of gaps confirmed absent from the venue itself."""
    if not path.exists():
        return set()
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))["gaps"]
    except Exception:  # noqa: BLE001 - a malformed allowlist must not hide real gaps
        return set()
    return {(g["coin"], g["t"]) for g in entries}


def audit_coins(coins, known=None, coin_filter=None):
    """Audit a {coin: {t, r, p}} mapping. Returns a report dict."""
    known = known if known is not None else set()
    report = {"coins": 0, "records": 0, "duplicates": 0, "offGrid": 0,
              "slotCollisions": [], "unresolved": [], "acknowledged": 0,
              "cadenceChanges": [], "lengthMismatch": []}
    for coin, entry in coins.items():
        if coin_filter and coin not in coin_filter:
            continue
        t = entry["t"]
        report["coins"] += 1
        report["records"] += len(t)
        if not (len(t) == len(entry["r"]) == len(entry["p"])):
            report["lengthMismatch"].append(
                {"coin": coin, "t": len(t), "r": len(entry["r"]), "p": len(entry["p"])})
        if not t:
            continue
        found = audit_series(t)
        report["duplicates"] += found["duplicates"]
        report["offGrid"] += len(found["offGrid"])
        for a, b in found["slotCollisions"]:
            report["slotCollisions"].append({"coin": coin, "t": a, "other": b})
        for slot, cadence in found["missing"]:
            if (coin, slot) in known:
                report["acknowledged"] += 1
            else:
                report["unresolved"].append({"coin": coin, "t": slot, "cadence": cadence})
        for change in found["cadenceChanges"]:
            report["cadenceChanges"].append({"coin": coin, **change})
    return report


def is_clean(report):
    return not (report["duplicates"] or report["unresolved"] or report["offGrid"]
                or report["slotCollisions"] or report["lengthMismatch"])


def load_bundles(funding_dir=FUNDING_DIR):
    """{filename: bundle} for every per-dex bundle on disk."""
    out = {}
    for path in sorted(funding_dir.glob("*.json")):
        if path.name in NON_BUNDLE:
            continue
        try:
            bundle = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001 - report, don't crash the audit
            print(f"  {path.name}: UNREADABLE ({e})")
            continue
        if isinstance(bundle, dict) and "coins" in bundle:
            out[path.name] = bundle
    return out


def describe(report):
    """Human-readable summary. Returns a list of lines."""
    lines = [
        f"coins={report['coins']}  records={report['records']}",
        f"duplicates      : {report['duplicates']}",
        f"unresolved gaps : {len(report['unresolved'])}"
        f"   (acknowledged venue gaps: {report['acknowledged']})",
        f"off-grid records: {report['offGrid']}",
        f"slot collisions : {len(report['slotCollisions'])}",
    ]
    if report["lengthMismatch"]:
        lines.append(f"LENGTH MISMATCH : {report['lengthMismatch']}")
    for gap in report["unresolved"][:20]:
        lines.append(f"  GAP {gap['coin']:16s} {iso(gap['t'])} (cadence {gap['cadence']}s)")
    if len(report["unresolved"]) > 20:
        lines.append(f"  ... and {len(report['unresolved']) - 20} more")
    for hit in report["slotCollisions"][:10]:
        lines.append(f"  COLLISION {hit['coin']} {iso(hit['t'])} / {iso(hit['other'])}")
    for change in report["cadenceChanges"]:
        lines.append(f"  cadence {change['coin']}: {change['from']}s -> {change['to']}s "
                     f"at {iso(change['t'])} (informational)")
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="emit the raw report")
    args = ap.parse_args()

    known = load_known_gaps()
    merged = {}
    for bundle in load_bundles().values():
        merged.update(bundle["coins"])
    report = audit_coins(merged, known)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("=== funding integrity audit ===")
        for line in describe(report):
            print(line)
        print("RESULT:", "clean" if is_clean(report) else "ANOMALIES FOUND")

    sys.exit(0 if is_clean(report) else 1)


if __name__ == "__main__":
    main()
