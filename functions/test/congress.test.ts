import { describe, it, expect, vi, afterEach } from "vitest";
import { computeCongressRanking, getTopCongressTraders } from "../src/lib/congress.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date("2026-07-28T12:00:00Z");

function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe("computeCongressRanking", () => {
  it("excludes trades older than 30 days", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 10000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Bob", Ticker: "TSLA", Transaction: "Purchase", Amount: 10000, TransactionDate: daysAgo(40), Party: "R", House: "Senate", TickerType: "ST", PriceChange: 20 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result.map((r) => r.name)).toEqual(["Alice"]);
  });

  it("excludes non-purchase transactions from the ranking", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Sale (Full)", Amount: 10000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result).toEqual([]);
  });

  it("excludes non-ST ticker types (e.g. options)", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 10000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "OP", PriceChange: 5 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result).toEqual([]);
  });

  it("computes the amount-weighted average return per member", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 10000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 10 },
      { Representative: "Alice", Ticker: "MSFT", Transaction: "Purchase", Amount: 30000, TransactionDate: daysAgo(3), Party: "D", House: "House", TickerType: "ST", PriceChange: 2 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].returnPct).toBeCloseTo(4, 5); // (10*10000 + 2*30000) / 40000 = 4
    expect(result[0].tradeCount).toBe(2);
  });

  it("falls back to an unweighted average return when total disclosed amount is zero", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 0, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 10 },
      { Representative: "Alice", Ticker: "MSFT", Transaction: "Purchase", Amount: 0, TransactionDate: daysAgo(3), Party: "D", House: "House", TickerType: "ST", PriceChange: 20 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result[0].returnPct).toBeCloseTo(15, 5); // unweighted average of 10 and 20
  });

  it("ranks descending by return and limits to topN", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 1000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Bob", Ticker: "TSLA", Transaction: "Purchase", Amount: 1000, TransactionDate: daysAgo(5), Party: "R", House: "Senate", TickerType: "ST", PriceChange: 20 },
      { Representative: "Carol", Ticker: "NVDA", Transaction: "Purchase", Amount: 1000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 10 },
    ];
    const result = computeCongressRanking(trades, NOW, 2);
    expect(result.map((r) => r.name)).toEqual(["Bob", "Carol"]);
  });

  it("computes topHolding as the ticker with the largest net positive position", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 5000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Alice", Ticker: "MSFT", Transaction: "Purchase", Amount: 20000, TransactionDate: daysAgo(4), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Sale (Partial)", Amount: 3000, TransactionDate: daysAgo(2), Party: "D", House: "House", TickerType: "ST", PriceChange: 0 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result[0].topHolding).toBe("MSFT"); // net AAPL = 2000, net MSFT = 20000
  });

  it("returns a null topHolding when a member has no positive net exposure", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 5000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Sale (Full)", Amount: 5000, TransactionDate: daysAgo(2), Party: "D", House: "House", TickerType: "ST", PriceChange: 0 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result).toHaveLength(1); // still ranked (has a qualifying purchase)
    expect(result[0].topHolding).toBeNull();
  });

  it("excludes trades with future TransactionDate from the 30-day window", () => {
    // A trade dated in the future should not be included in the ranking
    const futureDate = new Date(NOW);
    futureDate.setDate(futureDate.getDate() + 5);
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 10000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Bob", Ticker: "TSLA", Transaction: "Purchase", Amount: 10000, TransactionDate: futureDate.toISOString(), Party: "R", House: "Senate", TickerType: "ST", PriceChange: 20 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result.map((r) => r.name)).toEqual(["Alice"]);
  });

  it("correctly identifies topHolding when one ticker has Amount: 0 and another has nonzero Amount", () => {
    // A member with Amount: 0 purchase on one ticker and Amount: 500 on another
    // should have the nonzero ticker as topHolding, not the zero-amount one
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 0, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Alice", Ticker: "MSFT", Transaction: "Purchase", Amount: 500, TransactionDate: daysAgo(4), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result).toHaveLength(1);
    // Without the fix, AAPL gets 0+1000=1000 (via falsy coercion) and wins as topHolding
    // With the fix, AAPL gets 0 and MSFT gets 500, so MSFT is topHolding
    expect(result[0].topHolding).toBe("MSFT");
  });
});

describe("getTopCongressTraders", () => {
  it("returns the ranked list on a successful fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 10000, TransactionDate: new Date().toISOString(), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
        ],
      })
    );
    const result = await getTopCongressTraders();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Alice");
  });

  it("returns an empty array when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network error")));
    expect(await getTopCongressTraders()).toEqual([]);
  });

  it("returns an empty array when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false }));
    expect(await getTopCongressTraders()).toEqual([]);
  });

  it("returns an empty array when the response body isn't an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ error: "rate limited" }) }));
    expect(await getTopCongressTraders()).toEqual([]);
  });
});
