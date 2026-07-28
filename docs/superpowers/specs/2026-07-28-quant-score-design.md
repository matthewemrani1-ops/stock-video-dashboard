# Phase 2 — Multi-Factor Quant Score

Date: 2026-07-28
Status: **Approved** — ready for implementation planning.

## Context

This is Phase 2 of the "Signal" project — a sophisticated per-ticker quantitative score, explicitly deferred out of Phase 1's scope (see `docs/superpowers/specs/2026-07-23-cloud-pipeline-design.md`, "Explicitly out of scope for this phase"). Phase 1 (the full daily-digest pipeline, deployed and verified working end-to-end) is complete.

## Scope decisions

1. **Analysis type**: A real quantitative/statistical *scoring* approach using established, already-validated academic finance factors (momentum, value, quality, low-volatility) — not custom-built backtesting infrastructure. Custom backtesting would need a new historical-data vendor, a backtesting engine, and ongoing revalidation — its own multi-phase project, likely bigger than all of Phase 1 combined.
2. **When it runs**: Automatically, for every ranked ticker in the daily digest (not on-demand/per-tap). The additional API/Claude cost multiplies by however many tickers appear each day (typically 10-15).
3. **Relationship to the existing screen**: Added **alongside** the existing Pass/Watch/Caution 3-check screen (`functions/src/lib/screen.ts`), not replacing it. Both shown; existing feature untouched.
4. **Narrative explanation**: Included for every ranked ticker (not gated to a top-N subset) — a short (2-3 sentence) Claude-written explanation grounded strictly in the computed factor numbers (explicitly not the AI's own independent opinion), alongside the numeric score. One more Haiku call per ticker, consistent with how Phase 1's existing AI summaries already work — every ticker gets the full section, no inconsistent per-ticker experience. This is roughly 10-15 extra Haiku calls/day, the same order of magnitude Phase 1 already makes per ticker.

## Architecture

No new data vendor needed. Finnhub's `/stock/metric?metric=all` endpoint — already called once per ticker by the existing `getFundamentals` in `functions/src/lib/finnhub.ts` — includes far more fields than currently extracted: multiple price-return windows, P/B, ROE, margins, debt/equity. This means **zero new API integrations** — just extracting more fields from a call already being made.

```
runPipeline (per ranked ticker, same loop that already calls getFundamentals/getAnalystConsensus)
        │
        ▼
   getQuantFactors(sym, priceKey)  — extends the existing Finnhub metric call
        │
        ▼
   scoreQuant(factors)  — pure, rule-based (like today's screen.ts), no network
        │
        ▼
   RankedTicker.quant = { score: 0-100, verdict, factors: [...], explanation? }
```

## Factor Methodology

Four established factor categories, weighted equally (25% each) into a 0-100 composite:

- **Value (25%)** — P/E and P/B, lower is better. P/E ≤10 → full points, ≥40 → zero (linear between). P/B ≤1 → full, ≥8 → zero. Averaged.
- **Quality (25%)** — ROE, net margin, debt/equity. ROE ≥25% → full, ≤0% → zero. Margin ≥20% → full, ≤0% → zero. D/E ≤0.3 → full, ≥2.5 → zero. Averaged across whichever are available.
- **Momentum (25%)** — 26-week and 52-week price return (deliberately excludes the most recent month, where short-term reversal effects are well documented in the momentum literature). Return ≥30% → full, ≤-20% → zero.
- **Low-Volatility (25%)** — beta (already pulled today for the existing screen). Beta ≤0.8 → full, ≥2.0 → zero. Reflects the low-volatility anomaly (lower vol scores higher).

Each factor degrades gracefully when data's missing (same "unavailable" precedent as the rest of the app) — the composite only weights factors that actually have data.

**Verdict bands** (off the 0-100 composite): **≥75 "Strong," 40-74 "Mixed," <40 "Weak"** — deliberately different wording from today's Pass/Watch/Caution so the two systems aren't confused. The top band is intentionally strict — a ticker needs to score well across most factors, not just average out, to earn "Strong."

The equal 25%/25%/25%/25% weighting is a starting point, not a backtested-optimal weighting (consistent with the chosen scope — no custom backtesting). This is stated plainly in the UI, consistent with the app's existing "not financial advice" / "basic automated check" disclaimer language.

## Components

- **`functions/src/lib/quant.ts`** (new) — pure, no network: `computeMomentumFactor`, `computeValueFactor`, `computeQualityFactor`, `computeLowVolFactor`, and `scoreQuant(factors)` combining them into a composite + verdict + a transparent per-factor breakdown array (same pattern as today's `screen.ts` checks list).
- **`functions/src/lib/finnhub.ts`** — extend the *existing* `getFundamentals` call (not a new API hit) to also extract P/B, ROE, net margin, debt/equity, and the 26/52-week price-return fields from the same `/stock/metric` response. Zero additional Finnhub calls. Field names to use, pending live verification (see Risks below): `pbAnnual` (P/B), `roeTTM` (ROE), `netProfitMarginTTM` (net margin), `totalDebt/totalEquityAnnual` (debt/equity — Finnhub's literal key, including the slash), `26WeekPriceReturnDaily`, `52WeekPriceReturnDaily`.
- **`functions/src/lib/claude.ts`** — new `quantExplanation(sym, factors, score, cfg)`, a short prompt grounded strictly in the computed numbers.
- **`functions/src/lib/types.ts`** — extend `Fundamentals` with the new optional fields; add a `QuantScore` interface; add `RankedTicker.quant?: QuantScore`.
- **`functions/src/lib/pipeline.ts`** — extend the existing per-ticker loop: after fundamentals/analyst are fetched, compute the quant score and (if that succeeds) the explanation, both wrapped in the same isolated try/catch pattern as every other per-ticker field in this file.
- **`frontend/src/digest.js` + `frontend/index.html`** — new "Quant Score" block per ticker card, below the existing screen/fundamentals sections, reusing the existing card-expand UI and CSS patterns where sensible (e.g., `.screen-row`/`.scheck` styling).

**Data flow**: slots into the existing per-ticker loop in `pipeline.ts` — no new pipeline stage, no new scheduling, no new secrets, no new deploy surface.

**Error handling**: same graceful-degradation precedent as everything else in this codebase — missing individual metrics drop that factor from the composite; zero usable factors means `ticker.quant` stays `undefined` (ticker still shows, just without a quant section); a failed explanation call leaves the score/verdict/breakdown intact, just without narrative text.

**Testing**: TDD throughout, matching the established pattern from Phase 1 — `quant.ts`'s factor functions are pure and directly unit-tested (like `screen.ts`), `quantExplanation` gets response-pass-through + full-body-assertion tests (per the established Task 5 lesson: assert the exact system prompt / max_tokens, not just response parsing), `pipeline.ts` gets a computation test plus failure-isolation tests per factor category, and the extended `getFundamentals` gets updated field-mapping tests.

## Risks / Follow-ups

- **Finnhub field names are not yet verified against a live API call.** The names listed above (`pbAnnual`, `roeTTM`, `netProfitMarginTTM`, `totalDebt/totalEquityAnnual`, `26WeekPriceReturnDaily`, `52WeekPriceReturnDaily`) are Finnhub's publicly documented field names but haven't been confirmed against a real response from the deployed `FINNHUB_KEY`. **This must be the first implementation step** — a throwaway script or test hitting the real endpoint and logging the full `metric` object — before `quant.ts` or the `finnhub.ts` extraction is written against assumed names, to avoid building factor logic on fields that don't actually exist or are named differently.
