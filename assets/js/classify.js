// Asset universe classification for the funding table.
// Rows come live from metaAndAssetCtxs across every dex in DEXES; this module
// only decides what category each coin belongs to and what to call it.
// Resolution order: per-dex override → global commodity-name set → dex default.

export const DEXES = ["", "xyz", "para", "hyna", "mkts", "km", "flx", "vntl", "cash"]; // "" = main dex

const DEX_DEFAULT = {
  "": "crypto",
  xyz: "stock",
  para: "stock",
  hyna: "crypto",
  mkts: "other",
  km: "stock",
  flx: "commodity",
  vntl: "other",
  cash: "stock",
};

// Per-dex exceptions to the default. Anything not listed keeps the dex default.
const OVERRIDES = {
  xyz: {
    commodity: ["GOLD", "SILVER", "COPPER", "BRENTOIL", "CL", "NATGAS", "PLATINUM",
      "PALLADIUM", "ALUMINIUM", "CORN", "WHEAT", "URANIUM", "TTF"],
    other: [
      "EUR", "GBP", "JPY", "KRW", "DXY", // FX
      "SP500", "JP225", "KR200", "XYZ100", "NIFTY", "IBOV", "VIX", "VOL", "DRAM", "H100", "KSTR", // indices
      "SPCX", "CBRS", "UNITREE", "MINIMAX", "ZHIPU", "CXMT", "GIGADEV", "SHAZ",
      "NCLD", "LYTE", "BOT", "PURRDAT", "QNT", // private / synthetic
    ],
  },
  para: { crypto: ["BTCD", "TOTAL2", "OTHERS"] },
  hyna: { commodity: ["GOLD", "SILVER"] },
  km: {
    commodity: ["GOLD", "SILVER", "USOIL"],
    other: ["EUR", "US500", "USTECH", "SMALL2000", "USBOND", "USENERGY", "GLDMINE", "SEMI"],
  },
  flx: {
    stock: ["COIN", "CRCL", "NVDA", "TSLA"],
    crypto: ["XMR", "USDE"],
    other: ["USA100", "USA500"],
  },
  vntl: { commodity: ["GOLDJM", "SILVERJM", "SOY", "WHEAT"] },
  cash: {
    commodity: ["GOLD", "SILVER", "WTI"],
    other: ["USA500"],
  },
};

// Applies on any dex (before the dex default) so future listings of well-known
// commodity names classify correctly without an override entry.
const COMMODITY_NAMES = new Set([
  "GOLD", "SILVER", "COPPER", "PLATINUM", "PALLADIUM", "OIL", "WTI", "USOIL",
  "BRENTOIL", "CL", "GAS", "NATGAS", "WHEAT", "CORN", "SOY", "URANIUM",
]);

// dex → (symbol → category), inverted from OVERRIDES once at load.
const OVERRIDE_LOOKUP = new Map(Object.entries(OVERRIDES).map(([dex, cats]) => [
  dex,
  new Map(Object.entries(cats).flatMap(([cat, syms]) => syms.map(s => [s, cat]))),
]));

export function classify(coin) {
  const i = coin.indexOf(":");
  const dex = i === -1 ? "" : coin.slice(0, i);
  const sym = i === -1 ? coin : coin.slice(i + 1);
  const cat = OVERRIDE_LOOKUP.get(dex)?.get(sym)
    ?? (COMMODITY_NAMES.has(sym) ? "commodity" : DEX_DEFAULT[dex] ?? "other");
  return { dex, sym, cat };
}

// Human names for symbols that aren't in baked meta and aren't self-explanatory.
// Anything absent falls back to the raw symbol.
export const DISPLAY_NAMES = {
  OPENAI: "OpenAI", ANTHROPIC: "Anthropic", SPACEX: "SpaceX",
  MAG7: "Magnificent 7 basket", SEMIS: "Semiconductors basket", SEMI: "Semiconductors basket",
  BIOTECH: "Biotech basket", DEFENSE: "Defense basket", ENERGY: "Energy basket",
  INFOTECH: "Info-tech basket", NUCLEAR: "Nuclear basket", ROBOT: "Robotics basket",
  US500: "S&P 500", USA500: "S&P 500", SP500: "S&P 500",
  USTECH: "Nasdaq-100", USA100: "Nasdaq-100", SMALL2000: "Russell 2000",
  USBOND: "US Treasuries", USENERGY: "US energy sector", GLDMINE: "Gold miners",
  BTCD: "BTC dominance", TOTAL2: "Crypto ex-BTC mcap", OTHERS: "Alts mcap",
  GOLD: "Gold", SILVER: "Silver", COPPER: "Copper", PLATINUM: "Platinum",
  PALLADIUM: "Palladium", ALUMINIUM: "Aluminium", CORN: "Corn", WHEAT: "Wheat",
  SOY: "Soybeans", URANIUM: "Uranium",
  USOIL: "WTI crude", WTI: "WTI crude", OIL: "Crude oil", BRENTOIL: "Brent crude",
  CL: "WTI crude futures", GAS: "Natural gas", NATGAS: "Natural gas", TTF: "Dutch TTF gas",
  GOLDJM: "Gold (JM oracle)", SILVERJM: "Silver (JM oracle)",
  EUR: "EUR/USD", GBP: "GBP/USD", JPY: "USD/JPY", KRW: "USD/KRW",
  DXY: "US dollar index", VIX: "VIX index", VOL: "Volatility index",
  JP225: "Nikkei 225", KR200: "KOSPI 200", NIFTY: "Nifty 50", IBOV: "Ibovespa",
  XYZ100: "XYZ 100 index", DRAM: "DRAM price index",
};
