# Phase 2 — Multi-Factor Quant Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an automatic multi-factor quant score (Value/Quality/Momentum/Low-Volatility, 0-100 composite) to every ranked ticker in the daily digest, alongside the existing Pass/Watch/Caution screen.

**Architecture:** Extend the Finnhub `/stock/metric` response already fetched by `getFundamentals` with six new fields (zero new API calls). A new pure module `quant.ts` scores those fields into a composite (mirrors the existing pure `screen.ts`). A new Claude call `quantExplanation` writes a short narrative grounded in the computed numbers. `pipeline.ts`'s existing per-ticker loop attaches the result to `RankedTicker.quant`. The frontend renders a new card section reusing existing CSS patterns.

**Tech Stack:** TypeScript, Firebase Functions v2, Vitest, vanilla JS/HTML frontend (no bundler, no frontend test harness — matches existing repo state).

## Global Constraints

- Zero new Finnhub API calls — only extract more fields from the existing `/stock/metric` call in `getFundamentals`.
- Zero new secrets, zero new pipeline stages, zero new deploy surface.
- Factor weighting is equal 25%/25%/25%/25% (Value/Quality/Momentum/Low-Volatility) — a stated starting point, not backtested-optimal. This must read that way in the UI copy, consistent with the app's existing "not financial advice" disclaimer language.
- Verdict bands off the 0-100 composite: **≥75 "Strong," 40-74 "Mixed," <40 "Weak."**
- The quant explanation Claude call runs for **every** ranked ticker (not gated to a top-N subset), matching how Phase 1's existing AI summaries already work.
- Every factor degrades gracefully: a category with no underlying data is dropped from the composite entirely (composite only averages categories that have data); zero usable categories means `ticker.quant` stays `undefined`.
- Follow the existing per-ticker isolation pattern in `pipeline.ts`: each independent piece of data collection is wrapped in its own try/catch so one failure never fails the whole run.
- Follow the existing Claude-call test pattern in `claude.test.ts`: assert the exact system prompt string, `max_tokens`, and `model`, not just response parsing.
- No frontend build step or test harness exists in this repo (Phase 1 shipped frontend code without one, verified via live browser testing instead) — don't introduce one for this feature.

---

### Task 1: Verify live Finnhub field names

The design spec (`docs/superpowers/specs/2026-07-28-quant-score-design.md`) flags that the field names below are Finnhub's publicly documented names but have **not** been confirmed against a real `/stock/metric?metric=all` response from the project's deployed `FINNHUB_KEY`. This must happen before Task 2 writes extraction code against assumed names.

Assumed field names (to verify):
- `pbAnnual` — Price/Book
- `roeTTM` — Return on Equity (percent, e.g. `18.4` means 18.4%)
- `netProfitMarginTTM` — Net margin (percent)
- `"totalDebt/totalEquityAnnual"` — Debt/Equity ratio (note the literal slash in the key — Finnhub uses this naming for several ratio fields)
- `"26WeekPriceReturnDaily"` — 26-week price return (percent)
- `"52WeekPriceReturnDaily"` — 52-week price return (percent)

**Files:**
- Create: `functions/scripts/verify-finnhub-fields.mjs`

- [ ] **Step 1: Write the throwaway verification script**

```javascript
// functions/scripts/verify-finnhub-fields.mjs
// One-off diagnostic: confirms the Finnhub /stock/metric field names assumed
// by the quant-score design. Run with: FINNHUB_KEY=xxx node functions/scripts/verify-finnhub-fields.mjs AAPL
// Delete this file once the fields are confirmed (see Task 1, Step 3).

const sym = process.argv[2] || "AAPL";
const key = process.env.FINNHUB_KEY;
if (!key) {
  console.error("Set FINNHUB_KEY in the environment first.");
  process.exit(1);
}

const ASSUMED_FIELDS = [
  "pbAnnual",
  "roeTTM",
  "netProfitMarginTTM",
  "totalDebt/totalEquityAnnual",
  "26WeekPriceReturnDaily",
  "52WeekPriceReturnDaily",
];

const res = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${key}`);
const data = await res.json();
const metric = data.metric || {};

console.log(`\nFull metric object for ${sym} (${Object.keys(metric).length} fields):`);
console.log(JSON.stringify(metric, null, 2));

console.log(`\nAssumed field check:`);
for (const f of ASSUMED_FIELDS) {
  const present = Object.prototype.hasOwnProperty.call(metric, f);
  console.log(`  ${present ? "OK  " : "MISSING"} ${f}${present ? ` = ${metric[f]}` : ""}`);
}
```

- [ ] **Step 2: Run it against a real ticker**

Run: `FINNHUB_KEY=<the deployed key> node functions/scripts/verify-finnhub-fields.mjs AAPL`

Expected: a printed `metric` object and an "Assumed field check" list where all six lines say `OK`.

**If any line says `MISSING`:** search the full printed object for the field that actually holds that data (Finnhub sometimes uses `Annual` vs `TTM` vs `Quarterly` suffixes depending on the metric) and note the correct key name — you'll use the corrected name instead of the assumed one in Task 2, Step 3.

**If you don't have access to `FINNHUB_KEY`:** stop here and ask the user for the key (or for a sample JSON response pasted directly) before proceeding to Task 2 — the design spec requires this verification to happen before extraction code is written against assumed names.

- [ ] **Step 3: Delete the throwaway script**

```bash
rm functions/scripts/verify-finnhub-fields.mjs
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: verify Finnhub quant-score field names (no code changes)"
```

(If Step 2 found corrected field names, note them in the commit message so Task 2 uses the right ones.)

---

### Task 2: Extend `Fundamentals` type and Finnhub extraction

**Files:**
- Modify: `functions/src/lib/types.ts`
- Modify: `functions/src/lib/finnhub.ts`
- Modify: `functions/test/finnhub.test.ts`
- Modify: `functions/test/screen.test.ts` (compile fix only — new fields are required-but-nullable, matching the existing 5 fields' style)
- Modify: `functions/test/pipeline.test.ts` (compile fix only)

**Interfaces:**
- Produces: `Fundamentals` gains six new fields, all `number | null`: `pb`, `roe`, `netMargin`, `debtToEquity`, `return26Week`, `return52Week`.

- [ ] **Step 1: Extend the `Fundamentals` interface**

In `functions/src/lib/types.ts`, replace:

```typescript
export interface Fundamentals {
  pe: number | null;
  marketCap: number | null;
  week52High: number | null;
  week52Low: number | null;
  beta: number | null;
}
```

with:

```typescript
export interface Fundamentals {
  pe: number | null;
  marketCap: number | null;
  week52High: number | null;
  week52Low: number | null;
  beta: number | null;
  pb: number | null;
  roe: number | null;
  netMargin: number | null;
  debtToEquity: number | null;
  return26Week: number | null;
  return52Week: number | null;
}
```

- [ ] **Step 2: Fix the now-broken existing tests (compile-only, no behavior change)**

In `functions/test/screen.test.ts`, every `Fundamentals` object literal needs the six new keys added (as `null`, since these tests aren't about quant data). There are 4 occurrences — for example, line 11:

```typescript
      { pe: 20, marketCap: 1000, week52High: 200, week52Low: 100, beta: 1.2 },
```

becomes:

```typescript
      { pe: 20, marketCap: 1000, week52High: 200, week52Low: 100, beta: 1.2, pb: null, roe: null, netMargin: null, debtToEquity: null, return26Week: null, return52Week: null },
```

Apply the same `, pb: null, roe: null, netMargin: null, debtToEquity: null, return26Week: null, return52Week: null` addition to the other 3 `Fundamentals` literals in that file (lines 27, 33, 39 in the original).

In `functions/test/pipeline.test.ts`, update the `getFundamentals` mock in `baseDeps()`:

```typescript
    getFundamentals: vi.fn().mockResolvedValue({ pe: 20, marketCap: 3000, week52High: 220, week52Low: 150, beta: 1.1 }),
```

becomes:

```typescript
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
```

and update the matching assertion (originally line 37):

```typescript
    expect(doc.rankedTickers[0].fundamentals).toEqual({ pe: 20, marketCap: 3000, week52High: 220, week52Low: 150, beta: 1.1 });
```

becomes:

```typescript
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
```

- [ ] **Step 3: Run the build and full suite to confirm the type change alone doesn't break anything else**

Run: `cd functions && npm run build && npm test`
Expected: build succeeds, all tests pass (this confirms the compile fixes in Step 2 are complete before adding new behavior).

- [ ] **Step 4: Write the failing test for the new Finnhub extraction**

In `functions/test/finnhub.test.ts`, replace the existing `getFundamentals` "maps the metric response" test:

```typescript
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
```

with:

```typescript
describe("getFundamentals", () => {
  it("maps the metric response, including the quant-score fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          metric: {
            peTTM: 22.1,
            marketCapitalization: 3000,
            "52WeekHigh": 200,
            "52WeekLow": 100,
            beta: 1.1,
            pbAnnual: 5.2,
            roeTTM: 18.4,
            netProfitMarginTTM: 12.7,
            "totalDebt/totalEquityAnnual": 0.9,
            "26WeekPriceReturnDaily": 14.3,
            "52WeekPriceReturnDaily": 22.1,
          },
        }),
      })
    );
    expect(await getFundamentals("AAPL", "k")).toEqual({
      pe: 22.1,
      marketCap: 3000,
      week52High: 200,
      week52Low: 100,
      beta: 1.1,
      pb: 5.2,
      roe: 18.4,
      netMargin: 12.7,
      debtToEquity: 0.9,
      return26Week: 14.3,
      return52Week: 22.1,
    });
  });

  it("returns null when there's no metric data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) }));
    expect(await getFundamentals("AAPL", "k")).toBeNull();
  });

  it("defaults the new quant fields to null when Finnhub omits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ metric: { peTTM: 22.1, marketCapitalization: 3000, "52WeekHigh": 200, "52WeekLow": 100, beta: 1.1 } }) })
    );
    const result = await getFundamentals("AAPL", "k");
    expect(result).toEqual({
      pe: 22.1,
      marketCap: 3000,
      week52High: 200,
      week52Low: 100,
      beta: 1.1,
      pb: null,
      roe: null,
      netMargin: null,
      debtToEquity: null,
      return26Week: null,
      return52Week: null,
    });
  });
});
```

**IMPORTANT:** if Task 1 found a corrected field name for any of `pbAnnual`, `roeTTM`, `netProfitMarginTTM`, `totalDebt/totalEquityAnnual`, `26WeekPriceReturnDaily`, `52WeekPriceReturnDaily`, use the corrected name here instead.

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd functions && npm test -- finnhub`
Expected: FAIL — `getFundamentals` doesn't return `pb`/`roe`/`netMargin`/`debtToEquity`/`return26Week`/`return52Week` yet.

- [ ] **Step 6: Implement the extraction**

In `functions/src/lib/finnhub.ts`, replace:

```typescript
export async function getFundamentals(sym: string, key: string): Promise<Fundamentals | null> {
  const r = await fetch(`${BASE}/stock/metric?symbol=${sym}&metric=all&token=${encodeURIComponent(key)}`);
  const fd = (await r.json()) as { metric?: Record<string, number | undefined> };
  const m = fd?.metric;
  if (!m) return null;
  return {
    pe: m.peNormalizedAnnual ?? m.peTTM ?? null,
    marketCap: m.marketCapitalization ?? null,
    week52High: m["52WeekHigh"] ?? null,
    week52Low: m["52WeekLow"] ?? null,
    beta: m.beta ?? null,
  };
}
```

with:

```typescript
export async function getFundamentals(sym: string, key: string): Promise<Fundamentals | null> {
  const r = await fetch(`${BASE}/stock/metric?symbol=${sym}&metric=all&token=${encodeURIComponent(key)}`);
  const fd = (await r.json()) as { metric?: Record<string, number | undefined> };
  const m = fd?.metric;
  if (!m) return null;
  return {
    pe: m.peNormalizedAnnual ?? m.peTTM ?? null,
    marketCap: m.marketCapitalization ?? null,
    week52High: m["52WeekHigh"] ?? null,
    week52Low: m["52WeekLow"] ?? null,
    beta: m.beta ?? null,
    pb: m.pbAnnual ?? null,
    roe: m.roeTTM ?? null,
    netMargin: m.netProfitMarginTTM ?? null,
    debtToEquity: m["totalDebt/totalEquityAnnual"] ?? null,
    return26Week: m["26WeekPriceReturnDaily"] ?? null,
    return52Week: m["52WeekPriceReturnDaily"] ?? null,
  };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd functions && npm test -- finnhub && npm run build`
Expected: PASS, clean build.

- [ ] **Step 8: Commit**

```bash
git add functions/src/lib/types.ts functions/src/lib/finnhub.ts functions/test/finnhub.test.ts functions/test/screen.test.ts functions/test/pipeline.test.ts
git commit -m "feat: extend Fundamentals with quant-score fields from Finnhub"
```

---

### Task 3: Pure quant-scoring module

**Files:**
- Modify: `functions/src/lib/types.ts` (add `QuantFactor`, `QuantScore`, `RankedTicker.quant`)
- Create: `functions/src/lib/quant.ts`
- Create: `functions/test/quant.test.ts`

**Interfaces:**
- Consumes: `Fundamentals` from Task 2 (`pe`, `pb`, `roe`, `netMargin`, `debtToEquity`, `return26Week`, `return52Week`, `beta`, all `number | null`).
- Produces: `scoreQuant(f: Fundamentals | null): QuantScore | null` — used by `pipeline.ts` in Task 5. `QuantScore = { score: number; verdict: "Strong" | "Mixed" | "Weak"; factors: QuantFactor[]; explanation?: string }`. `QuantFactor = { category: "Value" | "Quality" | "Momentum" | "Low-Volatility"; score: number; detail: string }`.

- [ ] **Step 1: Add the new types**

In `functions/src/lib/types.ts`, add after the `Fundamentals` interface:

```typescript
export interface QuantFactor {
  category: "Value" | "Quality" | "Momentum" | "Low-Volatility";
  score: number;
  detail: string;
}

export interface QuantScore {
  score: number;
  verdict: "Strong" | "Mixed" | "Weak";
  factors: QuantFactor[];
  explanation?: string;
}
```

And add `quant?: QuantScore;` to `RankedTicker`, so it reads:

```typescript
export interface RankedTicker {
  sym: string;
  company: string;
  takes: Take[];
  count: number;
  price?: number;
  fundamentals?: Fundamentals;
  profile?: Profile;
  analyst?: Analyst;
  quant?: QuantScore;
}
```

- [ ] **Step 2: Write the failing tests**

Create `functions/test/quant.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd functions && npm test -- quant`
Expected: FAIL — `../src/lib/quant.js` doesn't exist yet.

- [ ] **Step 4: Implement `quant.ts`**

Create `functions/src/lib/quant.ts`:

```typescript
import type { Fundamentals, QuantFactor, QuantScore } from "./types.js";

// Linear interpolation between a "good" value (scores 100) and a "bad" value
// (scores 0), clamped to [0, 100]. Works for both "lower is better" metrics
// (pass good < bad, e.g. P/E) and "higher is better" metrics (pass good > bad, e.g. ROE).
function linearScore(value: number, good: number, bad: number): number {
  const t = (value - bad) / (good - bad);
  return Math.max(0, Math.min(100, t * 100));
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function computeValueFactor(f: Fundamentals): QuantFactor | null {
  const scores: number[] = [];
  const details: string[] = [];
  if (f.pe != null && f.pe > 0) {
    scores.push(linearScore(f.pe, 10, 40));
    details.push(`P/E ${f.pe.toFixed(1)}`);
  }
  if (f.pb != null && f.pb > 0) {
    scores.push(linearScore(f.pb, 1, 8));
    details.push(`P/B ${f.pb.toFixed(1)}`);
  }
  if (scores.length === 0) return null;
  return { category: "Value", score: avg(scores), detail: details.join(", ") };
}

export function computeQualityFactor(f: Fundamentals): QuantFactor | null {
  const scores: number[] = [];
  const details: string[] = [];
  if (f.roe != null) {
    scores.push(linearScore(f.roe, 25, 0));
    details.push(`ROE ${f.roe.toFixed(1)}%`);
  }
  if (f.netMargin != null) {
    scores.push(linearScore(f.netMargin, 20, 0));
    details.push(`Net margin ${f.netMargin.toFixed(1)}%`);
  }
  if (f.debtToEquity != null) {
    scores.push(linearScore(f.debtToEquity, 0.3, 2.5));
    details.push(`D/E ${f.debtToEquity.toFixed(2)}`);
  }
  if (scores.length === 0) return null;
  return { category: "Quality", score: avg(scores), detail: details.join(", ") };
}

export function computeMomentumFactor(f: Fundamentals): QuantFactor | null {
  const scores: number[] = [];
  const details: string[] = [];
  if (f.return26Week != null) {
    scores.push(linearScore(f.return26Week, 30, -20));
    details.push(`26wk ${f.return26Week >= 0 ? "+" : ""}${f.return26Week.toFixed(1)}%`);
  }
  if (f.return52Week != null) {
    scores.push(linearScore(f.return52Week, 30, -20));
    details.push(`52wk ${f.return52Week >= 0 ? "+" : ""}${f.return52Week.toFixed(1)}%`);
  }
  if (scores.length === 0) return null;
  return { category: "Momentum", score: avg(scores), detail: details.join(", ") };
}

export function computeLowVolFactor(f: Fundamentals): QuantFactor | null {
  if (f.beta == null) return null;
  return { category: "Low-Volatility", score: linearScore(f.beta, 0.8, 2.0), detail: `Beta ${f.beta.toFixed(2)}` };
}

export function scoreQuant(f: Fundamentals | null): QuantScore | null {
  if (!f) return null;
  const factors = [computeValueFactor(f), computeQualityFactor(f), computeMomentumFactor(f), computeLowVolFactor(f)].filter(
    (x): x is QuantFactor => x !== null
  );
  if (factors.length === 0) return null;

  const score = avg(factors.map((x) => x.score));
  let verdict: QuantScore["verdict"];
  if (score >= 75) verdict = "Strong";
  else if (score >= 40) verdict = "Mixed";
  else verdict = "Weak";

  return { score, verdict, factors };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd functions && npm test -- quant && npm run build`
Expected: PASS, clean build.

- [ ] **Step 6: Commit**

```bash
git add functions/src/lib/types.ts functions/src/lib/quant.ts functions/test/quant.test.ts
git commit -m "feat: add pure quant-score factor computation (quant.ts)"
```

---

### Task 4: Claude quant explanation

**Files:**
- Modify: `functions/src/lib/claude.ts`
- Modify: `functions/test/claude.test.ts`

**Interfaces:**
- Consumes: `QuantFactor` from Task 3.
- Produces: `quantExplanation(sym: string, factors: QuantFactor[], score: number, cfg: { apiKey: string; model: string }): Promise<string>` — used by `pipeline.ts` in Task 5.

- [ ] **Step 1: Write the failing tests**

In `functions/test/claude.test.ts`, add the import and a new `describe` block. Change the top import line:

```typescript
import { extractTickers, videoWrap, marketRecap, marketHealth } from "../src/lib/claude.js";
```

to:

```typescript
import { extractTickers, videoWrap, marketRecap, marketHealth, quantExplanation } from "../src/lib/claude.js";
```

Then add at the end of the file:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd functions && npm test -- claude`
Expected: FAIL — `quantExplanation` is not exported from `claude.ts`.

- [ ] **Step 3: Implement `quantExplanation`**

In `functions/src/lib/claude.ts`, change the top import line:

```typescript
import type { Extraction, RankedTicker } from "./types.js";
```

to:

```typescript
import type { Extraction, QuantFactor, RankedTicker } from "./types.js";
```

Then add at the end of the file:

```typescript
export async function quantExplanation(sym: string, factors: QuantFactor[], score: number, cfg: ClaudeConfig): Promise<string> {
  const digest = factors.map((f) => `${f.category}: ${f.score.toFixed(0)}/100 (${f.detail})`).join("\n");

  const sys = `You are writing a short factual explanation of a quantitative stock score for a personal dashboard. You will be given a ticker's composite quant score (0-100, made up of up to four equally-weighted factor categories: Value, Quality, Momentum, Low-Volatility) and the underlying metric values behind each factor. Write a 2-3 sentence explanation of what's driving the score, grounded STRICTLY in these numbers — do not add your own independent opinion, prediction, or buy/sell recommendation. Plain text, no headers, no markdown.`;

  return (await callClaude(sys, `${sym} — composite score ${score.toFixed(0)}/100\n${digest}`, 200, cfg)).trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd functions && npm test -- claude && npm run build`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add functions/src/lib/claude.ts functions/test/claude.test.ts
git commit -m "feat: add quantExplanation Claude call"
```

---

### Task 5: Wire quant scoring into the pipeline

**Files:**
- Modify: `functions/src/lib/pipeline.ts`
- Modify: `functions/src/index.ts`
- Modify: `functions/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `scoreQuant` from `quant.ts` (Task 3), `quantExplanation` from `claude.ts` (Task 4).
- Produces: `RankedTicker.quant` is populated on every ticker in `DigestDoc.rankedTickers` where at least one quant factor has data.

- [ ] **Step 1: Write the failing tests**

In `functions/test/pipeline.test.ts`, add `quantExplanation` to `baseDeps()`:

```typescript
    fredWithPrior: vi.fn().mockResolvedValue({ value: 220000, prior: 215000, date: "2026-07-20" }),
    quantExplanation: vi.fn().mockResolvedValue("Solid low-volatility profile driven by beta near 1.0."),
    ...overrides,
```

(This replaces the existing `fredWithPrior` line plus the `...overrides,` line — add the new `quantExplanation` line between them.)

Then add a new `describe` block at the end of the file:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd functions && npm test -- pipeline`
Expected: FAIL — `quantExplanation` is missing from `PipelineDeps`/`ticker.quant` is never set.

- [ ] **Step 3: Implement the pipeline wiring**

In `functions/src/lib/pipeline.ts`, change the top imports:

```typescript
import type { DigestDoc, Extraction, RankedTicker } from "./types.js";
import { rankMentions } from "./ranking.js";
import { screenStock } from "./screen.js";
```

to:

```typescript
import type { DigestDoc, Extraction, QuantFactor, RankedTicker } from "./types.js";
import { rankMentions } from "./ranking.js";
import { screenStock } from "./screen.js";
import { scoreQuant } from "./quant.js";
```

Add `quantExplanation` to the `PipelineDeps` interface, right after `getAnalystConsensus`:

```typescript
  getAnalystConsensus: (sym: string, key: string) => Promise<RankedTicker["analyst"] | null>;
  quantExplanation: (sym: string, factors: QuantFactor[], score: number, cfg: { apiKey: string; model: string }) => Promise<string>;
```

In the per-ticker loop inside `runPipeline`, after the existing `getAnalystConsensus` try/catch block (the last of the four try/catch blocks fetching `q`/`f`/`p`/`a`), add:

```typescript
    const quant = scoreQuant(ticker.fundamentals ?? null);
    if (quant) {
      ticker.quant = quant;
      try {
        ticker.quant.explanation = await deps.quantExplanation(ticker.sym, quant.factors, quant.score, claudeCfg);
      } catch {
        // leave explanation unset -> UI shows score/breakdown without narrative text
      }
    }
```

so the full loop reads:

```typescript
  for (const ticker of ranked) {
    try {
      const q = await deps.getQuote(ticker.sym, secrets.priceKey);
      if (q) ticker.price = q.price;
    } catch {
      // leave price unset
    }
    try {
      const f = await deps.getFundamentals(ticker.sym, secrets.priceKey);
      if (f) ticker.fundamentals = f;
    } catch {
      // leave fundamentals unset -> UI shows "unavailable"
    }
    try {
      const p = await deps.getProfile(ticker.sym, secrets.priceKey);
      if (p) ticker.profile = p;
    } catch {
      // leave profile unset
    }
    try {
      const a = await deps.getAnalystConsensus(ticker.sym, secrets.priceKey);
      if (a) ticker.analyst = a;
    } catch {
      // leave analyst unset
    }

    const quant = scoreQuant(ticker.fundamentals ?? null);
    if (quant) {
      ticker.quant = quant;
      try {
        ticker.quant.explanation = await deps.quantExplanation(ticker.sym, quant.factors, quant.score, claudeCfg);
      } catch {
        // leave explanation unset -> UI shows score/breakdown without narrative text
      }
    }
  }
```

- [ ] **Step 4: Wire `quantExplanation` into the real dependency object**

In `functions/src/index.ts`, change:

```typescript
import { extractTickers, videoWrap, marketRecap, marketHealth } from "./lib/claude.js";
```

to:

```typescript
import { extractTickers, videoWrap, marketRecap, marketHealth, quantExplanation } from "./lib/claude.js";
```

and add `quantExplanation,` to the `deps` object (after `getAnalystConsensus,`):

```typescript
const deps: PipelineDeps = {
  runActor,
  extractTickers,
  videoWrap,
  marketRecap,
  marketHealth,
  getQuote,
  getFundamentals,
  getProfile,
  getAnalystConsensus,
  quantExplanation,
  getGeneralNews,
  fredLatest,
  fredYoY,
  fredWithPrior,
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd functions && npm test && npm run build`
Expected: full suite PASS, clean build (this also re-confirms Tasks 2-4 didn't regress).

- [ ] **Step 6: Commit**

```bash
git add functions/src/lib/pipeline.ts functions/src/index.ts functions/test/pipeline.test.ts
git commit -m "feat: compute and attach quant score to ranked tickers in the pipeline"
```

---

### Task 6: Render the quant score in the frontend

**Files:**
- Modify: `frontend/src/digest.js`
- Modify: `frontend/index.html`

**Interfaces:**
- Consumes: `RankedTicker.quant` (`{ score, verdict, factors: [{category, score, detail}], explanation? }`) as delivered through the existing `digests/{date}` Firestore snapshot listener in `watchDate`.

No automated test harness exists for the frontend in this repo (confirmed: no `frontend` test config, Phase 1 shipped this code path verified only via live browser testing). This task ends with a manual verification step instead of an automated one.

- [ ] **Step 1: Add the quant score CSS**

In `frontend/index.html`, immediately after the existing screen-related rules (after the `.scheck-detail{...}` rule, around line 194), add:

```css
  .chip.quant-strong{background:var(--pos-soft);color:var(--pos);border-color:rgba(64,214,160,.3);font-weight:700}
  .chip.quant-mixed{background:var(--hold-soft);color:var(--hold);border-color:rgba(230,200,131,.3);font-weight:700}
  .chip.quant-weak{background:var(--neg-soft);color:var(--neg);border-color:rgba(242,114,114,.3);font-weight:700}
  .quant-row{padding:14px 20px 14px 58px;border-bottom:1px solid var(--line)}
  .quant-factors{display:flex;flex-direction:column;gap:6px;margin-top:8px}
  .qfactor{font-size:13px;font-family:"JetBrains Mono"}
  .qfactor-detail{color:var(--faint);font-family:"Inter"}
  .quant-explain{font-size:13.5px;line-height:1.55;color:var(--ink);margin-top:10px}
  .quant-note{font-size:11px;color:var(--faint);margin-top:8px}
```

- [ ] **Step 2: Add the render function**

In `frontend/src/digest.js`, immediately after `renderScreenBlock` (after its closing `}`), add:

```javascript
function renderQuantBlock(quant) {
  if (!quant) return "";
  return `
    <div class="quant-row">
      <span class="ak">Quant score — ${quant.score.toFixed(0)}/100 (${esc(quant.verdict)})</span>
      <div class="quant-factors">
        ${quant.factors.map((f) => `<span class="qfactor">${esc(f.category)}: ${f.score.toFixed(0)}/100 <span class="qfactor-detail">(${esc(f.detail)})</span></span>`).join("")}
      </div>
      ${quant.explanation ? `<div class="quant-explain">${esc(quant.explanation)}</div>` : ""}
      <div class="quant-note">Equal-weighted across available factors — not a backtested model. Not financial advice.</div>
    </div>`;
}
```

- [ ] **Step 3: Render the quant chip and block in each ticker card**

In `frontend/src/digest.js`, inside the `ranked.forEach((s, i) => { ... })` loop, find:

```javascript
    const screenResult = docData.screen?.[s.sym];
    const screenChip = screenResult ? `<span class="chip screen-${screenResult.verdict.toLowerCase()}">${screenResult.verdict}</span>` : "";
```

and add right after it:

```javascript
    const quantChip = s.quant ? `<span class="chip quant-${s.quant.verdict.toLowerCase()}">Quant ${esc(s.quant.verdict)}</span>` : "";
```

Then find the card-head line that renders `screenChip`:

```javascript
          <div class="headmid"><span class="chip count">${s.count} video${s.count > 1 ? "s" : ""}</span>${viewChip(dom)}${screenChip}</div>
```

and change it to:

```javascript
          <div class="headmid"><span class="chip count">${s.count} video${s.count > 1 ? "s" : ""}</span>${viewChip(dom)}${screenChip}${quantChip}</div>
```

Finally find the card-body line:

```javascript
        <div class="card-body"><div class="inner">${renderScreenBlock(screenResult)}${fundHtml}${analystHtml}${takesHtml}</div></div>
```

and change it to:

```javascript
        <div class="card-body"><div class="inner">${renderScreenBlock(screenResult)}${renderQuantBlock(s.quant)}${fundHtml}${analystHtml}${takesHtml}</div></div>
```

- [ ] **Step 4: Manual verification**

This repo has no frontend test harness, so verify by hand:

1. Serve `frontend/` locally (however Phase 1 was previously verified — e.g. the existing Netlify dev setup or a static file server) and open the dashboard signed in as the owner.
2. Trigger a real run (`runNow`) or open a date that already has a completed digest.
3. Confirm each ticker card shows:
   - A `Quant Strong` / `Quant Mixed` / `Quant Weak` chip in the card header, color-coded green/gold/red, next to the existing screen chip.
   - Inside the expanded card, a "Quant score — NN/100 (Verdict)" row listing each available factor category with its own score and detail (e.g. "Value: 62/100 (P/E 20.0, P/B 4.0)").
   - The Claude-written explanation paragraph beneath the factor list.
   - The "Equal-weighted... Not financial advice" disclaimer line.
4. Confirm a ticker with sparse Finnhub data (or force one by temporarily editing a card's data in devtools) still renders its card without the quant block breaking layout — i.e. `renderQuantBlock` returns `""` cleanly when `s.quant` is undefined.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/digest.js frontend/index.html
git commit -m "feat: render quant score in ticker cards"
```

---

## Post-plan cleanup

Once all six tasks are complete and committed, the design spec is fully implemented. No further plan-level follow-ups remain — the "Known follow-ups" section of the design spec (field verification, verdict bands, explanation gating) was resolved during brainstorming and is captured in the Global Constraints above.
