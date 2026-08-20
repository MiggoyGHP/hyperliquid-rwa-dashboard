---
name: hl-ohlc
description: Use when asked what a Hyperliquid perp did over some window - candles, OHLC, bars, "how did WTI/GOLD/TSLA/BTC trade last week", price against funding, or a volume/volatility check on a single coin. Runs scripts/ohlc.py. Not for dashboard changes or data refreshes.
---

# Hyperliquid OHLC + funding lookup

Ad-hoc price inspection for one coin, on request. Read-only: it writes nothing
to `data/` and no workflow depends on it.

## Run it

```bash
python scripts/ohlc.py xyz:CL                     # last 14 daily bars
python scripts/ohlc.py CL --days 30
python scripts/ohlc.py CL --start 2026-08-01 --end 2026-08-18   # both inclusive
python scripts/ohlc.py BTC --interval 1h --days 3
python scripts/ohlc.py xyz:CL --days 5 --json     # to compute on the numbers
python scripts/ohlc.py --list                     # 137 known coins, by dex
```

Show the table as printed — it is already aligned and captioned. Reach for
`--json` only when the answer needs arithmetic the table does not already do.

## Symbols

Bare names resolve on their own (`CL` -> `xyz:CL`). Main-dex coins (`BTC`,
`ETH`, `HYPE`) are stored unprefixed and win over a same-named twin on a
builder dex — reach those explicitly (`hyna:BTC`). A name listed on two builder
dexes (`AVGO`, `UNITREE`) errors and prints the candidates.

## Reading the output

- **Bars are UTC**, daily ones opening 00:00.
- **Non-crypto perps trade weekends**, so bars exist where NYMEX or NYSE has no
  session. They are real but thin — CL prints ~330k base units on a Saturday
  against ~2M midweek. That is the weekend, not a liquidity event.
- **Volume is base units, not USD.**
- **The final bar is still forming** and is marked `(in progress)`. Never quote
  it as a settled close.
- **`Cov` is funding coverage** — records found against records expected for
  that bar. Funding is read from the daily-baked `data/funding/` bundles, so
  the newest bars show `0/24` and the boundary bar often `1/24`. **APR is
  withheld (`n/a`) on any partially covered bar** rather than extrapolated from
  a fraction of the day; `Fund/bar` still shows what was actually paid. Running
  `refresh_funding.py` closes the gap.
- **Funding columns disappear below `1h`**, because funding settles hourly and
  a per-bar sum would just be empty buckets.

## History limits

The venue keeps only the most recent ~5000 bars per interval and silently
ignores a `startTime` older than that. Measured reach: `1m` 3.6d, `5m` 17d,
`15m` 52d, `1h` 208d, `4h` 833d; `1d` reaches back to listing. The script
prints a `NOTE:` when the window came back short and errors when the whole
window sits past the horizon. For anything older than a week, use `1h` or
coarser.
