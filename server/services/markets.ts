/**
 * Markets PFAT can price, and how each provider names a symbol on them. The Alpha Vantage suffixes are the ones
 * its documentation gives (e.g. SHOP.TRT, TSCO.LON). Finnhub's free plan only quotes US stocks (and crypto with
 * an exchange prefix such as BINANCE:BTCUSDT).
 */

export type MarketId =
  | "US"
  | "TSX"
  | "TSXV"
  | "LSE"
  | "XETRA"
  | "BSE"
  | "SSE"
  | "SZSE"
  | "CRYPTO"
  | "METAL"
  | "OTHER";

export interface Market {
  id: MarketId;
  label: string;
  group: "Stock exchanges" | "Other";
  /** Instrument types that make sense here (first = default). */
  kinds: string[];
  currency: string;
  /** Alpha Vantage symbol suffix; "" = none (US); null = Alpha Vantage doesn't price it. */
  alphaVantageSuffix: string | null;
  finnhub: boolean;
  priceSource: "auto" | "manual";
  note?: string;
}

export const MARKETS: Market[] = [
  {
    id: "US",
    label: "US — NYSE, Nasdaq",
    group: "Stock exchanges",
    kinds: ["equity", "etf", "fund"],
    currency: "USD",
    alphaVantageSuffix: "",
    finnhub: true,
    priceSource: "auto",
  },
  {
    id: "TSX",
    label: "Toronto Stock Exchange (TSX)",
    group: "Stock exchanges",
    kinds: ["equity", "etf", "fund"],
    currency: "CAD",
    alphaVantageSuffix: ".TRT",
    finnhub: false,
    priceSource: "auto",
  },
  {
    id: "TSXV",
    label: "TSX Venture Exchange",
    group: "Stock exchanges",
    kinds: ["equity", "etf"],
    currency: "CAD",
    alphaVantageSuffix: ".TRV",
    finnhub: false,
    priceSource: "auto",
  },
  {
    id: "LSE",
    label: "London Stock Exchange",
    group: "Stock exchanges",
    kinds: ["equity", "etf", "fund"],
    currency: "GBP",
    alphaVantageSuffix: ".LON",
    finnhub: false,
    priceSource: "auto",
    note: "London prices are often quoted in pence (GBX), not pounds. Check a price before relying on it.",
  },
  {
    id: "XETRA",
    label: "XETRA (Germany)",
    group: "Stock exchanges",
    kinds: ["equity", "etf", "fund"],
    currency: "EUR",
    alphaVantageSuffix: ".DEX",
    finnhub: false,
    priceSource: "auto",
  },
  {
    id: "BSE",
    label: "BSE (India)",
    group: "Stock exchanges",
    kinds: ["equity", "etf"],
    currency: "INR",
    alphaVantageSuffix: ".BSE",
    finnhub: false,
    priceSource: "auto",
  },
  {
    id: "SSE",
    label: "Shanghai Stock Exchange",
    group: "Stock exchanges",
    kinds: ["equity", "etf"],
    currency: "CNY",
    alphaVantageSuffix: ".SHH",
    finnhub: false,
    priceSource: "auto",
  },
  {
    id: "SZSE",
    label: "Shenzhen Stock Exchange",
    group: "Stock exchanges",
    kinds: ["equity", "etf"],
    currency: "CNY",
    alphaVantageSuffix: ".SHZ",
    finnhub: false,
    priceSource: "auto",
  },
  {
    id: "CRYPTO",
    label: "Crypto",
    group: "Other",
    kinds: ["crypto"],
    currency: "USD",
    alphaVantageSuffix: "",
    finnhub: true,
    priceSource: "auto",
    note: "Use the coin's code, e.g. BTC or ETH. The currency is the market it's priced in.",
  },
  {
    id: "METAL",
    label: "Precious metal",
    group: "Other",
    kinds: ["metal"],
    currency: "USD",
    alphaVantageSuffix: "",
    finnhub: false,
    priceSource: "auto",
    note: "Spot price per troy ounce.",
  },
  {
    id: "OTHER",
    label: "Other — I'll enter prices",
    group: "Other",
    kinds: ["other", "equity", "fund", "metal"],
    currency: "CAD",
    alphaVantageSuffix: null,
    finnhub: false,
    priceSource: "manual",
    note: "For anything without a price feed: coins, art, private shares, unlisted exchanges.",
  },
];

export const METALS: { code: string; name: string }[] = [
  { code: "XAU", name: "Gold" },
  { code: "XAG", name: "Silver" },
  { code: "XPT", name: "Platinum" },
  { code: "XPD", name: "Palladium" },
];

export function getMarket(id: string): Market | undefined {
  return MARKETS.find((m) => m.id === id);
}

/** A sensible market for instruments created without one (older API callers, older data). */
export function defaultMarket(kind: string, priceSource: string): MarketId {
  if (priceSource === "manual") return "OTHER";
  if (kind === "crypto") return "CRYPTO";
  if (kind === "metal") return "METAL";
  return "US";
}

/**
 * The symbol PFAT stores and prices under (Alpha Vantage's form), e.g. SHOP on TSX → SHOP.TRT.
 * Used as the price-cache key too.
 */
export function canonicalSymbol(marketId: string, symbol: string): string {
  const m = getMarket(marketId);
  const s = symbol.trim().toUpperCase();
  if (!m || m.alphaVantageSuffix === null || m.alphaVantageSuffix === "") return s;
  return s.endsWith(m.alphaVantageSuffix) ? s : `${s}${m.alphaVantageSuffix}`;
}

/** Which providers can price this market, for the "Prices: … from …" hint. */
export function providersFor(marketId: string, providerSymbol: string): string[] {
  const m = getMarket(marketId);
  if (!m || m.priceSource === "manual") return [];
  const out: string[] = [];
  if (m.alphaVantageSuffix !== null) out.push("alphavantage");
  if (m.finnhub && (m.id !== "CRYPTO" || providerSymbol.includes(":"))) out.push("finnhub");
  return out;
}
