# Ticker Deep-Dive Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a precomputed 7-section AI equity-research teardown (business model, financial health, valuation vs. history/peers, bear case, catalysts, position sizing, quarterly buy/pass verdict) to every ranked ticker in the daily digest, alongside the existing quant score and screen.

**Architecture:** Two new Finnhub calls per ticker (`getPeers`, `getHistoricalMetrics` — the latter reads the `series.annual` block of the same `/stock/metric` endpoint shape already used elsewhere, just a fresh call since `getFundamentals` doesn't expose it) plus the existing `getFundamentals` reused against each peer ticker. One new Claude call (`tickerDeepDive`) per ticker returns all 7 sections as one structured JSON object, grounded in the real numbers gathered above. `pipeline.ts`'s existing per-ticker loop attaches the result to `RankedTicker.deepDive`. The frontend renders a second, nested collapsible inside each ticker's existing expandable card.

**Tech Stack:** TypeScript, Firebase Functions v2, Vitest, vanilla JS/HTML frontend (no bundler, no frontend test harness — matches existing repo state).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-29-ticker-deep-dive-design.md`.
- Runs precomputed for **every** ranked ticker during each daily run (not on-demand), same as the quant score.
- Only attempted when `ticker.fundamentals` exists — no point generating a deep dive with no real numbers to ground it (same gating condition philosophy as the quant score).
- Position sizing is **portfolio-percentage only, never a dollar amount** — Signal doesn't track portfolio value.
- Follow the existing per-ticker isolation pattern in `pipeline.ts`: every independent piece of data collection is wrapped in its own try/catch so one failure never fails the whole run or touches unrelated fields.
- Follow the existing Claude-call test pattern in `claude.test.ts`: assert the exact system prompt string, `max_tokens`, and `model`, not just response parsing.
- Follow the existing JSON-parsing pattern used by `extractTickers`: strip code fences, locate the JSON body, `JSON.parse`, return `undefined` (not throw) on any parse or shape failure.
- Pace the peer-fundamentals fan-out (up to 6 concurrent Finnhub calls per ticker) with a short delay between tickers — same rate-limit lesson as the Congress-trading feature's chunked/paced Finnhub calls (`functions/src/lib/congress.ts:182-198`). The delay is injected via a new `deps.sleep(ms)` (not a bare `setTimeout` inline in `pipeline.ts`) specifically so tests can mock it to resolve instantly — a real 500ms wait per ranked ticker would make the test suite take many seconds instead of milliseconds, since most existing tests already exercise a ranked ticker with fundamentals.
- **Verified live against the real `FINNHUB_KEY`** (2026-07-29) — the exact shapes used below are confirmed, not assumed:
  - `/stock/peers?symbol=AAPL` → a flat JSON array of ticker strings, e.g. `["AAPL","DELL","SNDK","WDC","HPE","NTAP","HPQ","P","SMCI","IONQ","GPGI","DBD"]` — includes the queried symbol itself, must be filtered out.
  - `/stock/metric?symbol=AAPL&metric=all` → already includes a `series.annual` object (currently unused by `getFundamentals`) keyed by metric name, each value an array of `{period: "YYYY-MM-DD", v: number}` sorted newest-first, spanning back decades. Confirmed present: `netMargin`, `grossMargin`, `roic`, `netDebtToTotalEquity`, `pe`, `pb`, `pfcf`.
- No frontend build step or test harness exists in this repo — verify frontend changes by hand in the browser, same as every prior feature.

---

### Task 1: Finnhub peer + historical-metrics data layer

**Files:**
- Modify: `functions/src/lib/types.ts`
- Modify: `functions/src/lib/finnhub.ts`
- Test: `functions/test/finnhub.test.ts`

**Interfaces:**
- Produces: `TrendPoint { period: string; value: number }`, `HistoricalMetrics { netMargin, grossMargin, roic, netDebtToEquity, pe, pb, pfcf: TrendPoint[] }`, `PeerComparison { sym: string; fundamentals: Fundamentals }`, `getPeers(sym: string, key: string): Promise<string[]>`, `getHistoricalMetrics(sym: string, key: string): Promise<HistoricalMetrics | null>`.

- [ ] **Step 1: Add the new types**

In `functions/src/lib/types.ts`, add after the `Analyst` interface:

```typescript
export interface TrendPoint {
  period: string;
  value: number;
}

export interface HistoricalMetrics {
  netMargin: TrendPoint[];
  grossMargin: TrendPoint[];
  roic: TrendPoint[];
  netDebtToEquity: TrendPoint[];
  pe: TrendPoint[];
  pb: TrendPoint[];
  pfcf: TrendPoint[];
}

export interface PeerComparison {
  sym: string;
  fundamentals: Fundamentals;
}
```

- [ ] **Step 2: Write the failing tests for `getPeers`**

In `functions/test/finnhub.test.ts`, change the import line to:

```typescript
import { getQuote, getFundamentals, getProfile, getAnalystConsensus, getGeneralNews, getPeers, getHistoricalMetrics } from "../src/lib/finnhub.js";
```

Then add at the end of the file:

```typescript
describe("getPeers", () => {
  it("returns peer tickers, excluding the symbol itself, capped to 6", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ["AAPL", "DELL", "SNDK", "WDC", "HPE", "NTAP", "HPQ", "P", "SMCI"],
      })
    );
    expect(await getPeers("AAPL", "k")).toEqual(["DELL", "SNDK", "WDC", "HPE", "NTAP", "HPQ"]);
  });

  it("returns an empty array when the response isn't an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) }));
    expect(await getPeers("AAPL", "k")).toEqual([]);
  });
});

describe("getHistoricalMetrics", () => {
  it("extracts the last 5 years of each tracked metric from series.annual", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          series: {
            annual: {
              netMargin: [
                { period: "2025-09-27", v: 0.2692 },
                { period: "2024-09-28", v: 0.2397 },
                { period: "2023-09-30", v: 0.2531 },
                { period: "2022-09-24", v: 0.2531 },
                { period: "2021-09-25", v: 0.2588 },
                { period: "2020-09-26", v: 0.2091 },
              ],
              grossMargin: [{ period: "2025-09-27", v: 0.4621 }],
              roic: [{ period: "2025-09-27", v: 0.6451 }],
              netDebtToTotalEquity: [{ period: "2025-09-27", v: 0.8674 }],
              pe: [{ period: "2025-09-27", v: 33.5574 }],
              pb: [{ period: "2025-09-27", v: 50.978 }],
              pfcf: [{ period: "2025-09-27", v: 38.0568 }],
            },
          },
        }),
      })
    );
    const result = await getHistoricalMetrics("AAPL", "k");
    expect(result?.netMargin).toEqual([
      { period: "2025-09-27", value: 0.2692 },
      { period: "2024-09-28", value: 0.2397 },
      { period: "2023-09-30", value: 0.2531 },
      { period: "2022-09-24", value: 0.2531 },
      { period: "2021-09-25", value: 0.2588 },
    ]);
    expect(result?.netDebtToEquity).toEqual([{ period: "2025-09-27", value: 0.8674 }]);
  });

  it("returns null when there's no series.annual data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) }));
    expect(await getHistoricalMetrics("AAPL", "k")).toBeNull();
  });

  it("defaults a missing field to an empty array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ series: { annual: { netMargin: [{ period: "2025-09-27", v: 0.27 }] } } }) })
    );
    const result = await getHistoricalMetrics("AAPL", "k");
    expect(result?.pfcf).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd functions && npx vitest run test/finnhub.test.ts`
Expected: FAIL — `getPeers` and `getHistoricalMetrics` are not exported from `../src/lib/finnhub.js`.

- [ ] **Step 4: Implement `getPeers` and `getHistoricalMetrics`**

In `functions/src/lib/finnhub.ts`, change the top import to:

```typescript
import type { Analyst, Fundamentals, HistoricalMetrics, Profile, TrendPoint } from "./types.js";
```

Then add at the end of the file:

```typescript
export async function getPeers(sym: string, key: string): Promise<string[]> {
  const r = await fetch(`${BASE}/stock/peers?symbol=${sym}&token=${encodeURIComponent(key)}`);
  const data = await r.json();
  if (!Array.isArray(data)) return [];
  return data.filter((s): s is string => typeof s === "string" && s !== sym).slice(0, 6);
}

export async function getHistoricalMetrics(sym: string, key: string): Promise<HistoricalMetrics | null> {
  const r = await fetch(`${BASE}/stock/metric?symbol=${sym}&metric=all&token=${encodeURIComponent(key)}`);
  const fd = (await r.json()) as { series?: { annual?: Record<string, { period: string; v: number }[]> } };
  const annual = fd?.series?.annual;
  if (!annual) return null;
  const pick = (field: string): TrendPoint[] => (annual[field] || []).slice(0, 5).map((p) => ({ period: p.period, value: p.v }));
  return {
    netMargin: pick("netMargin"),
    grossMargin: pick("grossMargin"),
    roic: pick("roic"),
    netDebtToEquity: pick("netDebtToTotalEquity"),
    pe: pick("pe"),
    pb: pick("pb"),
    pfcf: pick("pfcf"),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd functions && npx vitest run test/finnhub.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 6: Type-check and commit**

Run: `cd functions && npx tsc --noEmit`
Expected: no errors.

```bash
git add functions/src/lib/types.ts functions/src/lib/finnhub.ts functions/test/finnhub.test.ts
git commit -m "feat: add getPeers and getHistoricalMetrics to finnhub.ts"
```

---

### Task 2: Claude `tickerDeepDive` report generator

**Files:**
- Modify: `functions/src/lib/types.ts`
- Modify: `functions/src/lib/claude.ts`
- Test: `functions/test/claude.test.ts`

**Interfaces:**
- Consumes: `Fundamentals`, `Profile`, `Analyst`, `QuantScore`, `HistoricalMetrics`, `PeerComparison` (from Task 1 and existing `types.ts`).
- Produces: `DeepDive { businessTeardown: string; financialHealth: string; valuation: string; bearCase: string; catalysts: string; positionSizing: string; quarterlyReview: { verdict: "Buy" | "Pass"; reasoning: string } }`, `tickerDeepDive(sym: string, company: string, ctx: DeepDiveContext, cfg: ClaudeConfig): Promise<DeepDive | undefined>`.

- [ ] **Step 1: Add the `DeepDive` type**

In `functions/src/lib/types.ts`, add after `PeerComparison`:

```typescript
export interface DeepDive {
  businessTeardown: string;
  financialHealth: string;
  valuation: string;
  bearCase: string;
  catalysts: string;
  positionSizing: string;
  quarterlyReview: {
    verdict: "Buy" | "Pass";
    reasoning: string;
  };
}
```

Then extend `RankedTicker` (add after the existing `quant?: QuantScore;` line):

```typescript
  deepDive?: DeepDive;
```

- [ ] **Step 2: Write the failing tests**

In `functions/test/claude.test.ts`, change the import line to:

```typescript
import { extractTickers, videoWrap, marketRecap, marketHealth, quantExplanation, tickerDeepDive } from "../src/lib/claude.js";
```

Then add at the end of the file:

```typescript
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

  it("omits analyst, historical, and peers lines entirely when there's no data for them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(validResponse) }] }) }));
    await tickerDeepDive("AAPL", "Apple", { price: 200, fundamentals, profile: null, analyst: null, quant: null, historical: null, peers: [] }, cfg);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe("AAPL (Apple) — current price $200.00\n\nCurrent fundamentals: P/E 30, P/B 45, ROE 150%, net margin 27%, debt/equity 1.4, beta 1.1, 52wk range $150-$220");
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd functions && npx vitest run test/claude.test.ts`
Expected: FAIL — `tickerDeepDive` is not exported from `../src/lib/claude.js`.

- [ ] **Step 4: Implement `tickerDeepDive`**

In `functions/src/lib/claude.ts`, change the top import to:

```typescript
import type { Analyst, DeepDive, Extraction, FredIndicator, Fundamentals, HistoricalMetrics, PeerComparison, Profile, QuantFactor, QuantScore, RankedTicker } from "./types.js";
```

Then add at the end of the file:

```typescript
export interface DeepDiveContext {
  price: number | null;
  fundamentals: Fundamentals | null;
  profile: Profile | null;
  analyst: Analyst | null;
  quant: QuantScore | null;
  historical: HistoricalMetrics | null;
  peers: PeerComparison[];
}

export async function tickerDeepDive(sym: string, company: string, ctx: DeepDiveContext, cfg: ClaudeConfig): Promise<DeepDive | undefined> {
  const lines: string[] = [`${sym} (${company || sym})${ctx.price != null ? ` — current price $${ctx.price.toFixed(2)}` : ""}`];

  if (ctx.fundamentals) {
    const f = ctx.fundamentals;
    lines.push(
      `Current fundamentals: P/E ${f.pe ?? "n/a"}, P/B ${f.pb ?? "n/a"}, ROE ${f.roe ?? "n/a"}%, net margin ${f.netMargin ?? "n/a"}%, debt/equity ${f.debtToEquity ?? "n/a"}, beta ${f.beta ?? "n/a"}, 52wk range $${f.week52Low ?? "n/a"}-$${f.week52High ?? "n/a"}`
    );
  }
  if (ctx.analyst) {
    lines.push(`Analyst consensus (${ctx.analyst.period}): ${ctx.analyst.buy} buy, ${ctx.analyst.hold} hold, ${ctx.analyst.sell} sell`);
  }
  if (ctx.quant) {
    lines.push(`Quant score: ${ctx.quant.score.toFixed(0)}/100 (${ctx.quant.verdict}) — ${ctx.quant.factors.map((fa) => `${fa.category} ${fa.score.toFixed(0)}/100`).join(", ")}`);
  }
  if (ctx.historical) {
    const trend = (label: string, points: { period: string; value: number }[]) =>
      points.length > 0 ? `${label}: ${points.map((p) => `${p.period.slice(0, 4)}=${p.value.toFixed(2)}`).join(", ")}` : null;
    const historyLines = [
      trend("Net margin (5yr)", ctx.historical.netMargin),
      trend("Gross margin (5yr)", ctx.historical.grossMargin),
      trend("ROIC (5yr)", ctx.historical.roic),
      trend("Net Debt/Equity (5yr)", ctx.historical.netDebtToEquity),
      trend("P/E (5yr)", ctx.historical.pe),
      trend("P/B (5yr)", ctx.historical.pb),
      trend("P/FCF (5yr)", ctx.historical.pfcf),
    ].filter((l): l is string => l !== null);
    if (historyLines.length > 0) lines.push("5-year history (most recent first):\n" + historyLines.join("\n"));
  }
  if (ctx.peers.length > 0) {
    lines.push("Peers:\n" + ctx.peers.map((p) => `${p.sym}: P/E ${p.fundamentals.pe ?? "n/a"}, P/B ${p.fundamentals.pb ?? "n/a"}, net margin ${p.fundamentals.netMargin ?? "n/a"}%`).join("\n"));
  }

  const sys = `You are writing a 7-section equity research teardown for a personal investing dashboard, grounded in the real data given below plus your own general knowledge of the company and industry. Return ONLY a JSON object with exactly these keys, no prose, no code fences:
{
  "businessTeardown": "2-4 sentences: how the company actually makes money, who its customers are, and what its competitive moat is (or the lack of one). Be specific, not generic.",
  "financialHealth": "2-4 sentences on the 5-year margin and ROIC trend, whether free cash flow is running above or below reported net income (compare the P/E and P/FCF multiples given — if P/FCF is meaningfully higher than P/E, free cash flow is running below net income, and vice versa), and the debt/equity trend. State whether the business is getting stronger or weaker overall.",
  "valuation": "2-4 sentences comparing the stock's CURRENT valuation multiples to its OWN 3-5 year historical average, and to the named peer companies given below. Name the peer tickers and their multiples directly.",
  "bearCase": "Exactly three distinct, credible reasons this stock could drop roughly 40% from here. No hedging, no bull-case caveats — argue only this side.",
  "catalysts": "1-3 sentences naming a SPECIFIC event or timeframe in the next 12 months that could force the market to re-rate this stock. If you genuinely can't identify one, say so plainly instead of inventing one.",
  "positionSizing": "1-2 sentences giving a portfolio-PERCENTAGE sizing guideline (never a dollar amount) such that the bear case above would cost less than roughly 2% of a portfolio if it played out.",
  "quarterlyReview": {"verdict": "Buy or Pass", "reasoning": "1-2 sentences: if you didn't already own this stock, would you buy it today at this price? Answer plainly."}
}
Ground every numeric claim in the real data provided — do not invent specific numbers not given to you. This is not financial advice; the reader understands that.`;

  let out = await callClaude(sys, lines.join("\n\n"), 1400, cfg);
  out = out.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start >= 0 && end > start) out = out.slice(start, end + 1);

  try {
    const parsed = JSON.parse(out);
    const valid =
      typeof parsed.businessTeardown === "string" &&
      typeof parsed.financialHealth === "string" &&
      typeof parsed.valuation === "string" &&
      typeof parsed.bearCase === "string" &&
      typeof parsed.catalysts === "string" &&
      typeof parsed.positionSizing === "string" &&
      parsed.quarterlyReview &&
      (parsed.quarterlyReview.verdict === "Buy" || parsed.quarterlyReview.verdict === "Pass") &&
      typeof parsed.quarterlyReview.reasoning === "string";
    return valid ? (parsed as DeepDive) : undefined;
  } catch {
    return undefined;
  }
}
```

Note: `RankedTicker` was already imported in this file before this change and remains used by `videoWrap`; do not remove it from the import line.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd functions && npx vitest run test/claude.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Type-check and commit**

Run: `cd functions && npx tsc --noEmit`
Expected: no errors.

```bash
git add functions/src/lib/types.ts functions/src/lib/claude.ts functions/test/claude.test.ts
git commit -m "feat: add tickerDeepDive Claude report generator"
```

---

### Task 3: Wire the deep dive into the pipeline

**Files:**
- Modify: `functions/src/lib/pipeline.ts:1`, `functions/src/lib/pipeline.ts:14-33`, `functions/src/lib/pipeline.ts:250-285`
- Modify: `functions/src/index.ts:8-12`, `functions/src/index.ts:80-95`
- Test: `functions/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `getPeers`, `getHistoricalMetrics` (Task 1), `tickerDeepDive` (Task 2), all already-existing `PipelineDeps` members.
- Produces: `RankedTicker.deepDive` populated on `runPipeline`'s output for every ranked ticker that has fundamentals and a successful deep-dive call.

- [ ] **Step 1: Update `baseDeps()` and write the failing tests**

In `functions/test/pipeline.test.ts`, add to the `baseDeps()` return object (after the existing `quantExplanation` entry):

```typescript
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
```

Then add a new describe block at the end of the file:

```typescript
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

  it("paces the peer-fetch fan-out with a sleep between tickers that have fundamentals", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({ sleep: sleepMock });
    await runPipeline(input, deps);
    expect(sleepMock).toHaveBeenCalledWith(500);
  });

  it("does not sleep when a ticker has no fundamentals (deep dive skipped entirely)", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({ getFundamentals: vi.fn().mockRejectedValue(new Error("Finnhub 429")), sleep: sleepMock });
    await runPipeline(input, deps);
    expect(sleepMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd functions && npx vitest run test/pipeline.test.ts`
Expected: FAIL — TypeScript error, `PipelineDeps` has no properties `getPeers`/`getHistoricalMetrics`/`tickerDeepDive` yet.

- [ ] **Step 3: Extend `PipelineDeps` and the per-ticker loop**

In `functions/src/lib/pipeline.ts`, change the top import (line 1) to:

```typescript
import type { DigestDoc, Extraction, HistoricalMetrics, PeerComparison, QuantFactor, RankedTicker } from "./types.js";
```

In the `PipelineDeps` interface, add after the existing `quantExplanation` line:

```typescript
  getPeers: (sym: string, key: string) => Promise<string[]>;
  getHistoricalMetrics: (sym: string, key: string) => Promise<HistoricalMetrics | null>;
  tickerDeepDive: (
    sym: string,
    company: string,
    ctx: {
      price: number | null;
      fundamentals: RankedTicker["fundamentals"] | null;
      profile: RankedTicker["profile"] | null;
      analyst: RankedTicker["analyst"] | null;
      quant: RankedTicker["quant"] | null;
      historical: HistoricalMetrics | null;
      peers: PeerComparison[];
    },
    cfg: { apiKey: string; model: string }
  ) => Promise<RankedTicker["deepDive"]>;
  sleep: (ms: number) => Promise<void>;
```

In the per-ticker loop (currently ending with the quant `if (quant) { ... }` block, around line 276-284), add immediately after that block and before the loop's closing `}`:

```typescript
    if (ticker.fundamentals) {
      let peerSyms: string[] = [];
      try {
        peerSyms = await deps.getPeers(ticker.sym, secrets.priceKey);
      } catch {
        // leave peerSyms empty -> deep dive still generates without peer comparison
      }

      const peerResults = await Promise.all(
        peerSyms.map(async (peerSym) => {
          try {
            const pf = await deps.getFundamentals(peerSym, secrets.priceKey);
            return pf ? { sym: peerSym, fundamentals: pf } : null;
          } catch {
            return null;
          }
        })
      );
      const peers = peerResults.filter((p): p is PeerComparison => p !== null);

      let historical: HistoricalMetrics | null = null;
      try {
        historical = await deps.getHistoricalMetrics(ticker.sym, secrets.priceKey);
      } catch {
        historical = null;
      }

      try {
        ticker.deepDive = await deps.tickerDeepDive(
          ticker.sym,
          ticker.company,
          { price: ticker.price ?? null, fundamentals: ticker.fundamentals ?? null, profile: ticker.profile ?? null, analyst: ticker.analyst ?? null, quant: ticker.quant ?? null, historical, peers },
          claudeCfg
        );
      } catch {
        // leave deepDive unset -> ticker card just doesn't show the extra section
      }

      // Pace peer-fetch fan-outs between tickers (up to 6 concurrent Finnhub
      // calls just happened above) to avoid bursting past Finnhub's rate
      // limit — same lesson as the Congress-trading feature's chunked/paced
      // Finnhub calls (functions/src/lib/congress.ts:182-198). Injected via
      // deps.sleep (not a bare setTimeout) so tests can make this instant.
      await deps.sleep(500);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd functions && npx vitest run test/pipeline.test.ts`
Expected: PASS (all tests in the file, including every pre-existing test — none of them override `getPeers`/`getHistoricalMetrics`/`tickerDeepDive`, so they all get the new no-op/empty defaults and are unaffected).

- [ ] **Step 5: Wire the real implementations into production**

In `functions/src/index.ts`, change the import lines (around lines 10-12) to:

```typescript
import { extractTickers, videoWrap, marketRecap, marketHealth, quantExplanation, tickerDeepDive } from "./lib/claude.js";
import { getQuote, getFundamentals, getProfile, getAnalystConsensus, getGeneralNews, getPeers, getHistoricalMetrics } from "./lib/finnhub.js";
```

In the `deps` object (around lines 80-95), add after the existing `quantExplanation,` line:

```typescript
  getPeers,
  getHistoricalMetrics,
  tickerDeepDive,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
```

- [ ] **Step 6: Type-check, run the full suite, and commit**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: no type errors; every test in the suite passes, including all tests added in Tasks 1-3.

```bash
git add functions/src/lib/pipeline.ts functions/src/index.ts functions/test/pipeline.test.ts
git commit -m "feat: wire ticker deep dive into the daily pipeline"
```

---

### Task 4: Frontend rendering + manual verification

**Files:**
- Modify: `frontend/src/digest.js`
- Modify: `frontend/index.html`

**Interfaces:**
- Consumes: `s.deepDive` (a `DeepDive` object or `undefined`) on each ranked ticker from `docData.rankedTickers`, same shape produced by Task 2/3.

- [ ] **Step 1: Add `renderDeepDiveBlock` and wire it into the card**

In `frontend/src/digest.js`, add a new function right after `renderQuantBlock`:

```javascript
function renderDeepDiveBlock(deepDive, i) {
  if (!deepDive) return "";
  const sections = [
    ["Business Teardown", deepDive.businessTeardown],
    ["Financial Health Check", deepDive.financialHealth],
    ["Valuation vs. History & Peers", deepDive.valuation],
    ["The Case Against", deepDive.bearCase],
    ["Catalysts & the Clock", deepDive.catalysts],
    ["Position Sizing & Entry", deepDive.positionSizing],
    [`The Quarterly Review — ${deepDive.quarterlyReview.verdict}`, deepDive.quarterlyReview.reasoning],
  ];
  return `
    <div class="deepdive" id="dd${i}">
      <div class="deepdive-head" onclick="document.getElementById('dd${i}').classList.toggle('open')">
        <span>Full Deep Dive</span><span class="dd-chev">▾</span>
      </div>
      <div class="deepdive-body"><div class="inner">
        ${sections.map(([title, body]) => `<div class="dd-section"><div class="ak">${esc(title)}</div><p>${esc(body)}</p></div>`).join("")}
        <div class="quant-note">AI-generated analysis grounded in real fundamentals and market data where available — not financial advice. Verify before acting.</div>
      </div></div>
    </div>`;
}
```

Then find the card-body line (currently reads `${renderScreenBlock(screenResult)}${renderQuantBlock(s.quant)}${fundHtml}${analystHtml}${takesHtml}`) and change it to:

```javascript
        <div class="card-body"><div class="inner">${renderScreenBlock(screenResult)}${renderQuantBlock(s.quant)}${renderDeepDiveBlock(s.deepDive, i)}${fundHtml}${analystHtml}${takesHtml}</div></div>
```

- [ ] **Step 2: Add the CSS**

In `frontend/index.html`, add right after the existing `.quant-note{...}` rule:

```css
  .deepdive{border-bottom:1px solid var(--line)}
  .deepdive-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 20px 12px 58px;cursor:pointer;font-size:11.5px;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:.06em}
  .dd-chev{color:var(--faint);transition:transform .22s;font-size:12px}
  .deepdive.open .dd-chev{transform:rotate(180deg);color:var(--gold)}
  .deepdive-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s ease}
  .deepdive.open .deepdive-body{grid-template-rows:1fr}
  .deepdive-body > .inner{overflow:hidden}
  .dd-section{padding:10px 20px 10px 58px}
  .dd-section p{font-size:13.5px;line-height:1.55;color:var(--ink);margin-top:6px}
```

- [ ] **Step 3: Manual verification**

This repo has no frontend test harness, so verify by hand:

1. Open the live dashboard signed in as the owner and trigger a run (or open a date that already has a completed digest with ranked tickers).
2. Confirm each ticker card that has fundamentals now shows a "Full Deep Dive" toggle below the existing Quant Score row, closed by default even when the card itself is expanded.
3. Click the toggle and confirm it expands smoothly (matching the existing card's expand animation) to reveal all 7 sections in order, each with a heading and body text, ending with the "AI-generated analysis... not financial advice" note.
4. Confirm the "Quarterly Review" heading includes the verdict (e.g. "The Quarterly Review — Buy").
5. Confirm a ticker with no fundamentals (or force one by editing data in devtools) renders its card without the deep-dive toggle at all — i.e. `renderDeepDiveBlock` returns `""` cleanly when `s.deepDive` is undefined.
6. Toggle the deep dive open, then collapse the outer card — confirm nothing breaks and reopening the card leaves the deep dive in whatever state (open/closed) it was left in.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/digest.js frontend/index.html
git commit -m "feat: render ticker deep dive report in ticker cards"
```

---

## Post-plan cleanup

Once all four tasks are complete and committed, the design spec is fully implemented. Deployment (Firebase Functions + Netlify) is a separate step after this plan, same as every prior feature in this project — not part of the plan itself.
