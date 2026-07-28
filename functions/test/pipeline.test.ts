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

  it("sets status error and does not throw when Apify fails", async () => {
    const deps = baseDeps({ runActor: vi.fn().mockRejectedValue(new Error("Apify 401 — bad token")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("error");
    expect(doc.errorMessage).toContain("bad token");
    expect(doc.rankedTickers).toEqual([]);
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

  it("leaves fred undefined when FRED calls fail, without failing the run", async () => {
    const deps = baseDeps({ fredLatest: vi.fn().mockRejectedValue(new Error("FRED 500")) });
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
