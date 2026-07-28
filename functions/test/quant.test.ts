import { describe, it, expect } from "vitest";
import { computeValueFactor, computeQualityFactor, computeMomentumFactor, computeLowVolFactor, scoreQuant } from "../src/lib/quant.js";
import type { Fundamentals } from "../src/lib/types.js";

const empty: Fundamentals = {
  pe: null,
  marketCap: null,
  week52High: null,
  week52Low: null,
  beta: null,
  pb: null,
  roe: null,
  netMargin: null,
  debtToEquity: null,
  return26Week: null,
  return52Week: null,
};

describe("computeValueFactor", () => {
  it("gives full points at the good P/E threshold", () => {
    const f = computeValueFactor({ ...empty, pe: 10 });
    expect(f).toEqual({ category: "Value", score: 100, detail: "P/E 10.0" });
  });

  it("gives zero points at the bad P/E threshold", () => {
    const f = computeValueFactor({ ...empty, pe: 40 });
    expect(f?.score).toBe(0);
  });

  it("clamps beyond the thresholds instead of going negative or over 100", () => {
    expect(computeValueFactor({ ...empty, pe: 5 })?.score).toBe(100);
    expect(computeValueFactor({ ...empty, pe: 60 })?.score).toBe(0);
  });

  it("averages P/E and P/B when both are available", () => {
    // pe=10 -> 100, pb=8 -> 0, average = 50
    const f = computeValueFactor({ ...empty, pe: 10, pb: 8 });
    expect(f?.score).toBe(50);
    expect(f?.detail).toBe("P/E 10.0, P/B 8.0");
  });

  it("ignores a non-positive P/E (unprofitable company)", () => {
    const f = computeValueFactor({ ...empty, pe: -5, pb: 1 });
    expect(f?.score).toBe(100); // only P/B counted
    expect(f?.detail).toBe("P/B 1.0");
  });

  it("returns null when neither P/E nor P/B is available", () => {
    expect(computeValueFactor(empty)).toBeNull();
  });
});

describe("computeQualityFactor", () => {
  it("gives full points at the good thresholds for all three metrics", () => {
    const f = computeQualityFactor({ ...empty, roe: 25, netMargin: 20, debtToEquity: 0.3 });
    expect(f?.score).toBe(100);
  });

  it("gives zero points at the bad thresholds", () => {
    const f = computeQualityFactor({ ...empty, roe: 0, netMargin: 0, debtToEquity: 2.5 });
    expect(f?.score).toBe(0);
  });

  it("averages whichever metrics are available", () => {
    // only roe=25 (->100) is available
    const f = computeQualityFactor({ ...empty, roe: 25 });
    expect(f?.score).toBe(100);
    expect(f?.detail).toBe("ROE 25.0%");
  });

  it("returns null when no quality metrics are available", () => {
    expect(computeQualityFactor(empty)).toBeNull();
  });
});

describe("computeMomentumFactor", () => {
  it("gives full points at the good return threshold", () => {
    const f = computeMomentumFactor({ ...empty, return26Week: 30, return52Week: 30 });
    expect(f?.score).toBe(100);
  });

  it("gives zero points at the bad return threshold", () => {
    const f = computeMomentumFactor({ ...empty, return26Week: -20, return52Week: -20 });
    expect(f?.score).toBe(0);
  });

  it("averages the two windows when both are available", () => {
    // 30 -> 100, -20 -> 0, average = 50
    const f = computeMomentumFactor({ ...empty, return26Week: 30, return52Week: -20 });
    expect(f?.score).toBe(50);
  });

  it("returns null when neither return window is available", () => {
    expect(computeMomentumFactor(empty)).toBeNull();
  });
});

describe("computeLowVolFactor", () => {
  it("gives full points at the good (low) beta threshold", () => {
    expect(computeLowVolFactor({ ...empty, beta: 0.8 })).toEqual({ category: "Low-Volatility", score: 100, detail: "Beta 0.80" });
  });

  it("gives zero points at the bad (high) beta threshold", () => {
    expect(computeLowVolFactor({ ...empty, beta: 2.0 })?.score).toBe(0);
  });

  it("returns null when beta is unavailable", () => {
    expect(computeLowVolFactor(empty)).toBeNull();
  });
});

describe("scoreQuant", () => {
  it("returns null when fundamentals are null", () => {
    expect(scoreQuant(null)).toBeNull();
  });

  it("returns null when no factor has any data", () => {
    expect(scoreQuant(empty)).toBeNull();
  });

  it("composes all four factors into a Strong verdict when every metric is strong", () => {
    const result = scoreQuant({
      ...empty,
      pe: 10,
      pb: 1,
      roe: 25,
      netMargin: 20,
      debtToEquity: 0.3,
      return26Week: 30,
      return52Week: 30,
      beta: 0.8,
    });
    expect(result?.score).toBe(100);
    expect(result?.verdict).toBe("Strong");
    expect(result?.factors).toHaveLength(4);
  });

  it("returns a Weak verdict when every metric is at the bad threshold", () => {
    const result = scoreQuant({
      ...empty,
      pe: 40,
      pb: 8,
      roe: 0,
      netMargin: 0,
      debtToEquity: 2.5,
      return26Week: -20,
      return52Week: -20,
      beta: 2.0,
    });
    expect(result?.score).toBe(0);
    expect(result?.verdict).toBe("Weak");
  });

  it("returns a Mixed verdict in the middle band", () => {
    // beta=1.4 -> linearScore(1.4, 0.8, 2.0) = 50, the only available factor
    const result = scoreQuant({ ...empty, beta: 1.4 });
    expect(result?.score).toBe(50);
    expect(result?.verdict).toBe("Mixed");
    expect(result?.factors).toHaveLength(1);
  });

  it("only averages factors that have data (graceful degradation)", () => {
    // Only beta available -> composite equals the Low-Volatility score alone, not diluted by 3 missing categories
    const result = scoreQuant({ ...empty, beta: 0.8 });
    expect(result?.score).toBe(100);
    expect(result?.factors).toEqual([{ category: "Low-Volatility", score: 100, detail: "Beta 0.80" }]);
  });
});
