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
});

describe("marketRecap", () => {
  it("returns the summary text from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: "Markets were mixed." }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const text = await marketRecap([{ headline: "Fed holds rates" }], "Jul 23, 2026", cfg);
    expect(text).toBe("Markets were mixed.");
  });
});
