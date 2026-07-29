const LOOKBACK_DAYS = 30;
const TOP_N = 10;

export interface RawCapitolTrade {
  politician_name?: string;
  politician_family?: string;
  traded_issuer_ticker?: string;
  published?: string;
  traded?: string;
  filed_after?: string;
  owner?: string;
  type?: string;
  size?: string;
  price?: string;
}

export interface ParsedTrade {
  name: string;
  party: string;
  chamber: string;
  ticker: string;
  type: "buy" | "sell";
  sizeAmount: number;
  tradePrice: number | null;
  tradedDate: Date;
}

export interface CongressTrader {
  name: string;
  party: string;
  chamber: string;
  returnPct: number;
  tradeCount: number;
  topHolding: string | null;
}

function parseSizeBucket(size: string | undefined): number {
  if (!size) return 0;
  const cleaned = size.replace(/,/g, "").trim();
  const parseValue = (s: string): number => {
    const m = s.match(/^([\d.]+)\s*([KM]?)/i);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    const mult = m[2].toUpperCase() === "M" ? 1_000_000 : m[2].toUpperCase() === "K" ? 1_000 : 1;
    return num * mult;
  };
  if (cleaned.endsWith("+")) {
    return parseValue(cleaned.slice(0, -1));
  }
  const parts = cleaned.split(/[–-]/);
  if (parts.length !== 2) return parseValue(cleaned);
  return (parseValue(parts[0]) + parseValue(parts[1])) / 2;
}

export function parseCapitolTrade(raw: RawCapitolTrade): ParsedTrade | null {
  if (!raw.politician_name || !raw.traded_issuer_ticker || !raw.traded) return null;
  const tradedDate = new Date(raw.traded);
  if (isNaN(tradedDate.getTime())) return null;

  const ticker = raw.traded_issuer_ticker.split(":")[0];
  const familyParts = (raw.politician_family || "").split(/\s+/);
  const party = familyParts[0] || "?";
  const chamber = familyParts[1] || "?";
  const type: "buy" | "sell" = (raw.type || "").toLowerCase() === "sell" ? "sell" : "buy";
  const sizeAmount = parseSizeBucket(raw.size);
  const priceNum = raw.price ? parseFloat(raw.price) : NaN;
  const tradePrice = !isNaN(priceNum) && priceNum > 0 ? priceNum : null;

  return { name: raw.politician_name, party, chamber, ticker, type, sizeAmount, tradePrice, tradedDate };
}

function isWithinWindow(d: Date, cutoff: Date, now: Date): boolean {
  return d >= cutoff && d <= now;
}

function computeTopHolding(allTrades: ParsedTrade[], name: string, cutoff: Date, now: Date): string | null {
  const memberTrades = allTrades.filter((t) => t.name === name && isWithinWindow(t.tradedDate, cutoff, now));
  const holdings = new Map<string, number>();
  for (const t of memberTrades) {
    const current = holdings.get(t.ticker) || 0;
    holdings.set(t.ticker, t.type === "buy" ? current + t.sizeAmount : current - t.sizeAmount);
  }
  let topTicker: string | null = null;
  let topAmount = 0;
  for (const [ticker, amt] of holdings.entries()) {
    if (amt > 0 && amt > topAmount) {
      topTicker = ticker;
      topAmount = amt;
    }
  }
  return topTicker;
}

export function computeCongressRanking(
  trades: ParsedTrade[],
  priceByTicker: Map<string, number>,
  now: Date = new Date(),
  topN: number = TOP_N
): CongressTrader[] {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);

  const buys = trades.filter((t) => t.type === "buy" && isWithinWindow(t.tradedDate, cutoff, now));

  const byMember = new Map<string, ParsedTrade[]>();
  for (const t of buys) {
    if (!byMember.has(t.name)) byMember.set(t.name, []);
    byMember.get(t.name)!.push(t);
  }

  const ranked: CongressTrader[] = [];
  for (const [name, memberTrades] of byMember.entries()) {
    const returns: { pct: number; weight: number }[] = [];
    for (const t of memberTrades) {
      const currentPrice = priceByTicker.get(t.ticker);
      if (t.tradePrice == null || currentPrice == null) continue;
      returns.push({ pct: ((currentPrice - t.tradePrice) / t.tradePrice) * 100, weight: t.sizeAmount });
    }
    if (returns.length === 0) continue;

    const totalWeight = returns.reduce((sum, r) => sum + r.weight, 0);
    const returnPct =
      totalWeight === 0
        ? returns.reduce((sum, r) => sum + r.pct, 0) / returns.length
        : returns.reduce((sum, r) => sum + r.pct * r.weight, 0) / totalWeight;

    ranked.push({
      name,
      party: memberTrades[0].party,
      chamber: memberTrades[0].chamber,
      returnPct,
      tradeCount: memberTrades.length,
      topHolding: computeTopHolding(trades, name, cutoff, now),
    });
  }

  ranked.sort((a, b) => b.returnPct - a.returnPct);
  return ranked.slice(0, topN);
}

const CONGRESS_ACTOR_ID = "VyNAX2PeuvQ8UQ7FK";

export interface CongressDeps {
  runActor: (actorId: string, token: string, input: object) => Promise<unknown[]>;
  getQuote: (sym: string, key: string) => Promise<{ price: number; changePct: number } | null>;
  setDoc: (data: { traders: CongressTrader[]; computedAt: number }) => Promise<void>;
}

export async function runCongressTradersUpdate(
  secrets: { apifyToken: string; finnhubKey: string },
  deps: CongressDeps,
  now: Date = new Date()
): Promise<void> {
  let rawItems: unknown[];
  try {
    rawItems = await deps.runActor(CONGRESS_ACTOR_ID, secrets.apifyToken, {
      start_urls: ["https://www.capitoltrades.com/trades?pageSize=96&txDate=90d"],
      max_page: 1,
    });
  } catch (e) {
    console.error("Congress trades Apify run failed:", e);
    return; // leave the existing doc untouched
  }

  const parsed: ParsedTrade[] = [];
  for (const item of rawItems) {
    const t = parseCapitolTrade(item as RawCapitolTrade);
    if (t) parsed.push(t);
  }

  const tickers = Array.from(new Set(parsed.map((t) => t.ticker)));
  const priceByTicker = new Map<string, number>();
  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const quote = await deps.getQuote(ticker, secrets.finnhubKey);
        if (quote) priceByTicker.set(ticker, quote.price);
      } catch {
        // leave this ticker unpriced -> its trades are excluded from the return calc
      }
    })
  );

  const traders = computeCongressRanking(parsed, priceByTicker, now);
  await deps.setDoc({ traders, computedAt: Date.now() });
}
