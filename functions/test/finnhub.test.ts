import { describe, it, expect, vi, afterEach } from "vitest";
import { getQuote, getFundamentals, getProfile, getAnalystConsensus, getGeneralNews } from "../src/lib/finnhub.js";

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
});

describe("getFundamentals", () => {
  it("maps the metric response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ metric: { peTTM: 22.1, marketCapitalization: 3000, "52WeekHigh": 200, "52WeekLow": 100, beta: 1.1 } }) })
    );
    expect(await getFundamentals("AAPL", "k")).toEqual({ pe: 22.1, marketCap: 3000, week52High: 200, week52Low: 100, beta: 1.1 });
  });

  it("returns null when there's no metric data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) }));
    expect(await getFundamentals("AAPL", "k")).toBeNull();
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
