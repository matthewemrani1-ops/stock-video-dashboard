const QUIVER_URL = "https://api.quiverquant.com/beta/live/congresstrading";
const LOOKBACK_DAYS = 30;
const TOP_N = 10;

interface RawTrade {
  Representative?: string;
  Ticker?: string;
  Transaction?: string;
  Amount?: string | number;
  TransactionDate?: string;
  Party?: string;
  House?: string;
  TickerType?: string;
  PriceChange?: string | number;
}

export interface CongressTrader {
  name: string;
  party: string;
  chamber: string;
  returnPct: number;
  tradeCount: number;
  topHolding: string | null;
}

function toNumber(v: string | number | undefined): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function cutoffDate(now: Date): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - LOOKBACK_DAYS);
  return d;
}

function isWithinWindow(dateStr: string | undefined, cutoff: Date): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime()) && d >= cutoff;
}

function computeTopHolding(allTrades: RawTrade[], representative: string, cutoff: Date): string | null {
  const memberTrades = allTrades.filter(
    (t) => t.Representative === representative && isWithinWindow(t.TransactionDate, cutoff) && t.TickerType === "ST" && !!t.Ticker
  );

  const holdings = new Map<string, number>();
  for (const t of memberTrades) {
    const ticker = t.Ticker as string;
    const tx = (t.Transaction || "").toLowerCase();
    const amt = toNumber(t.Amount) || 1000;
    const current = holdings.get(ticker) || 0;
    if (tx.includes("purchase")) {
      holdings.set(ticker, current + amt);
    } else if (tx.includes("sale")) {
      holdings.set(ticker, current - amt);
    }
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

export function computeCongressRanking(trades: RawTrade[], now: Date = new Date(), topN: number = TOP_N): CongressTrader[] {
  const cutoff = cutoffDate(now);

  const purchases = trades.filter(
    (t) =>
      isWithinWindow(t.TransactionDate, cutoff) &&
      typeof t.Transaction === "string" &&
      t.Transaction.toLowerCase().includes("purchase") &&
      !!t.Ticker &&
      t.TickerType === "ST" &&
      !!t.Representative
  );

  const byMember = new Map<string, RawTrade[]>();
  for (const t of purchases) {
    const key = t.Representative as string;
    if (!byMember.has(key)) byMember.set(key, []);
    byMember.get(key)!.push(t);
  }

  const ranked: CongressTrader[] = Array.from(byMember.entries()).map(([name, memberTrades]) => {
    const totalAmt = memberTrades.reduce((sum, t) => sum + toNumber(t.Amount), 0);
    const returnPct =
      totalAmt === 0
        ? memberTrades.reduce((sum, t) => sum + toNumber(t.PriceChange), 0) / memberTrades.length
        : memberTrades.reduce((sum, t) => sum + toNumber(t.PriceChange) * toNumber(t.Amount), 0) / totalAmt;
    return {
      name,
      party: memberTrades[0].Party || "?",
      chamber: memberTrades[0].House || "?",
      returnPct,
      tradeCount: memberTrades.length,
      topHolding: computeTopHolding(trades, name, cutoff),
    };
  });

  ranked.sort((a, b) => b.returnPct - a.returnPct);
  return ranked.slice(0, topN);
}

export async function getTopCongressTraders(): Promise<CongressTrader[]> {
  try {
    const res = await fetch(QUIVER_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const trades = (await res.json()) as unknown;
    if (!Array.isArray(trades)) return [];
    return computeCongressRanking(trades as RawTrade[]);
  } catch {
    return [];
  }
}
