import { describe, it, expect, vi, afterEach } from "vitest";
import { extractTickers, videoWrap, marketRecap, marketHealth, quantExplanation, tickerDeepDive } from "../src/lib/claude.js";

const cfg = { apiKey: "key123", model: "claude-haiku-4-5-20251001" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractTickers", () => {
  it("parses a JSON array out of the response text, stripping code fences", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: '```json\n[{"ticker":"AAPL","company":"Apple","view":"buy","buyLevel":"$200","sellLevel":"","recap":"bullish","quote":"buy now"}]\n```' }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractTickers("some transcript", cfg);
    expect(result).toEqual([{ ticker: "AAPL", company: "Apple", view: "buy", buyLevel: "$200", sellLevel: "", recap: "bullish", quote: "buy now" }]);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["x-api-key"]).toBe("key123");
  });

  it("sends the correct system prompt, max_tokens, and model in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "[]" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await extractTickers("some transcript", cfg);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);

    expect(body.system).toBe(`You extract stock mentions from a transcript of a stock video. Return ONLY a JSON array, no prose, no code fences. Each element: {"ticker","company","view","buyLevel","sellLevel","recap","quote"}.
- ticker: the stock symbol (uppercase). If only a company name is given, infer the ticker. Skip if unsure.
- view: one of "buy","sell","hold","mention" — what the SPEAKER expressed.
- buyLevel/sellLevel: any price the speaker named (e.g. "$150"), else "".
- recap: one sentence, <=25 words, on what the speaker said about this stock.
- quote: a short verbatim phrase (<15 words) from the transcript, else "".
If no stocks are discussed, return [].`);
    expect(body.max_tokens).toBe(1024);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });

  it("returns an empty array when the response isn't valid JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "not json" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await extractTickers("x", cfg)).toEqual([]);
  });

  it("throws when the API call fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(extractTickers("x", cfg)).rejects.toThrow("AI 500");
  });
});

describe("videoWrap", () => {
  it("returns the summary text from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "Today was volatile." }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const text = await videoWrap([], "Jul 23, 2026", cfg);
    expect(text).toBe("Today was volatile.");
  });

  it("sends the correct system prompt, max_tokens, and model in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "Today was mixed." }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await videoWrap([], "Jul 23, 2026", cfg);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);

    expect(body.system).toBe(`You are writing a short daily wrap-up for a personal stock-video research dashboard. Based on the stock mentions and speaker takes below, write:
1. A 2-3 sentence summary of what stood out today across the videos (themes, hot tickers, notable disagreements).
2. A 1-2 sentence read on sentiment heading into the next trading day, based ONLY on what the video speakers said (not your own market opinion).
Keep it factual and attribute views to speakers where relevant. Do not give buy/sell advice of your own. Plain text, no headers, no markdown, 2 short paragraphs max.`);
    expect(body.max_tokens).toBe(400);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("marketRecap", () => {
  it("returns the summary text from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "Markets were mixed." }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const text = await marketRecap([{ headline: "Fed holds rates" }], "Jul 23, 2026", cfg);
    expect(text).toBe("Markets were mixed.");
  });

  it("sends the correct system prompt, max_tokens, and model in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "Markets were mixed." }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await marketRecap([{ headline: "Fed holds rates" }], "Jul 23, 2026", cfg);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);

    expect(body.system).toBe(`You are writing a short daily market recap for a personal dashboard, based on general financial news headlines (not the person's own video sources). Write:
1. A 2-3 sentence summary of the day's key market news and themes.
2. A 1-2 sentence read on sentiment heading into the next trading day, based on this news.
Plain text, no headers, no markdown, 2 short paragraphs max. Do not give buy/sell advice.`);
    expect(body.max_tokens).toBe(400);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("marketHealth", () => {
  const indexAndMacro = [
    { label: "S&P 500", price: 739.72, changePct: 0.11 },
    { label: "Volatility (VIX proxy)", price: 21.29, changePct: -0.7 },
  ];
  const fred = [{ label: "Unemployment Rate", value: 4.2, note: "%", unit: "percent" as const, status: "normal" as const, statusLabel: "normal range" }];

  it("returns the summary text from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "Markets look calm." }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const text = await marketHealth(indexAndMacro, fred, cfg);
    expect(text).toBe("Markets look calm.");
  });

  it("builds the digest from index/macro quotes and FRED indicators, with no date prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "ok" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await marketHealth(indexAndMacro, fred, cfg);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe("S&P 500: $739.72 (+0.11% today)\nVolatility (VIX proxy): $21.29 (-0.70% today)\nUnemployment Rate: 4.20 — normal range (%)");
  });

  it("omits the FRED lines entirely when there's no FRED data", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "ok" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await marketHealth(indexAndMacro, undefined, cfg);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe("S&P 500: $739.72 (+0.11% today)\nVolatility (VIX proxy): $21.29 (-0.70% today)");
  });

  it("sends the correct system prompt, max_tokens, and model in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "ok" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await marketHealth(indexAndMacro, fred, cfg);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);

    expect(body.system).toBe(`You are explaining market health indicators on a personal dashboard for someone who is not a professional trader. Given today's readings for major indices, macro proxy ETFs (VIXY as a volatility/fear proxy, TLT as long Treasuries — rises when investors seek safety, HYG as high-yield credit — falls when credit stress rises, UUP as the dollar index), and where available: the 10Y-2Y Treasury yield spread (negative/inverted has historically preceded recessions), the unemployment rate, the Fed funds rate, CPI inflation (year-over-year, above ~3% is elevated vs. the Fed's ~2% target), initial jobless claims (a fast-moving weekly labor market signal — rising claims can signal labor weakness), and industrial production (year-over-year, negative = manufacturing contraction), write:
1. A 2-3 sentence plain-English read on what today's levels suggest about market mood and valuation (risk-on bull conditions vs. risk-off/recession-warning conditions).
2. A short "what to watch for" note: 2-3 concrete signs someone should look for in these same indicators if conditions were shifting toward a recession, versus signs of a healthy bull market.
Plain text, no headers, no markdown, 2 short paragraphs max. Be educational, not alarmist. Do not give investment advice.`);
    expect(body.max_tokens).toBe(400);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("quantExplanation", () => {
  const factors = [
    { category: "Value" as const, score: 62, detail: "P/E 20.0, P/B 4.0" },
    { category: "Low-Volatility" as const, score: 75, detail: "Beta 1.10" },
  ];

  it("returns the explanation text from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "AAPL scores well on low volatility." }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const text = await quantExplanation("AAPL", factors, 68, cfg);
    expect(text).toBe("AAPL scores well on low volatility.");
  });

  it("builds the digest from the ticker, composite score, and factor breakdown", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "ok" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await quantExplanation("AAPL", factors, 68, cfg);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe("AAPL — composite score 68/100\nValue: 62/100 (P/E 20.0, P/B 4.0)\nLow-Volatility: 75/100 (Beta 1.10)");
  });

  it("sends the correct system prompt, max_tokens, and model in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "ok" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await quantExplanation("AAPL", factors, 68, cfg);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);

    expect(body.system).toBe(
      `You are writing a short factual explanation of a quantitative stock score for a personal dashboard. You will be given a ticker's composite quant score (0-100, made up of up to four equally-weighted factor categories: Value, Quality, Momentum, Low-Volatility) and the underlying metric values behind each factor. Write a 2-3 sentence explanation of what's driving the score, grounded STRICTLY in these numbers — do not add your own independent opinion, prediction, or buy/sell recommendation. Plain text, no headers, no markdown.`
    );
    expect(body.max_tokens).toBe(200);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("tickerDeepDive", () => {
  const fundamentals = { pe: 30, marketCap: 3000, week52High: 220, week52Low: 150, beta: 1.1, pb: 45, roe: 150, netMargin: 27, debtToEquity: 1.4, return26Week: 10, return52Week: 20 };
  const quant = { score: 68, verdict: "Mixed" as const, factors: [{ category: "Value" as const, score: 40, detail: "P/E 30.0, P/B 45.0" }] };
  const historical = {
    netMargin: [{ period: "2025-09-27", value: 0.2692 }],
    grossMargin: [{ period: "2025-09-27", value: 0.4621 }],
    roic: [{ period: "2025-09-27", value: 0.6451 }],
    netDebtToEquity: [{ period: "2025-09-27", value: 0.8674 }],
    pe: [{ period: "2025-09-27", value: 33.5574 }],
    pb: [{ period: "2025-09-27", value: 50.978 }],
    pfcf: [{ period: "2025-09-27", value: 38.0568 }],
  };
  const peers = [{ sym: "MSFT", fundamentals: { ...fundamentals, pe: 35 } }];
  const validResponse = {
    businessTeardown: "Sells premium hardware, software, and services to consumers.",
    financialHealth: "Margins are stable and ROIC is strong; getting stronger.",
    valuation: "Trading above its own 5yr average and above MSFT's multiple.",
    bearCase: "1) Growth slowing. 2) Regulatory risk. 3) Multiple compression.",
    catalysts: "Next earnings call in 6 weeks.",
    positionSizing: "Cap around 3% of portfolio given the bear case above.",
    quarterlyReview: { verdict: "Buy", reasoning: "Yes, at this price." },
  };

  it("returns the parsed deep dive from the response, stripping code fences", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "```json\n" + JSON.stringify(validResponse) + "\n```" }] }) })
    );
    const result = await tickerDeepDive("AAPL", "Apple", { price: 200, fundamentals, profile: null, analyst: null, quant, historical, peers }, cfg);
    expect(result).toEqual(validResponse);
  });

  it("returns undefined when the response isn't valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "not json" }] }) }));
    const result = await tickerDeepDive("AAPL", "Apple", { price: 200, fundamentals, profile: null, analyst: null, quant, historical, peers }, cfg);
    expect(result).toBeUndefined();
  });

  it("returns undefined when quarterlyReview.verdict isn't Buy or Pass", async () => {
    const bad = { ...validResponse, quarterlyReview: { verdict: "Maybe", reasoning: "Unsure." } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(bad) }] }) }));
    const result = await tickerDeepDive("AAPL", "Apple", { price: 200, fundamentals, profile: null, analyst: null, quant, historical, peers }, cfg);
    expect(result).toBeUndefined();
  });

  it("returns undefined when a required section is missing", async () => {
    const { businessTeardown, ...missingOne } = validResponse;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(missingOne) }] }) }));
    const result = await tickerDeepDive("AAPL", "Apple", { price: 200, fundamentals, profile: null, analyst: null, quant, historical, peers }, cfg);
    expect(result).toBeUndefined();
  });

  it("builds the digest with price, fundamentals, quant, historical trend, and peers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(validResponse) }] }) }));
    await tickerDeepDive("AAPL", "Apple", { price: 200, fundamentals, profile: null, analyst: null, quant, historical, peers }, cfg);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe(
      `AAPL (Apple) — current price $200.00\n\nCurrent fundamentals: P/E 30, P/B 45, ROE 150%, net margin 27%, debt/equity 1.4, beta 1.1, 52wk range $150-$220\n\nQuant score: 68/100 (Mixed) — Value 40/100\n\n5-year history (most recent first):\nNet margin (5yr): 2025=0.27\nGross margin (5yr): 2025=0.46\nROIC (5yr): 2025=0.65\nNet Debt/Equity (5yr): 2025=0.87\nP/E (5yr): 2025=33.56\nP/B (5yr): 2025=50.98\nP/FCF (5yr): 2025=38.06\n\nPeers:\nMSFT: P/E 35, P/B 45, net margin 27%`
    );
  });

  it("omits analyst, historical, peers, and industry lines entirely when there's no data for them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(validResponse) }] }) }));
    await tickerDeepDive("AAPL", "Apple", { price: 200, fundamentals, profile: null, analyst: null, quant: null, historical: null, peers: [] }, cfg);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe("AAPL (Apple) — current price $200.00\n\nCurrent fundamentals: P/E 30, P/B 45, ROE 150%, net margin 27%, debt/equity 1.4, beta 1.1, 52wk range $150-$220");
  });

  it("omits the industry line when profile.industry is missing/empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(validResponse) }] }) }));
    await tickerDeepDive(
      "AAPL",
      "Apple",
      { price: 200, fundamentals, profile: { industry: "", name: "Apple Inc", weburl: "https://apple.com" }, analyst: null, quant: null, historical: null, peers: [] },
      cfg
    );

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe("AAPL (Apple) — current price $200.00\n\nCurrent fundamentals: P/E 30, P/B 45, ROE 150%, net margin 27%, debt/equity 1.4, beta 1.1, 52wk range $150-$220");
  });

  it("includes an Industry line right after fundamentals when profile.industry is present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(validResponse) }] }) }));
    await tickerDeepDive(
      "AAPL",
      "Apple",
      { price: 200, fundamentals, profile: { industry: "Consumer Electronics", name: "Apple Inc", weburl: "https://apple.com" }, analyst: null, quant, historical, peers },
      cfg
    );

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe(
      `AAPL (Apple) — current price $200.00\n\nCurrent fundamentals: P/E 30, P/B 45, ROE 150%, net margin 27%, debt/equity 1.4, beta 1.1, 52wk range $150-$220\n\nIndustry: Consumer Electronics\n\nQuant score: 68/100 (Mixed) — Value 40/100\n\n5-year history (most recent first):\nNet margin (5yr): 2025=0.27\nGross margin (5yr): 2025=0.46\nROIC (5yr): 2025=0.65\nNet Debt/Equity (5yr): 2025=0.87\nP/E (5yr): 2025=33.56\nP/B (5yr): 2025=50.98\nP/FCF (5yr): 2025=38.06\n\nPeers:\nMSFT: P/E 35, P/B 45, net margin 27%`
    );
  });

  it("sends the correct system prompt, max_tokens, and model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(validResponse) }] }) }));
    await tickerDeepDive("AAPL", "Apple", { price: 200, fundamentals, profile: null, analyst: null, quant, historical, peers }, cfg);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system).toBe(`You are writing a 7-section equity research teardown for a personal investing dashboard, grounded in the real data given below plus your own general knowledge of the company and industry. Return ONLY a JSON object with exactly these keys, no prose, no code fences:
{
  "businessTeardown": "2-4 sentences: how the company actually makes money, who its customers are, and what its competitive moat is (or the lack of one). Be specific, not generic.",
  "financialHealth": "2-4 sentences on the 5-year margin and ROIC trend, whether free cash flow is running above or below reported net income (compare the P/E and P/FCF multiples given — if P/FCF is meaningfully higher than P/E, free cash flow is running below net income, and vice versa), and the debt/equity trend. State whether the business is getting stronger or weaker overall.",
  "valuation": "2-4 sentences comparing the stock's CURRENT valuation multiples to its OWN 3-5 year historical average, and to the named peer companies given below. Name the peer tickers and their multiples directly.",
  "bearCase": "Exactly three distinct, credible reasons this stock could drop roughly 40% from here. No hedging, no bull-case caveats — argue only this side.",
  "catalysts": "1-3 sentences naming a SPECIFIC event or timeframe in the next 12 months that could force the market to re-rate this stock. If you genuinely can't identify one, say so plainly instead of inventing one.",
  "positionSizing": "1-2 sentences giving a portfolio-PERCENTAGE sizing guideline (never a dollar amount) such that the bear case above would cost less than roughly 2% of a portfolio if it played out.",
  "quarterlyReview": {"verdict": "Buy or Pass", "reasoning": "1-2 sentences: if you didn't already own this stock, would you buy it today at this price? Answer plainly."}
}
Ground every numeric claim in the real data provided — do not invent specific numbers not given to you. This is not financial advice; the reader understands that.`);
    expect(body.max_tokens).toBe(1400);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });
});
