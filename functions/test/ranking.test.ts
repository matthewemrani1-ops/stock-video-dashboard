import { describe, it, expect } from "vitest";
import { rankMentions } from "../src/lib/ranking.js";

describe("rankMentions", () => {
  it("aggregates extractions by ticker and sorts by mention count descending", () => {
    const result = rankMentions([
      { ticker: "aapl", company: "Apple", view: "buy", buyLevel: "$200", sellLevel: "", recap: "bullish", quote: "buy now", who: "trader1" },
      { ticker: "aapl", company: "Apple", view: "hold", buyLevel: "", sellLevel: "", recap: "wait", quote: "", who: "trader2" },
      { ticker: "nvda", company: "Nvidia", view: "buy", buyLevel: "", sellLevel: "", recap: "strong", quote: "", who: "trader1" },
    ]);

    expect(result).toEqual([
      {
        sym: "AAPL",
        company: "Apple",
        count: 2,
        takes: [
          { who: "trader1", view: "buy", buy: "$200", sell: "", recap: "bullish", quote: "buy now" },
          { who: "trader2", view: "hold", buy: "", sell: "", recap: "wait", quote: "" },
        ],
      },
      {
        sym: "NVDA",
        company: "Nvidia",
        count: 1,
        takes: [{ who: "trader1", view: "buy", buy: "", sell: "", recap: "strong", quote: "" }],
      },
    ]);
  });

  it("uppercases and strips invalid characters from tickers, skipping empties", () => {
    const result = rankMentions([
      { ticker: "  ", company: "", view: "mention", buyLevel: "", sellLevel: "", recap: "", quote: "", who: "x" },
      { ticker: "brk.b", company: "Berkshire", view: "mention", buyLevel: "", sellLevel: "", recap: "", quote: "", who: "x" },
    ]);
    expect(result).toEqual([
      { sym: "BRK.B", company: "Berkshire", count: 1, takes: [{ who: "x", view: "mention", buy: "", sell: "", recap: "", quote: "" }] },
    ]);
  });
});
