import { describe, it, expect } from "vitest";
import { screenStock } from "../src/lib/screen.js";

describe("screenStock", () => {
  it("returns null when there's no fundamentals or analyst data", () => {
    expect(screenStock(null, null)).toBeNull();
  });

  it("returns Pass when all checks pass", () => {
    const result = screenStock(
      { pe: 20, marketCap: 1000, week52High: 200, week52Low: 100, beta: 1.2, pb: null, roe: null, netMargin: null, debtToEquity: null, return26Week: null, return52Week: null },
      { buy: 10, hold: 2, sell: 1, period: "2026-07" }
    );
    expect(result).toEqual({
      verdict: "Pass",
      passed: 3,
      total: 3,
      checks: [
        { label: "Valuation (P/E 0–25)", pass: true, detail: "20.0" },
        { label: "Analyst consensus", pass: true, detail: "10 buy / 2 hold / 1 sell" },
        { label: "Stability (beta < 2.5)", pass: true, detail: "1.20" },
      ],
    });
  });

  it("returns Caution when most checks fail", () => {
    const result = screenStock({ pe: 90, marketCap: 1000, week52High: 200, week52Low: 100, beta: 3.5, pb: null, roe: null, netMargin: null, debtToEquity: null, return26Week: null, return52Week: null }, { buy: 1, hold: 5, sell: 5, period: "2026-07" });
    expect(result?.verdict).toBe("Caution");
    expect(result?.passed).toBe(0);
  });

  it("skips the analyst check when there's no analyst data", () => {
    const result = screenStock({ pe: 20, marketCap: 1000, week52High: 200, week52Low: 100, beta: 1.2, pb: null, roe: null, netMargin: null, debtToEquity: null, return26Week: null, return52Week: null }, null);
    expect(result?.total).toBe(2);
  });

  it("returns Watch when exactly 1 of 3 checks passes", () => {
    const result = screenStock(
      { pe: 100, marketCap: 1000, week52High: 200, week52Low: 100, beta: 3.5, pb: null, roe: null, netMargin: null, debtToEquity: null, return26Week: null, return52Week: null },
      { buy: 10, hold: 1, sell: 1, period: "2026-07" }
    );
    expect(result?.verdict).toBe("Watch");
    expect(result?.passed).toBe(1);
    expect(result?.total).toBe(3);
  });
});
