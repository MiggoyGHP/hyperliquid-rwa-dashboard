"""Curated mapping of Hyperliquid xyz-DEX coins to Yahoo Finance symbols.

Single source of truth. The refresh script embeds this into data/meta.json,
so the frontend never duplicates it. Coins listed on the xyz DEX but present
in neither TICKERS nor EXCLUDED are reported as "unmappedCoins" in meta.json
so new listings get noticed.

Every mapping is sanity-checked at bake time: Hyperliquid mark price vs
Yahoo last close must agree within tolerance, otherwise the ticker is
flagged in meta.json errors.
"""

# coin (without "xyz:" prefix) -> Yahoo Finance symbol
TICKERS = {
    # --- US-listed stocks (incl. ADRs) ---
    "AAPL": "AAPL",    # Apple
    "AMAT": "AMAT",    # Applied Materials
    "AMD": "AMD",      # Advanced Micro Devices
    "AMZN": "AMZN",    # Amazon
    "ARM": "ARM",      # Arm Holdings ADR
    "ASML": "ASML",    # ASML ADR
    "AVGO": "AVGO",    # Broadcom
    "BABA": "BABA",    # Alibaba ADR
    "BB": "BB",        # BlackBerry
    "BE": "BE",        # Bloom Energy
    "BX": "BX",        # Blackstone
    "COIN": "COIN",    # Coinbase
    "COST": "COST",    # Costco
    "CRCL": "CRCL",    # Circle Internet Group
    "CRWV": "CRWV",    # CoreWeave
    "DELL": "DELL",    # Dell Technologies
    "DKNG": "DKNG",    # DraftKings
    "EBAY": "EBAY",    # eBay
    "GEV": "GEV",      # GE Vernova
    "GME": "GME",      # GameStop
    "GOOGL": "GOOGL",  # Alphabet
    "HIMS": "HIMS",    # Hims & Hers Health
    "HOOD": "HOOD",    # Robinhood
    "IBM": "IBM",      # IBM
    "INTC": "INTC",    # Intel
    "LITE": "LITE",    # Lumentum
    "LLY": "LLY",      # Eli Lilly
    "META": "META",    # Meta Platforms
    "MRVL": "MRVL",    # Marvell Technology
    "MSFT": "MSFT",    # Microsoft
    "MSTR": "MSTR",    # Strategy (MicroStrategy)
    "MU": "MU",        # Micron Technology
    "NBIS": "NBIS",    # Nebius Group
    "NFLX": "NFLX",    # Netflix
    "NOK": "NOK",      # Nokia ADR
    "NOW": "NOW",      # ServiceNow
    "NVDA": "NVDA",    # NVIDIA
    "ORCL": "ORCL",    # Oracle
    "PLTR": "PLTR",    # Palantir
    "QCOM": "QCOM",    # Qualcomm
    "RIVN": "RIVN",    # Rivian
    "RKLB": "RKLB",    # Rocket Lab
    "SNDK": "SNDK",    # Sandisk
    "STRC": "STRC",    # Strategy STRC preferred (price-check validated)
    "TSLA": "TSLA",    # Tesla
    "TSM": "TSM",      # TSMC ADR
    "USAR": "USAR",    # USA Rare Earth
    "WDC": "WDC",      # Western Digital
    "ZM": "ZM",        # Zoom Communications
    "BIRD": "BIRD",    # Allbirds (price-check validated)
    # --- US-listed ETFs (options generally available) ---
    "EWJ": "EWJ",      # iShares MSCI Japan
    "EWT": "EWT",      # iShares MSCI Taiwan
    "EWY": "EWY",      # iShares MSCI South Korea
    "EWZ": "EWZ",      # iShares MSCI Brazil
    "KORU": "KORU",    # Direxion South Korea Bull 3X
    "SMH": "SMH",      # VanEck Semiconductor
    "SOXL": "SOXL",    # Direxion Semis Bull 3X
    "URNM": "URNM",    # Sprott Uranium Miners
    "XLE": "XLE",      # Energy Select SPDR
}

# coin -> reason for exclusion (no Yahoo stock/options data applicable)
# Only gates the baked candles/options pipeline: excluded coins (and every
# other builder-dex asset) still appear live in the funding table with a
# funding-only detail view (see assets/js/classify.js).
EXCLUDED = {
    # commodities
    "BRENTOIL": "commodity (Brent crude)",
    "CL": "commodity (WTI crude)",
    "COPPER": "commodity",
    "GOLD": "commodity",
    "NATGAS": "commodity",
    "PALLADIUM": "commodity",
    "PLATINUM": "commodity",
    "SILVER": "commodity",
    "ALUMINIUM": "commodity (delisted)",
    "CORN": "commodity (delisted)",
    "WHEAT": "commodity (delisted)",
    "TTF": "commodity (Dutch gas, delisted)",
    "URANIUM": "commodity (delisted)",
    # FX
    "EUR": "FX pair",
    "GBP": "FX pair",
    "JPY": "FX pair",
    "KRW": "FX pair (delisted)",
    # indices / synthetic baskets
    "SP500": "index",
    "JP225": "index (Nikkei)",
    "KR200": "index (KOSPI)",
    "XYZ100": "index (xyz basket)",
    "DRAM": "synthetic index (DRAM prices)",
    "DXY": "index (delisted)",
    "VIX": "index (delisted)",
    "VOL": "index (delisted)",
    "NIFTY": "index (delisted)",
    "IBOV": "index (delisted)",
    "H100": "synthetic index (GPU prices, delisted)",
    "KSTR": "index (delisted)",
    # foreign-listed (no US options chain)
    "HYUNDAI": "Korea-listed",
    "KIOXIA": "Japan-listed",
    "SKHX": "Korea-listed (SK Hynix)",
    "SKHY": "Korea-listed (SK Hynix)",
    "SMSN": "London GDR (Samsung)",
    "SOFTBANK": "Japan-listed",
    "IBIDEN": "Japan-listed (delisted)",
    # private / pre-IPO / synthetic
    "SPCX": "private (SpaceX)",
    "CXMT": "private (ChangXin Memory)",
    "UNITREE": "private (Unitree Robotics)",
    "MINIMAX": "private (MiniMax AI)",
    "ZHIPU": "private (Zhipu AI)",
    "GIGADEV": "private/synthetic",
    "BOT": "private/synthetic (robotics)",
    "NCLD": "private/synthetic (neocloud)",
    "LYTE": "private/synthetic",
    "PURRDAT": "private/synthetic",
    "SHAZ": "private/synthetic",
    "QNT": "private/synthetic (quantum)",
    "CBRS": "private (Cerebras)",
}

# Yahoo symbol -> display name for the dashboard
NAMES = {
    "AAPL": "Apple", "AMAT": "Applied Materials", "AMD": "AMD", "AMZN": "Amazon",
    "ARM": "Arm Holdings", "ASML": "ASML", "AVGO": "Broadcom", "BABA": "Alibaba",
    "BB": "BlackBerry", "BE": "Bloom Energy", "BIRD": "Allbirds", "BX": "Blackstone",
    "COIN": "Coinbase", "COST": "Costco", "CRCL": "Circle", "CRWV": "CoreWeave",
    "DELL": "Dell", "DKNG": "DraftKings", "EBAY": "eBay", "GEV": "GE Vernova",
    "GME": "GameStop", "GOOGL": "Alphabet (Google)", "HIMS": "Hims & Hers",
    "HOOD": "Robinhood", "IBM": "IBM", "INTC": "Intel", "LITE": "Lumentum",
    "LLY": "Eli Lilly", "META": "Meta (Facebook)", "MRVL": "Marvell",
    "MSFT": "Microsoft", "MSTR": "Strategy (MicroStrategy)", "MU": "Micron",
    "NBIS": "Nebius", "NFLX": "Netflix", "NOK": "Nokia", "NOW": "ServiceNow",
    "NVDA": "NVIDIA", "ORCL": "Oracle", "PLTR": "Palantir", "QCOM": "Qualcomm",
    "RIVN": "Rivian", "RKLB": "Rocket Lab", "SNDK": "Sandisk",
    "STRC": "Strategy STRC Preferred", "TSLA": "Tesla", "TSM": "TSMC",
    "USAR": "USA Rare Earth", "WDC": "Western Digital", "ZM": "Zoom",
    "EWJ": "Japan ETF (EWJ)", "EWT": "Taiwan ETF (EWT)", "EWY": "South Korea ETF (EWY)",
    "EWZ": "Brazil ETF (EWZ)", "KORU": "Korea 3x Bull ETF (KORU)",
    "SMH": "Semiconductor ETF (SMH)", "SOXL": "Semis 3x Bull ETF (SOXL)",
    "URNM": "Uranium Miners ETF (URNM)", "XLE": "Energy ETF (XLE)",
}

# Crypto perps on Hyperliquid's default (main) dex: coin -> display name.
# No Yahoo mapping — OHLC comes from Hyperliquid's own candle API.
CRYPTO = {"BTC": "Bitcoin", "ETH": "Ethereum", "HYPE": "Hyperliquid"}

DEX = "xyz"


def coin_name(coin: str) -> str:
    """xyz:TSLA -> TSLA"""
    return coin.split(":", 1)[1] if ":" in coin else coin
