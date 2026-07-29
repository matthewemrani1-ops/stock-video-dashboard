import { describe, it, expect, vi } from "vitest";
import { parseCapitolTrade, computeCongressRanking, runCongressTradersUpdate, type RawCapitolTrade, type ParsedTrade } from "../src/lib/congress.js";

const NOW = new Date("2026-07-28T12:00:00Z");

function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  const day = d.getUTCDate();
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function rawTrade(overrides: Partial<RawCapitolTrade> = {}): RawCapitolTrade {
  return {
    politician_name: "Alice Example",
    politician_family: "Democrat House CA",
    traded_issuer_ticker: "AAPL:US",
    published: daysAgo(5),
    traded: daysAgo(5),
    filed_after: "5 days",
    owner: "Self",
    type: "buy",
    size: "1K–15K",
    price: "100.00",
    ...overrides,
  };
}

describe("parseCapitolTrade", () => {
  it("parses a well-formed trade", () => {
    const result = parseCapitolTrade(rawTrade());
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Alice Example");
    expect(result?.party).toBe("Democrat");
    expect(result?.chamber).toBe("House");
    expect(result?.ticker).toBe("AAPL");
    expect(result?.type).toBe("buy");
    expect(result?.tradePrice).toBe(100);
  });

  it("strips the :EXCHANGE suffix from the ticker", () => {
    const result = parseCapitolTrade(rawTrade({ traded_issuer_ticker: "MSFT:US" }));
    expect(result?.ticker).toBe("MSFT");
  });

  it("normalizes type to lowercase buy/sell, defaulting anything else to buy", () => {
    expect(parseCapitolTrade(rawTrade({ type: "sell" }))?.type).toBe("sell");
    expect(parseCapitolTrade(rawTrade({ type: "SELL" }))?.type).toBe("sell");
    expect(parseCapitolTrade(rawTrade({ type: "buy" }))?.type).toBe("buy");
  });

  it("parses a two-sided size bucket as the midpoint", () => {
    expect(parseCapitolTrade(rawTrade({ size: "1K–15K" }))?.sizeAmount).toBe(8000);
    expect(parseCapitolTrade(rawTrade({ size: "1M–5M" }))?.sizeAmount).toBe(3_000_000);
  });

  it("parses an open-ended size bucket as its lower bound", () => {
    expect(parseCapitolTrade(rawTrade({ size: "50M+" }))?.sizeAmount).toBe(50_000_000);
  });

  it("treats a missing or invalid price as null, not zero", () => {
    expect(parseCapitolTrade(rawTrade({ price: undefined }))?.tradePrice).toBeNull();
    expect(parseCapitolTrade(rawTrade({ price: "N/A" }))?.tradePrice).toBeNull();
  });

  it("returns null when politician_name is missing", () => {
    expect(parseCapitolTrade(rawTrade({ politician_name: undefined }))).toBeNull();
  });

  it("returns null when traded_issuer_ticker is missing", () => {
    expect(parseCapitolTrade(rawTrade({ traded_issuer_ticker: undefined }))).toBeNull();
  });

  it("returns null when the traded date is missing or unparseable", () => {
    expect(parseCapitolTrade(rawTrade({ traded: undefined }))).toBeNull();
    expect(parseCapitolTrade(rawTrade({ traded: "not a date" }))).toBeNull();
  });
});

function parsedTrade(overrides: Partial<ParsedTrade> = {}): ParsedTrade {
  return {
    name: "Alice Example",
    party: "Democrat",
    chamber: "House",
    ticker: "AAPL",
    type: "buy",
    sizeAmount: 8000,
    tradePrice: 100,
    tradedDate: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

describe("computeCongressRanking", () => {
  it("computes a member's return from current price vs. trade price", () => {
    const trades = [parsedTrade({ tradePrice: 100 })];
    const prices = new Map([["AAPL", 110]]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].returnPct).toBeCloseTo(10, 5); // (110-100)/100 * 100
  });

  it("excludes a member entirely when none of their trades have a resolvable price", () => {
    const trades = [parsedTrade({ ticker: "AAPL", tradePrice: 100 })];
    const prices = new Map<string, number>(); // no AAPL price available
    expect(computeCongressRanking(trades, prices, NOW)).toEqual([]);
  });

  it("excludes trades with a null tradePrice from the return calc, but still counts tradeCount", () => {
    const trades = [
      parsedTrade({ ticker: "AAPL", tradePrice: 100 }),
      parsedTrade({ ticker: "AAPL", tradePrice: null }),
    ];
    const prices = new Map([["AAPL", 110]]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result[0].returnPct).toBeCloseTo(10, 5); // only the priced trade counts
    expect(result[0].tradeCount).toBe(2); // both qualifying buys still counted
  });

  it("weights the average return by size when multiple trades have different sizes", () => {
    const trades = [
      parsedTrade({ ticker: "AAPL", tradePrice: 100, sizeAmount: 10000 }), // return 10%
      parsedTrade({ ticker: "MSFT", tradePrice: 200, sizeAmount: 30000 }), // return 2%
    ];
    const prices = new Map([
      ["AAPL", 110],
      ["MSFT", 204],
    ]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result[0].returnPct).toBeCloseTo((10 * 10000 + 2 * 30000) / 40000, 5); // = 4
  });

  it("falls back to an unweighted average when total size weight is zero", () => {
    const trades = [
      parsedTrade({ ticker: "AAPL", tradePrice: 100, sizeAmount: 0 }), // return 10%
      parsedTrade({ ticker: "MSFT", tradePrice: 200, sizeAmount: 0 }), // return 20%
    ];
    const prices = new Map([
      ["AAPL", 110],
      ["MSFT", 240],
    ]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result[0].returnPct).toBeCloseTo(15, 5); // unweighted average of 10 and 20
  });

  it("excludes sell trades from the ranking", () => {
    const trades = [parsedTrade({ type: "sell", tradePrice: 100 })];
    const prices = new Map([["AAPL", 110]]);
    expect(computeCongressRanking(trades, prices, NOW)).toEqual([]);
  });

  it("excludes trades traded more than 30 days ago", () => {
    const trades = [parsedTrade({ tradedDate: new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000) })];
    const prices = new Map([["AAPL", 110]]);
    expect(computeCongressRanking(trades, prices, NOW)).toEqual([]);
  });

  it("excludes trades dated in the future", () => {
    const trades = [parsedTrade({ tradedDate: new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000) })];
    const prices = new Map([["AAPL", 110]]);
    expect(computeCongressRanking(trades, prices, NOW)).toEqual([]);
  });

  it("ranks descending by return and limits to topN", () => {
    const trades = [
      parsedTrade({ name: "Alice", ticker: "AAPL", tradePrice: 100 }), // 5%
      parsedTrade({ name: "Bob", ticker: "MSFT", tradePrice: 100 }), // 20%
      parsedTrade({ name: "Carol", ticker: "NVDA", tradePrice: 100 }), // 10%
    ];
    const prices = new Map([
      ["AAPL", 105],
      ["MSFT", 120],
      ["NVDA", 110],
    ]);
    const result = computeCongressRanking(trades, prices, NOW, 2);
    expect(result.map((r) => r.name)).toEqual(["Bob", "Carol"]);
  });

  it("computes topHolding from net buy-minus-sell size across both buy and sell trades", () => {
    const trades = [
      parsedTrade({ ticker: "AAPL", type: "buy", sizeAmount: 8000, tradePrice: 100 }),
      parsedTrade({ ticker: "MSFT", type: "buy", sizeAmount: 32500, tradePrice: 100 }),
      parsedTrade({ ticker: "AAPL", type: "sell", sizeAmount: 3000 }),
    ];
    const prices = new Map([
      ["AAPL", 110],
      ["MSFT", 110],
    ]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result[0].topHolding).toBe("MSFT"); // net AAPL = 5000, net MSFT = 32500
  });

  it("returns a null topHolding when a member has no positive net position", () => {
    const trades = [
      parsedTrade({ ticker: "AAPL", type: "buy", sizeAmount: 8000, tradePrice: 100 }),
      parsedTrade({ ticker: "AAPL", type: "sell", sizeAmount: 8000 }),
    ];
    const prices = new Map([["AAPL", 110]]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result[0].topHolding).toBeNull();
  });
});

describe("runCongressTradersUpdate", () => {
  const secrets = { apifyToken: "at", finnhubKey: "fk" };

  function rawItem(overrides: Partial<RawCapitolTrade> = {}): RawCapitolTrade {
    return {
      politician_name: "Alice Example",
      politician_family: "Democrat House CA",
      traded_issuer_ticker: "AAPL:US",
      published: daysAgo(5),
      traded: daysAgo(5),
      filed_after: "5 days",
      owner: "Self",
      type: "buy",
      size: "1K–15K",
      price: "100.00",
      ...overrides,
    };
  }

  it("writes the computed ranking to the doc on success", async () => {
    const setDoc = vi.fn().mockResolvedValue(undefined);
    const deps = {
      runActor: vi.fn().mockResolvedValue([rawItem()]),
      getQuote: vi.fn().mockResolvedValue({ price: 110, changePct: 1 }),
      setDoc,
    };
    await runCongressTradersUpdate(secrets, deps, NOW);
    expect(setDoc).toHaveBeenCalledTimes(1);
    const written = setDoc.mock.calls[0][0];
    expect(written.traders).toHaveLength(1);
    expect(written.traders[0].name).toBe("Alice Example");
    expect(typeof written.computedAt).toBe("number");
  });

  it("leaves the existing doc untouched when the Apify run fails", async () => {
    const setDoc = vi.fn().mockResolvedValue(undefined);
    const deps = {
      runActor: vi.fn().mockRejectedValue(new Error("Apify 500")),
      getQuote: vi.fn(),
      setDoc,
    };
    await runCongressTradersUpdate(secrets, deps, NOW);
    expect(setDoc).not.toHaveBeenCalled();
  });

  it("dedupes Finnhub calls to one per distinct ticker", async () => {
    const getQuote = vi.fn().mockResolvedValue({ price: 110, changePct: 1 });
    const deps = {
      runActor: vi.fn().mockResolvedValue([
        rawItem({ politician_name: "Alice Example" }),
        rawItem({ politician_name: "Bob Example", politician_family: "Republican Senate TX" }),
      ]),
      getQuote,
      setDoc: vi.fn().mockResolvedValue(undefined),
    };
    await runCongressTradersUpdate(secrets, deps, NOW);
    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(getQuote).toHaveBeenCalledWith("AAPL", "fk");
  });

  it("excludes a ticker from the ranking when its Finnhub lookup fails, without failing the whole run", async () => {
    const setDoc = vi.fn().mockResolvedValue(undefined);
    const deps = {
      runActor: vi.fn().mockResolvedValue([rawItem()]),
      getQuote: vi.fn().mockRejectedValue(new Error("Finnhub 429")),
      setDoc,
    };
    await runCongressTradersUpdate(secrets, deps, NOW);
    expect(setDoc).toHaveBeenCalledTimes(1);
    expect(setDoc.mock.calls[0][0].traders).toEqual([]);
  });
});
