"""Bake per-asset profiles (description, market cap, sector/industry, network)
into data/profiles.json for the dashboard's About card.

Profiles are keyed by SYMBOL (not coin), so the same name listed on several
dexes (AVGO on xyz+para, BTC on main+hyna, GOLD on xyz+hyna) shares one entry.

Sources:
  - Listed equities/ETFs: yfinance .info — longBusinessSummary, marketCap
    (totalAssets for ETFs), sector, industry. Covers the xyz ticker map, the
    para-dex US names, and foreign listings (SoftBank, Kioxia, SK Hynix, …).
  - Crypto: CoinGecko free keyless API — description + market cap, with a
    hand-curated network line. Paced ~6 s/call for the free-tier rate limit.
  - Private companies, commodities, FX, indices, synthetics: hand-curated
    blurbs below (no market cap, per design).

Failure policy: an asset that fails keeps its previous good profile — the
output is merged over the existing profiles.json.

Usage:
  python scripts/refresh_profiles.py                # everything
  python scripts/refresh_profiles.py --only BE,BTC  # subset (debugging)
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
from tickers import TICKERS

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "profiles.json"
YF_PACE = 0.6
CG_PACE = 6.0
DESC_MAX = 400

# para-dex US-listed names (not in the xyz ticker map; same Yahoo symbol).
PARA_YAHOO = ["AAOI", "CIEN", "COHR", "CRDO", "CRWD", "GLW", "IREN", "LRCX",
              "NET", "RDDT", "STX", "TER", "VST"]

# Foreign-listed xyz names -> Yahoo symbol on the home exchange.
FOREIGN_YAHOO = {
    "SOFTBANK": "9984.T",     # SoftBank Group, Tokyo
    "KIOXIA": "285A.T",       # Kioxia Holdings, Tokyo
    "HYUNDAI": "005380.KS",   # Hyundai Motor, Seoul
    "SKHX": "000660.KS",      # SK Hynix, Seoul
    "SKHY": "000660.KS",      # SK Hynix (duplicate listing)
    "SMSN": "005930.KS",      # Samsung Electronics, Seoul
}

# Crypto symbol -> CoinGecko id. Perps prefixed 1000x note it in the blurb.
COINGECKO = {
    "BTC": "bitcoin", "ETH": "ethereum", "HYPE": "hyperliquid",
    "SOL": "solana", "BNB": "binancecoin", "XRP": "ripple",
    "ADA": "cardano", "DOGE": "dogecoin", "LTC": "litecoin",
    "LINK": "chainlink", "SUI": "sui", "ZEC": "zcash",
    "ENA": "ethena", "1000PEPE": "pepe", "FARTCOIN": "fartcoin",
    "PUMP": "pump-fun", "XPL": "plasma",
}

# Crypto symbol -> what network it runs on (hand-curated; CoinGecko's
# asset_platform field is unreliable for L1 native coins).
NETWORKS = {
    "BTC": "Native coin of the Bitcoin L1",
    "ETH": "Native coin of the Ethereum L1",
    "HYPE": "Native token of the Hyperliquid L1 (HyperEVM)",
    "SOL": "Native coin of the Solana L1",
    "BNB": "Native coin of the BNB Chain L1",
    "XRP": "Native coin of the XRP Ledger",
    "ADA": "Native coin of the Cardano L1",
    "DOGE": "Native coin of the Dogecoin L1",
    "LTC": "Native coin of the Litecoin L1",
    "LINK": "ERC-20 on Ethereum (bridged to many chains)",
    "SUI": "Native coin of the Sui L1",
    "ZEC": "Native coin of the Zcash L1",
    "ENA": "ERC-20 on Ethereum",
    "1000PEPE": "ERC-20 on Ethereum (perp tracks 1000× PEPE)",
    "FARTCOIN": "SPL token on Solana",
    "PUMP": "SPL token on Solana",
    "XPL": "Native coin of the Plasma L1",
}

# Hand-curated blurbs: private companies, commodities, FX, indices, synthetics.
BLURBS = {
    # private / pre-IPO
    "SPCX": "SpaceX — private American aerospace company founded by Elon Musk. Builds the Falcon and Starship launch vehicles and operates the Starlink satellite-internet constellation. Pre-IPO; the perp tracks a synthetic valuation.",
    "CBRS": "Cerebras Systems — private American AI-chip company known for its wafer-scale processors used for AI training and inference.",
    "CXMT": "ChangXin Memory Technologies — private Chinese DRAM manufacturer, one of China's leading domestic memory-chip makers.",
    "UNITREE": "Unitree Robotics — private Chinese robotics company making quadruped and humanoid robots.",
    "MINIMAX": "MiniMax — Chinese AI company developing large language and multimodal models.",
    "ZHIPU": "Zhipu AI — Chinese AI company behind the GLM family of large language models.",
    "GIGADEV": "GigaDevice Semiconductor — Chinese fabless chip designer specializing in NOR flash memory and microcontrollers (Shanghai-listed; perp is synthetic).",
    "BASED": "BASED — memecoin perp listed on the HyENA dex.",
    "BOT": "Synthetic basket perp tracking robotics-related names, listed on the xyz dex.",
    "NCLD": "Synthetic \"neocloud\" basket perp tracking AI-cloud infrastructure providers, listed on the xyz dex.",
    "QNT": "Synthetic basket perp tracking quantum-computing names, listed on the xyz dex.",
    "LYTE": "Private/synthetic listing on the xyz dex.",
    "PURRDAT": "Synthetic index perp on the xyz dex.",
    "SHAZ": "Private/synthetic listing on the xyz dex.",
    # commodities
    "GOLD": "Spot gold, the classic precious-metal store of value. Priced in USD per troy ounce.",
    "SILVER": "Spot silver — precious metal with heavy industrial demand (solar, electronics). Priced in USD per troy ounce.",
    "COPPER": "Copper — the bellwether industrial metal, tracking global construction and electrification demand.",
    "PLATINUM": "Platinum — precious metal used in autocatalysts, industry and jewellery.",
    "PALLADIUM": "Palladium — precious metal used mainly in gasoline-engine catalytic converters.",
    "BRENTOIL": "Brent crude oil, the international waterborne oil benchmark.",
    "CL": "WTI crude oil futures, the US oil benchmark.",
    "WTI": "WTI crude oil, the US oil benchmark.",
    "USOIL": "WTI crude oil, the US oil benchmark.",
    "NATGAS": "US natural gas (Henry Hub benchmark).",
    "ALUMINIUM": "Aluminium — light industrial metal (LME benchmark).",
    "CORN": "Corn futures (CBOT benchmark).",
    "WHEAT": "Wheat futures (CBOT benchmark).",
    "SOY": "Soybean futures (CBOT benchmark).",
    "URANIUM": "Uranium (U3O8) spot price.",
    "TTF": "Dutch TTF natural gas, the European gas benchmark.",
    # FX
    "EUR": "EUR/USD — euros per US dollar, the world's most-traded currency pair.",
    "GBP": "GBP/USD — British pound versus the US dollar.",
    "JPY": "USD/JPY — US dollar versus the Japanese yen.",
    "KRW": "USD/KRW — US dollar versus the Korean won.",
    # rates / indices / synthetic
    "10Y": "US 10-year Treasury yield — the benchmark long-term US interest rate.",
    "SP500": "S&P 500 — index of the 500 largest US-listed companies.",
    "US500": "S&P 500 — index of the 500 largest US-listed companies.",
    "USTECH": "Nasdaq-100 — index of the 100 largest non-financial Nasdaq companies.",
    "JP225": "Nikkei 225 — Japan's headline stock index.",
    "KR200": "KOSPI 200 — South Korea's large-cap stock index.",
    "XYZ100": "XYZ 100 — the xyz dex's own basket index of its listed assets.",
    "DRAM": "Synthetic index tracking DRAM memory spot prices.",
    "DXY": "US dollar index — the dollar versus a basket of major currencies.",
    "VIX": "VIX — implied-volatility index on S&P 500 options.",
    "BTCD": "Bitcoin dominance — BTC's share of total crypto market capitalization.",
    "TOTAL2": "Total crypto market capitalization excluding Bitcoin.",
    "OTHERS": "Altcoin market capitalization excluding the top-10 coins.",
}

STRIP_TAGS = re.compile(r"<[^>]+>")
# Dots that are abbreviations, not sentence ends — protected before splitting.
ABBREV = re.compile(r"\b(U\.S\.A|U\.S|U\.K|U\.N|Inc|Corp|Co|Ltd|plc|S\.A|N\.V|e\.g|i\.e|vs|No|approx)\.",
                    re.IGNORECASE)


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


def trim_desc(text, limit=DESC_MAX):
    """First few sentences, capped at limit chars on a word boundary."""
    text = re.sub(r"\s+", " ", STRIP_TAGS.sub("", text or "")).strip()
    if not text:
        return None
    guarded = ABBREV.sub(lambda m: m.group().replace(".", "\x00"), text)
    out = ""
    for m in re.finditer(r"[^.!?]+[.!?]+(?:\s|$)", guarded):
        if out and len(out) + len(m.group()) > limit:
            break
        out += m.group()
        if len(out) >= limit * 0.6:
            break
    out = (out or guarded[:limit]).replace("\x00", ".").strip()
    if len(out) > limit:
        out = out[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return out


def bake_equity(yf, sym, yahoo):
    info = with_retries(lambda: yf.Ticker(yahoo).info)
    desc = trim_desc(info.get("longBusinessSummary"))
    if not desc:
        raise RuntimeError("no business summary")
    p = {"desc": desc, "source": "yahoo"}
    if info.get("quoteType") == "ETF":
        if info.get("totalAssets"):
            p["mcap"] = float(info["totalAssets"])
            p["mcapKind"] = "aum"
        if info.get("category"):
            p["sector"] = info["category"]
    else:
        if info.get("marketCap"):
            p["mcap"] = float(info["marketCap"])
            p["mcapKind"] = "cap"
        if info.get("sector"):
            p["sector"] = info["sector"]
        if info.get("industry"):
            p["industry"] = info["industry"]
    return p


def fetch_coingecko(cg_id):
    url = (f"https://api.coingecko.com/api/v3/coins/{cg_id}"
           "?localization=false&tickers=false&market_data=true"
           "&community_data=false&developer_data=false&sparkline=false")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def bake_crypto(sym, cg_id):
    data = with_retries(lambda: fetch_coingecko(cg_id))
    desc = trim_desc((data.get("description") or {}).get("en"))
    if not desc:
        desc = f"{data.get('name', sym)} cryptocurrency."
    p = {"desc": desc, "source": "coingecko"}
    mcap = ((data.get("market_data") or {}).get("market_cap") or {}).get("usd")
    if mcap:
        p["mcap"] = float(mcap)
        p["mcapKind"] = "cap"
    if sym in NETWORKS:
        p["network"] = NETWORKS[sym]
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated symbol subset, e.g. BE,BTC")
    args = ap.parse_args()
    only = set(args.only.upper().split(",")) if args.only else None
    keep = lambda sym: only is None or sym in only  # noqa: E731

    import yfinance as yf

    old = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8")).get("profiles", {})
        except Exception:
            pass
    profiles = dict(old)
    failed = []

    equities = {**{c: y for c, y in TICKERS.items()},
                **{s: s for s in PARA_YAHOO}, **FOREIGN_YAHOO}
    todo = {s: y for s, y in sorted(equities.items()) if keep(s)}
    log(f"baking {len(todo)} equity profiles")
    for i, (sym, yahoo) in enumerate(todo.items(), 1):
        try:
            profiles[sym] = bake_equity(yf, sym, yahoo)
            log(f"({i}/{len(todo)}) {sym}: ok")
        except Exception as e:
            failed.append(sym)
            log(f"({i}/{len(todo)}) {sym}: FAILED - {str(e)[:120]}")
        time.sleep(YF_PACE)

    todo_cg = {s: c for s, c in sorted(COINGECKO.items()) if keep(s)}
    log(f"baking {len(todo_cg)} crypto profiles (paced {CG_PACE}s for CoinGecko)")
    for i, (sym, cg_id) in enumerate(todo_cg.items(), 1):
        try:
            profiles[sym] = bake_crypto(sym, cg_id)
            log(f"(crypto {i}/{len(todo_cg)}) {sym}: ok")
        except Exception as e:
            failed.append(sym)
            log(f"(crypto {i}/{len(todo_cg)}) {sym}: FAILED - {str(e)[:120]}")
        time.sleep(CG_PACE)

    for sym, desc in BLURBS.items():
        if not keep(sym):
            continue
        if sym in profiles and profiles[sym].get("source") != "curated":
            continue  # a fetched profile wins over the blurb
        profiles[sym] = {"desc": desc, "source": "curated"}
        if sym in NETWORKS:
            profiles[sym]["network"] = NETWORKS[sym]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "profiles": profiles,
    }, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    tmp.replace(OUT)
    log(f"done: {len(profiles)} profiles, {len(failed)} failed ({','.join(failed) or 'none'})")
    if failed and len(failed) > len(profiles) / 2:
        sys.exit(1)


if __name__ == "__main__":
    main()
