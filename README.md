# NDAD — Novel Digital Assets Dashboard

A live dashboard studying **funding rates on Hyperliquid's tokenized-stock perpetuals**
(the `xyz` builder DEX: `xyz:TSLA`, `xyz:NVDA`, …) against the **real stock** and its
**options market**, and modelling a delta-neutral "funding harvest" strategy.

## How it works

| Data | Source | Freshness |
|---|---|---|
| Funding rates, perp prices | Hyperliquid public API, fetched **live in your browser** (CORS-open) | real time |
| Stock daily candles | Yahoo Finance via `yfinance`, baked to `data/ohlc/*.json` | daily after US close |
| Options chains (bid/ask, IV, delta, OI, volume) | **Cboe delayed quotes API**, baked to `data/options/*.json` | daily after US close |
| Crypto options chains (BTC, ETH) | **Deribit public API**, fetched live in your browser (CORS-open, no key) | real time |

Yahoo's free options feed stopped returning bid/ask/open-interest (verified 2026-08),
so options come from Cboe, which also supplies delta and the other greeks directly.

A GitHub Actions workflow (`.github/workflows/refresh-data.yml`) refreshes the baked
data every US weekday at ~21:35 UTC and on demand via **Actions → Refresh market data →
Run workflow**.

## The strategy being studied

- **Sell leg:** short the tokenized-stock perp on Hyperliquid and collect funding while it's positive.
- **Buy leg (hedge)** — one of three, cancelling the price exposure:
  1. long the real stock,
  2. long a deep in-the-money call (delta ≈ 1),
  3. synthetic long: buy call + sell put at the same strike/expiry.

Yield is expressed as **funding collected ÷ cash needed to enter the buy leg** — option
hedges shrink the denominator, and selling puts subsidizes it further. A secondary
"capital basis" yield adds perp margin and put collateral so near-zero-cost synthetics
don't show unbounded returns.

## Local development

```bash
python -m pip install -r scripts/requirements.txt
python scripts/refresh_data.py --tickers TSLA,NVDA   # or no flag for all ~59
python -m http.server 8000                            # then open http://localhost:8000
```

`scripts/tickers.py` is the hand-curated map of xyz coins → Yahoo symbols; coins on the
DEX but missing from it are reported as `unmappedCoins` in `data/meta.json`.

## API keys

There are none. Every API this site touches (Hyperliquid info, Cboe delayed quotes,
Yahoo via `yfinance`, Deribit `public/*`) is keyless. In particular the Deribit
integration uses only public market-data endpoints — a Deribit API key/secret is
**never needed and must never be added to this repo**: everything under `assets/js/`
ships to every visitor of the public site, and anything committed stays in git history.

If a future feature needs authenticated Deribit access (positions, balances):
keep the key in a password manager or Windows Credential Manager; for scripts, read it
from a `.env` file listed in `.gitignore`; for CI, use a GitHub Actions repository
secret injected as an environment variable — and never write account data into `data/`
(it gets published). If a key ever shows up in a diff, rotate it at Deribit immediately.

## Disclaimer

Not financial advice. Funding can flip negative at any hour; the strategy involves
leverage, liquidation risk, options assignment, and venues that fail independently.
Numbers exclude slippage, borrow costs, dividends and taxes.
