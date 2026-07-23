import { describe, it, expect, vi, afterEach } from "vitest";
import { extractTickers, videoWrap, marketRecap } from "../src/lib/claude.js";

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
