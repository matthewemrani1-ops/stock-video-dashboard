import { describe, it, expect, vi, afterEach } from "vitest";
import { extractTickers, videoWrap, marketRecap, marketHealth, quantExplanation } from "../src/lib/claude.js";

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
