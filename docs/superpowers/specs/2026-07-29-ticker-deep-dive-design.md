# Ticker Deep-Dive Report

Date: 2026-07-29
Status: **Approved** — ready for implementation planning.

## Context

The existing quant score (`docs/superpowers/specs/2026-07-28-quant-score-design.md`) gives each ranked ticker a numeric factor score. This adds a much richer, structured qualitative report per ticker — a 7-part equity-research-style teardown covering the business, financial health, valuation, bear case, catalysts, position sizing, and a final buy/pass verdict. It sits alongside the quant score, not replacing it.

The 7 sections, as specified by the user:

1. **Business teardown** — how it makes money, customers, moat.
2. **Financial health check** — margins, FCF vs. net income, net debt, share count, return on capital, trend direction.
3. **Valuation vs. its own history and peers** — current multiples vs. the stock's own 3-5yr average, and vs. 4-6 real comps.
4. **The case against** — three credible bear-case reasons for a 40% drop, no hedging.
5. **Catalysts and the clock** — a specific event in the next 12 months that forces a re-rate.
6. **Position sizing and entry** — sizing so the bear case costs <2% of portfolio.
7. **The quarterly review** — a plain yes/no: would you buy today at this price.

## Scope decisions

1. **When it runs**: Precomputed automatically for every ranked ticker during the daily pipeline run (same as the quant score), not generated on-demand when a user opens a ticker. This means one more Claude call and a handful more Finnhub calls per ranked ticker per day (up to `topN`, typically 10-15).
2. **Data grounding**: Real data wherever Finnhub already provides it cheaply; Claude fills in qualitative/historical gaps (business model narrative, moat, specific catalysts) from its own trained knowledge, clearly framed as needing verification — consistent with this app's existing "not financial advice" precedent.
3. **Financial Health Check scope trim**: True 5-year FCF, net-debt, and share-count *series* aren't reliably available from Finnhub's basic tier without parsing as-reported financial statements (a fragile, unverified integration). Scoped instead to: current FCF-vs-net-income, current net debt, current share count (each a single real value), plus a **real 5-year margin/ratio trend** — which Finnhub's existing `/stock/metric` response already includes (in a `series.annual` block this app currently ignores), so no new endpoint is needed for that part. The narrative describes trajectory in words rather than the app building a numeric multi-year FCF/net-debt chart.
4. **Position sizing**: Expressed purely as a portfolio-percentage framework (e.g., "cap around X% given the bear case implies ~40% downside") — no dollar amounts, since Signal doesn't track portfolio value or holdings.
5. **Relationship to the existing quant score/screen**: Additive. `RankedTicker.quant` and `screen[sym]` are untouched; this is a new `RankedTicker.deepDive` field.

## Architecture

```
runPipeline (per ranked ticker, same loop that already computes quant)
        │
        ▼
   getPeers(sym, priceKey)              — NEW Finnhub call: 4-6 comparable tickers
        │
        ▼
   getFundamentals(peerSym, priceKey)   — reuses EXISTING function, once per peer
        │  (paced/chunked — see Risks)
        ▼
   marginTrend = parsed from the SAME /stock/metric response
                 already fetched for this ticker's own getFundamentals
                 (extend the existing call to also return series.annual)
        │
        ▼
   tickerDeepDive(sym, fundamentals, profile, analyst, quant,
                  peers + their fundamentals, marginTrend, cfg)  — NEW, 1 Claude call
        │
        ▼
   RankedTicker.deepDive = { businessTeardown, financialHealth, valuation,
                             bearCase, catalysts, positionSizing, quarterlyReview }
```

No new pipeline stage, no new secrets, no new scheduling — slots into the existing per-ticker loop in `pipeline.ts`, same as the quant score did.

## Components

- **`functions/src/lib/finnhub.ts`**:
  - New `getPeers(sym, key): Promise<string[]>` — calls `/stock/peers?symbol=X`, returns the peer ticker list (capped to 6).
  - Extend `getFundamentals` (or add a sibling `getMarginTrend`) to also parse `series.annual` from the `/stock/metric` response already being fetched, returning a small array of `{ year, netMargin, grossMargin }`-style points. **Field names and the exact shape of `series.annual` are not yet verified against a live response — this must be the first implementation step**, same lesson as the quant score's Finnhub verification.
- **`functions/src/lib/claude.ts`**: new `tickerDeepDive(sym, ctx, cfg)` where `ctx` bundles fundamentals, profile, analyst, quant score/factors, price, peer list with their fundamentals, and the margin trend. Prompts for and parses a single JSON object with the 7 keys (same JSON-extraction pattern already used by `extractTickers`: strip code fences, locate `{`...`}`, `JSON.parse`, return `undefined` on any parse failure rather than throwing).
- **`functions/src/lib/types.ts`**:
  - New `DeepDive` interface: `{ businessTeardown: string; financialHealth: string; valuation: string; bearCase: string; catalysts: string; positionSizing: string; quarterlyReview: { verdict: "Buy" | "Pass"; reasoning: string } }`.
  - `RankedTicker.deepDive?: DeepDive`.
  - `Fundamentals` or a new small type gets the peer-comparison and margin-trend shapes.
- **`functions/src/lib/pipeline.ts`**: extend the existing per-ticker loop — after quant scoring, if `ticker.fundamentals` exists (same gating condition the quant score already uses — no point generating a deep dive with no real numbers to ground it), fetch peers (paced), fetch each peer's fundamentals (reusing `getFundamentals`, paced), pull the margin trend, then call `tickerDeepDive`. Wrapped in the same isolated try/catch pattern as every other per-ticker field — a failure here leaves `ticker.deepDive` `undefined`, doesn't touch quant/screen/price, and doesn't fail the run.
- **`frontend/src/digest.js` + `frontend/index.html`**: a second, nested collapsible inside each ticker's existing expandable card, closed by default even when the card itself is open (this is a lot of extra text) — labeled "Full Deep Dive," rendering the 7 sections in order with the existing disclaimer styling.

**Error handling**: same graceful-degradation precedent as the rest of this codebase. `getPeers` failing means an empty peer list (deep dive still generates, valuation section just leans more on historical-self comparison); a peer's `getFundamentals` failing is skipped like any other per-ticker fetch failure; `tickerDeepDive` failing or returning unparseable JSON leaves `ticker.deepDive` `undefined` — the card just doesn't show the extra section, nothing else breaks.

**Testing**: TDD throughout, matching the established pattern — `tickerDeepDive`'s JSON parsing gets response-pass-through and malformed-JSON tests; `getPeers`/margin-trend parsing get field-mapping tests once the real shape is verified; `pipeline.ts` gets a happy-path test plus failure-isolation tests (peers fail, a peer's fundamentals fail, the Claude call fails/returns garbage) proving the rest of the ticker's data is untouched.

## Risks / Follow-ups

- **`series.annual` shape is not yet verified against a live Finnhub response.** Must be checked live (same pattern as the quant score's Finnhub verification) before writing the parsing logic against assumed field names.
- **`/stock/peers` availability/tier** should also be confirmed live for the first implementation step, alongside the `series.annual` check.
- **Added Finnhub call volume**: up to ~(1 peers call + up to 6 peer-fundamentals calls) × up to `topN` tickers per run. Will pace/chunk these calls the same way the Congress-trading feature already does, to avoid repeating that feature's earlier rate-limit incident.
- **Claude call cost/latency**: one more Claude call per ranked ticker per day, same order of magnitude the quant-score explanation already added. The 7-section prompt is larger than existing prompts (e.g. `quantExplanation`'s 200 max_tokens) — needs a meaningfully higher `max_tokens` budget, to be tuned during implementation.
