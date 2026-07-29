import { describe, it, expect, vi } from "vitest";
import { runPipeline, type PipelineDeps, type PipelineInput } from "../src/lib/pipeline.js";

function baseDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    runActor: vi.fn().mockResolvedValue([{ transcript: "AAPL is a solid buy", url: "https://ig.com/p/1", pageName: "trader1", timestamp: input.targetDate.getTime() }]),
    extractTickers: vi.fn().mockResolvedValue([{ ticker: "AAPL", company: "Apple", view: "buy", buyLevel: "", sellLevel: "", recap: "bullish", quote: "" }]),
    videoWrap: vi.fn().mockResolvedValue("wrap text"),
    marketRecap: vi.fn().mockResolvedValue("recap text"),
    marketHealth: vi.fn().mockResolvedValue("health text"),
    getQuote: vi.fn().mockResolvedValue({ price: 200, changePct: 1 }),
    getFundamentals: vi.fn().mockResolvedValue({
      pe: 20,
      marketCap: 3000,
      week52High: 220,
      week52Low: 150,
      beta: 1.1,
      pb: 3,
      roe: 20,
      netMargin: 15,
      debtToEquity: 0.8,
      return26Week: 10,
      return52Week: 20,
    }),
    getProfile: vi.fn().mockResolvedValue({ industry: "Tech", name: "Apple", weburl: "https://apple.com" }),
    getAnalystConsensus: vi.fn().mockResolvedValue({ buy: 10, hold: 2, sell: 1, period: "2026-07" }),
    getGeneralNews: vi.fn().mockResolvedValue([{ headline: "Fed holds" }]),
    fredLatest: vi.fn().mockResolvedValue({ value: 4.3, date: "2026-07-20" }),
    fredYoY: vi.fn().mockResolvedValue({ value: 2.9, date: "2026-07-20" }),
    fredWithPrior: vi.fn().mockResolvedValue({ value: 220000, prior: 215000, date: "2026-07-20" }),
    quantExplanation: vi.fn().mockResolvedValue("Solid low-volatility profile driven by beta near 1.0."),
    getPeers: vi.fn().mockResolvedValue([]),
    getHistoricalMetrics: vi.fn().mockResolvedValue(null),
    sleep: vi.fn().mockResolvedValue(undefined),
    tickerDeepDive: vi.fn().mockResolvedValue({
      businessTeardown: "Sells premium hardware, software, and services.",
      financialHealth: "Margins have been stable and improving.",
      valuation: "Trading in line with historical multiples.",
      bearCase: "1) Growth slowing. 2) Regulatory risk. 3) Multiple compression.",
      catalysts: "Next earnings call in 6 weeks.",
      positionSizing: "Cap around 3% of portfolio.",
      quarterlyReview: { verdict: "Buy", reasoning: "Yes, at this price." },
    }),
    ...overrides,
  };
}

const input: PipelineInput = {
  dateLabel: "Jul 23, 2026",
  targetDate: new Date("2026-07-23T12:00:00"),
  trackedHandles: ["trader1"],
  topN: 15,
  secrets: { apifyToken: "at", actorId: "apify/instagram-reel-scraper", aiKey: "ak", model: "claude-haiku-4-5-20251001", priceKey: "pk", fredKey: "fk" },
};

describe("runPipeline", () => {
  it("produces a complete digest on the happy path", async () => {
    const doc = await runPipeline(input, baseDeps());
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers).toHaveLength(1);
    expect(doc.rankedTickers[0].sym).toBe("AAPL");
    expect(doc.rankedTickers[0].fundamentals).toEqual({
      pe: 20,
      marketCap: 3000,
      week52High: 220,
      week52Low: 150,
      beta: 1.1,
      pb: 3,
      roe: 20,
      netMargin: 15,
      debtToEquity: 0.8,
      return26Week: 10,
      return52Week: 20,
    });
    expect(doc.screen.AAPL.verdict).toBe("Pass");
    expect(doc.videoWrap).toBe("wrap text");
    expect(doc.marketRecap).toBe("recap text");
    expect(doc.marketHealth).toBe("health text");
    expect(doc.skippedReelCount).toBe(0);
  });

  it("records a reelError and keeps rankedTickers empty when Apify fails, without failing the whole run", async () => {
    const deps = baseDeps({ runActor: vi.fn().mockRejectedValue(new Error("Apify 401 — bad token")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.reelError).toContain("bad token");
    expect(doc.rankedTickers).toEqual([]);
  });

  it("still computes FRED and market health when Apify fails", async () => {
    const deps = baseDeps({ runActor: vi.fn().mockRejectedValue(new Error("403 — Monthly usage hard limit exceeded")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.reelError).toContain("Monthly usage hard limit exceeded");
    expect(doc.fred).toBeDefined();
    expect(doc.fred?.length).toBeGreaterThan(0);
    expect(doc.marketHealth).toBe("health text");
    expect(doc.marketRecap).toBe("recap text");
  });

  it("skips a reel whose extraction fails and keeps going", async () => {
    const deps = baseDeps({
      runActor: vi.fn().mockResolvedValue([
        { transcript: "AAPL is a solid buy", url: "https://ig.com/p/1", pageName: "trader1", timestamp: input.targetDate.getTime() },
        { transcript: "NVDA looks strong", url: "https://ig.com/p/2", pageName: "trader1", timestamp: input.targetDate.getTime() },
      ]),
      extractTickers: vi
        .fn()
        .mockResolvedValueOnce([{ ticker: "AAPL", company: "Apple", view: "buy", buyLevel: "", sellLevel: "", recap: "", quote: "" }])
        .mockRejectedValueOnce(new Error("AI 500")),
    });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.skippedReelCount).toBe(1);
    expect(doc.rankedTickers.map((r) => r.sym)).toEqual(["AAPL"]);
  });

  it("marks a ticker's fundamentals unavailable when Finnhub fails for it, without failing the run", async () => {
    const deps = baseDeps({ getFundamentals: vi.fn().mockRejectedValue(new Error("Finnhub 429")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers[0].fundamentals).toBeUndefined();
  });

  it("keeps the other FRED indicators when only one call fails", async () => {
    const deps = baseDeps({
      fredLatest: vi.fn().mockImplementation((seriesId: string) => {
        if (seriesId === "UNRATE") return Promise.reject(new Error("FRED 500"));
        return Promise.resolve({ value: 4.3, date: "2026-07-20" });
      }),
    });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.fred).toHaveLength(5);
    expect(doc.fred?.some((f) => f.label === "Unemployment Rate")).toBe(false);
  });

  it("leaves fred undefined when every FRED call fails, without failing the run", async () => {
    const deps = baseDeps({
      fredLatest: vi.fn().mockRejectedValue(new Error("FRED 500")),
      fredYoY: vi.fn().mockRejectedValue(new Error("FRED 500")),
      fredWithPrior: vi.fn().mockRejectedValue(new Error("FRED 500")),
    });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.fred).toBeUndefined();
  });

  it("leaves marketHealth undefined when it fails, without failing the run", async () => {
    const deps = baseDeps({ marketHealth: vi.fn().mockRejectedValue(new Error("AI 500")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.marketHealth).toBeUndefined();
  });

  it("passes marketHealth the live index/macro quotes alongside the fred data", async () => {
    const marketHealthMock = vi.fn().mockResolvedValue("health text");
    const deps = baseDeps({ marketHealth: marketHealthMock });
    await runPipeline(input, deps);

    const [indexAndMacro, fredArg] = marketHealthMock.mock.calls[0];
    expect(indexAndMacro.length).toBeGreaterThanOrEqual(8); // 4 indices + 4 macro proxies
    expect(indexAndMacro[0]).toEqual({ label: expect.any(String), price: 200, changePct: 1 });
    expect(fredArg).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Unemployment Rate" })]));
  });

  it("filters out reels not posted on input.targetDate", async () => {
    const onDate = new Date(input.targetDate);
    const offDate = new Date(input.targetDate);
    offDate.setDate(offDate.getDate() - 3);
    const deps = baseDeps({
      runActor: vi.fn().mockResolvedValue([
        { transcript: "AAPL is a solid buy", url: "https://ig.com/p/1", pageName: "trader1", timestamp: onDate.getTime() },
        { transcript: "MSFT is a solid buy", url: "https://ig.com/p/2", pageName: "trader1", timestamp: offDate.getTime() },
      ]),
      extractTickers: vi.fn().mockImplementation(async (text: string) => {
        if (text.includes("AAPL")) {
          return [{ ticker: "AAPL", company: "Apple", view: "buy", buyLevel: "", sellLevel: "", recap: "", quote: "" }];
        }
        return [{ ticker: "MSFT", company: "Microsoft", view: "buy", buyLevel: "", sellLevel: "", recap: "", quote: "" }];
      }),
    });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers.map((r) => r.sym)).toEqual(["AAPL"]);
  });

  it("treats a non-array runActor response as an empty reel list instead of throwing", async () => {
    const deps = baseDeps({
      runActor: vi.fn().mockResolvedValue(null) as unknown as PipelineDeps["runActor"],
    });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers).toEqual([]);
  });

  it("does not call videoWrap when there are no ranked tickers", async () => {
    const videoWrapMock = vi.fn().mockResolvedValue("wrap text");
    const deps = baseDeps({
      runActor: vi.fn().mockResolvedValue([]),
      videoWrap: videoWrapMock,
    });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(videoWrapMock).not.toHaveBeenCalled();
    expect(doc.videoWrap).toBeUndefined();
  });
});

describe("runPipeline — quant score", () => {
  it("attaches a quant score with an explanation to each ranked ticker", async () => {
    const doc = await runPipeline(input, baseDeps());
    expect(doc.rankedTickers[0].quant).toBeDefined();
    expect(doc.rankedTickers[0].quant?.factors.length).toBeGreaterThan(0);
    expect(doc.rankedTickers[0].quant?.explanation).toBe("Solid low-volatility profile driven by beta near 1.0.");
  });

  it("passes quantExplanation the computed factors and score", async () => {
    const quantExplanationMock = vi.fn().mockResolvedValue("explanation");
    const deps = baseDeps({ quantExplanation: quantExplanationMock });
    await runPipeline(input, deps);

    expect(quantExplanationMock).toHaveBeenCalledTimes(1);
    const [sym, factors, score] = quantExplanationMock.mock.calls[0];
    expect(sym).toBe("AAPL");
    expect(Array.isArray(factors)).toBe(true);
    expect(typeof score).toBe("number");
  });

  it("leaves quant unset when fundamentals are unavailable", async () => {
    const deps = baseDeps({ getFundamentals: vi.fn().mockRejectedValue(new Error("Finnhub 429")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers[0].quant).toBeUndefined();
  });

  it("keeps the score and factors but omits the explanation when the explanation call fails", async () => {
    const deps = baseDeps({ quantExplanation: vi.fn().mockRejectedValue(new Error("AI 500")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers[0].quant).toBeDefined();
    expect(doc.rankedTickers[0].quant?.explanation).toBeUndefined();
  });
});

describe("runPipeline — FRED indicator status", () => {
  it("flags an inverted 10Y-2Y spread as a warning", async () => {
    const deps = baseDeps({
      fredLatest: vi.fn().mockImplementation((seriesId: string) => {
        if (seriesId === "T10Y2Y") return Promise.resolve({ value: -0.15, date: "2026-07-20" });
        return Promise.resolve({ value: 4.3, date: "2026-07-20" });
      }),
    });
    const doc = await runPipeline(input, deps);
    const spread = doc.fred?.find((f) => f.label === "10Y-2Y Yield Spread");
    expect(spread).toEqual({
      label: "10Y-2Y Yield Spread",
      value: -0.15,
      note: "negative = inverted curve, historically a recession warning",
      unit: "percent-signed",
      status: "warning",
      statusLabel: "⚠ inverted",
    });
  });

  it("treats a positive 10Y-2Y spread as normal", async () => {
    const doc = await runPipeline(input, baseDeps());
    const spread = doc.fred?.find((f) => f.label === "10Y-2Y Yield Spread");
    expect(spread?.status).toBe("normal");
    expect(spread?.statusLabel).toBe("normal range");
  });

  it("flags elevated unemployment (>5.0%) as a warning", async () => {
    const deps = baseDeps({
      fredLatest: vi.fn().mockImplementation((seriesId: string) => {
        if (seriesId === "UNRATE") return Promise.resolve({ value: 5.5, date: "2026-07-20" });
        return Promise.resolve({ value: 4.3, date: "2026-07-20" });
      }),
    });
    const doc = await runPipeline(input, deps);
    const unrate = doc.fred?.find((f) => f.label === "Unemployment Rate");
    expect(unrate).toEqual({
      label: "Unemployment Rate",
      value: 5.5,
      note: "%",
      unit: "percent",
      status: "warning",
      statusLabel: "⚠ elevated",
    });
  });

  it("never flags Fed Funds Rate as a warning, regardless of value", async () => {
    const deps = baseDeps({
      fredLatest: vi.fn().mockImplementation((seriesId: string) => {
        if (seriesId === "FEDFUNDS") return Promise.resolve({ value: 20, date: "2026-07-20" });
        return Promise.resolve({ value: 4.3, date: "2026-07-20" });
      }),
    });
    const doc = await runPipeline(input, deps);
    const fedfunds = doc.fred?.find((f) => f.label === "Fed Funds Rate");
    expect(fedfunds).toEqual({
      label: "Fed Funds Rate",
      value: 20,
      note: "% — the Fed's benchmark interest rate",
      unit: "percent",
      status: "normal",
      statusLabel: "normal range",
    });
  });

  it("flags elevated CPI (>3.0%) as a warning and renames the label to include (YoY)", async () => {
    const deps = baseDeps({ fredYoY: vi.fn().mockResolvedValue({ value: 3.5, date: "2026-07-20" }) });
    const doc = await runPipeline(input, deps);
    const cpi = doc.fred?.find((f) => f.label === "CPI Inflation (YoY)");
    expect(cpi).toEqual({
      label: "CPI Inflation (YoY)",
      value: 3.5,
      note: "% year-over-year — above ~3% is elevated vs. the Fed's ~2% target",
      unit: "percent-signed",
      status: "warning",
      statusLabel: "⚠ elevated",
    });
  });

  it("flags elevated jobless claims (>275000) as a warning", async () => {
    const deps = baseDeps({ fredWithPrior: vi.fn().mockResolvedValue({ value: 300000, prior: 280000, date: "2026-07-20" }) });
    const doc = await runPipeline(input, deps);
    const claims = doc.fred?.find((f) => f.label === "Initial Jobless Claims");
    expect(claims).toEqual({
      label: "Initial Jobless Claims",
      value: 300000,
      note: "weekly new unemployment claims, rising vs. prior week",
      unit: "count-k",
      status: "warning",
      statusLabel: "⚠ elevated",
    });
  });

  it("flags contracting industrial production (<0%) as a warning and renames the label to include (YoY)", async () => {
    const deps = baseDeps({ fredYoY: vi.fn().mockResolvedValue({ value: -1.2, date: "2026-07-20" }) });
    const doc = await runPipeline(input, deps);
    const indpro = doc.fred?.find((f) => f.label === "Industrial Production (YoY)");
    expect(indpro).toEqual({
      label: "Industrial Production (YoY)",
      value: -1.2,
      note: "% year-over-year — manufacturing/production health proxy",
      unit: "percent-signed",
      status: "warning",
      statusLabel: "⚠ contracting",
    });
  });
});

describe("runPipeline — deep dive", () => {
  it("attaches a deep dive report to a ranked ticker that has fundamentals", async () => {
    const doc = await runPipeline(input, baseDeps());
    expect(doc.rankedTickers[0].deepDive).toBeDefined();
    expect(doc.rankedTickers[0].deepDive?.quarterlyReview.verdict).toBe("Buy");
  });

  it("does not attempt a deep dive when fundamentals are unavailable", async () => {
    const getPeersMock = vi.fn().mockResolvedValue([]);
    const tickerDeepDiveMock = vi.fn().mockResolvedValue({
      businessTeardown: "x",
      financialHealth: "x",
      valuation: "x",
      bearCase: "x",
      catalysts: "x",
      positionSizing: "x",
      quarterlyReview: { verdict: "Buy", reasoning: "x" },
    });
    const deps = baseDeps({
      getFundamentals: vi.fn().mockRejectedValue(new Error("Finnhub 429")),
      getPeers: getPeersMock,
      tickerDeepDive: tickerDeepDiveMock,
    });
    const doc = await runPipeline(input, deps);
    expect(doc.rankedTickers[0].deepDive).toBeUndefined();
    expect(getPeersMock).not.toHaveBeenCalled();
    expect(tickerDeepDiveMock).not.toHaveBeenCalled();
  });

  it("passes peer fundamentals to tickerDeepDive, dropping peers whose fundamentals call fails", async () => {
    const tickerDeepDiveMock = vi.fn().mockResolvedValue({
      businessTeardown: "x",
      financialHealth: "x",
      valuation: "x",
      bearCase: "x",
      catalysts: "x",
      positionSizing: "x",
      quarterlyReview: { verdict: "Buy", reasoning: "x" },
    });
    const deps = baseDeps({
      getPeers: vi.fn().mockResolvedValue(["MSFT", "GOOGL"]),
      getFundamentals: vi.fn().mockImplementation((sym: string) => {
        if (sym === "AAPL") return Promise.resolve({ pe: 20, marketCap: 3000, week52High: 220, week52Low: 150, beta: 1.1, pb: 3, roe: 20, netMargin: 15, debtToEquity: 0.8, return26Week: 10, return52Week: 20 });
        if (sym === "MSFT") return Promise.resolve({ pe: 35, marketCap: 3000, week52High: 220, week52Low: 150, beta: 1.1, pb: 3, roe: 20, netMargin: 15, debtToEquity: 0.8, return26Week: 10, return52Week: 20 });
        return Promise.reject(new Error("Finnhub 429"));
      }),
      tickerDeepDive: tickerDeepDiveMock,
    });
    await runPipeline(input, deps);

    const [, , ctx] = tickerDeepDiveMock.mock.calls[0];
    expect(ctx.peers).toEqual([{ sym: "MSFT", fundamentals: { pe: 35, marketCap: 3000, week52High: 220, week52Low: 150, beta: 1.1, pb: 3, roe: 20, netMargin: 15, debtToEquity: 0.8, return26Week: 10, return52Week: 20 } }]);
  });

  it("passes an empty peers array to tickerDeepDive when getPeers fails", async () => {
    const tickerDeepDiveMock = vi.fn().mockResolvedValue({
      businessTeardown: "x",
      financialHealth: "x",
      valuation: "x",
      bearCase: "x",
      catalysts: "x",
      positionSizing: "x",
      quarterlyReview: { verdict: "Buy", reasoning: "x" },
    });
    const deps = baseDeps({ getPeers: vi.fn().mockRejectedValue(new Error("Finnhub 500")), tickerDeepDive: tickerDeepDiveMock });
    await runPipeline(input, deps);

    const [, , ctx] = tickerDeepDiveMock.mock.calls[0];
    expect(ctx.peers).toEqual([]);
  });

  it("leaves deepDive unset when tickerDeepDive fails, without failing the run or touching quant/screen", async () => {
    const deps = baseDeps({ tickerDeepDive: vi.fn().mockRejectedValue(new Error("AI 500")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers[0].deepDive).toBeUndefined();
    expect(doc.rankedTickers[0].quant).toBeDefined();
    expect(doc.screen.AAPL).toBeDefined();
  });

  it("leaves deepDive unset when tickerDeepDive returns undefined (unparseable response)", async () => {
    const deps = baseDeps({ tickerDeepDive: vi.fn().mockResolvedValue(undefined) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers[0].deepDive).toBeUndefined();
  });

  it("does not sleep after the last ranked ticker with fundamentals (nothing left to pace against)", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({ sleep: sleepMock });
    await runPipeline(input, deps);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("does not sleep when a ticker has no fundamentals (deep dive skipped entirely)", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({ getFundamentals: vi.fn().mockRejectedValue(new Error("Finnhub 429")), sleep: sleepMock });
    await runPipeline(input, deps);
    expect(sleepMock).not.toHaveBeenCalled();
  });
});
