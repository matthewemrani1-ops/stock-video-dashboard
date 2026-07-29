import { describe, it, expect, vi, afterEach } from "vitest";
import { getQuote, getFundamentals, getProfile, getAnalystConsensus, getGeneralNews, getPeers, getHistoricalMetrics } from "../src/lib/finnhub.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getQuote", () => {
  it("returns price and change percent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ c: 150.5, dp: 1.2 }) }));
    expect(await getQuote("AAPL", "k")).toEqual({ price: 150.5, changePct: 1.2 });
  });

  it("returns null when there's no current price", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) }));
    expect(await getQuote("AAPL", "k")).toBeNull();
  });

  it("returns null when price is 0 (unrecognized symbol)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ c: 0, dp: 0 }) }));
    expect(await getQuote("INVALID", "k")).toBeNull();
  });
});

describe("getFundamentals", () => {
  it("maps the metric response, including the quant-score fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          metric: {
            peTTM: 22.1,
            marketCapitalization: 3000,
            "52WeekHigh": 200,
            "52WeekLow": 100,
            beta: 1.1,
            pbAnnual: 5.2,
            roeTTM: 18.4,
            netProfitMarginTTM: 12.7,
            "totalDebt/totalEquityAnnual": 0.9,
            "26WeekPriceReturnDaily": 14.3,
            "52WeekPriceReturnDaily": 22.1,
          },
        }),
      })
    );
    expect(await getFundamentals("AAPL", "k")).toEqual({
      pe: 22.1,
      marketCap: 3000,
      week52High: 200,
      week52Low: 100,
      beta: 1.1,
      pb: 5.2,
      roe: 18.4,
      netMargin: 12.7,
      debtToEquity: 0.9,
      return26Week: 14.3,
      return52Week: 22.1,
    });
  });

  it("returns null when there's no metric data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) }));
    expect(await getFundamentals("AAPL", "k")).toBeNull();
  });

  it("defaults the new quant fields to null when Finnhub omits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ metric: { peTTM: 22.1, marketCapitalization: 3000, "52WeekHigh": 200, "52WeekLow": 100, beta: 1.1 } }) })
    );
    const result = await getFundamentals("AAPL", "k");
    expect(result).toEqual({
      pe: 22.1,
      marketCap: 3000,
      week52High: 200,
      week52Low: 100,
      beta: 1.1,
      pb: null,
      roe: null,
      netMargin: null,
      debtToEquity: null,
      return26Week: null,
      return52Week: null,
    });
  });
});

describe("getProfile", () => {
  it("maps the profile response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ name: "Apple Inc", finnhubIndustry: "Technology", weburl: "https://apple.com" }) }));
    expect(await getProfile("AAPL", "k")).toEqual({ industry: "Technology", name: "Apple Inc", weburl: "https://apple.com" });
  });

  it("returns null when name is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ finnhubIndustry: "Technology" }) }));
    expect(await getProfile("AAPL", "k")).toBeNull();
  });
});

describe("getAnalystConsensus", () => {
  it("sums strongBuy+buy and strongSell+sell from the latest period", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [{ strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0, period: "2026-07-01" }] }));
    expect(await getAnalystConsensus("AAPL", "k")).toEqual({ buy: 15, hold: 3, sell: 1, period: "2026-07-01" });
  });

  it("returns null when the response is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] }));
    expect(await getAnalystConsensus("AAPL", "k")).toBeNull();
  });
});

describe("getGeneralNews", () => {
  it("returns the headline list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [{ headline: "Fed holds rates", summary: "..." }] }));
    expect(await getGeneralNews("k")).toEqual([{ headline: "Fed holds rates", summary: "..." }]);
  });
});

describe("getPeers", () => {
  it("returns peer tickers, excluding the symbol itself, capped to 6", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ["AAPL", "DELL", "SNDK", "WDC", "HPE", "NTAP", "HPQ", "P", "SMCI"],
      })
    );
    expect(await getPeers("AAPL", "k")).toEqual(["DELL", "SNDK", "WDC", "HPE", "NTAP", "HPQ"]);
  });

  it("returns an empty array when the response isn't an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) }));
    expect(await getPeers("AAPL", "k")).toEqual([]);
  });
});

describe("getHistoricalMetrics", () => {
  it("extracts the last 5 years of each tracked metric from series.annual", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          series: {
            annual: {
              netMargin: [
                { period: "2025-09-27", v: 0.2692 },
                { period: "2024-09-28", v: 0.2397 },
                { period: "2023-09-30", v: 0.2531 },
                { period: "2022-09-24", v: 0.2531 },
                { period: "2021-09-25", v: 0.2588 },
                { period: "2020-09-26", v: 0.2091 },
              ],
              grossMargin: [{ period: "2025-09-27", v: 0.4621 }],
              roic: [{ period: "2025-09-27", v: 0.6451 }],
              netDebtToTotalEquity: [{ period: "2025-09-27", v: 0.8674 }],
              pe: [{ period: "2025-09-27", v: 33.5574 }],
              pb: [{ period: "2025-09-27", v: 50.978 }],
              pfcf: [{ period: "2025-09-27", v: 38.0568 }],
            },
          },
        }),
      })
    );
    const result = await getHistoricalMetrics("AAPL", "k");
    expect(result?.netMargin).toEqual([
      { period: "2025-09-27", value: 0.2692 },
      { period: "2024-09-28", value: 0.2397 },
      { period: "2023-09-30", value: 0.2531 },
      { period: "2022-09-24", value: 0.2531 },
      { period: "2021-09-25", value: 0.2588 },
    ]);
    expect(result?.netDebtToEquity).toEqual([{ period: "2025-09-27", value: 0.8674 }]);
  });

  it("returns null when there's no series.annual data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) }));
    expect(await getHistoricalMetrics("AAPL", "k")).toBeNull();
  });

  it("defaults a missing field to an empty array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ series: { annual: { netMargin: [{ period: "2025-09-27", v: 0.27 }] } } }) })
    );
    const result = await getHistoricalMetrics("AAPL", "k");
    expect(result?.pfcf).toEqual([]);
  });
});
