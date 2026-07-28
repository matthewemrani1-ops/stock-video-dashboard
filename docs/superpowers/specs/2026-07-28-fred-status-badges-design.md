# FRED Indicator Status Badges

Date: 2026-07-28
Status: **Approved** — ready for implementation planning.

## Context

The "Economic Indicators · FRED" card strip on the Signal dashboard (`frontend/index.html`/`frontend/src/digest.js`) currently shows each indicator's label, raw value, and a static descriptive `note` string sourced from `functions/src/lib/pipeline.ts`'s `loadFred()`. This has two problems, both raised directly against a live screenshot of the deployed dashboard: the raw values have no unit (no `%`, no `K` on the six-digit jobless-claims count) and give no sense of whether a reading is normal or notable, and the note strings vary widely in length, producing a visually jagged card grid.

The user provided a mockup showing the desired result: formatted values (`+0.34%`, `4.2%`, `187K`) with a short colored status caption underneath ("normal range" in green, "⚠ elevated" in a warning color), replacing the long descriptive note text.

## Scope decision

This is a real feature addition — per-indicator threshold logic that classifies each FRED reading as normal or warning — not a pure styling tweak. Three of the six indicators already have qualitative thresholds embedded in this codebase's own `marketHealth` AI system prompt (`functions/src/lib/claude.ts`): 10Y-2Y spread negative = inverted/recession warning, CPI above ~3% = elevated, Industrial Production negative = contraction. The other three (Unemployment Rate, Fed Funds Rate, Initial Jobless Claims) had no existing numeric cutoff; the thresholds below were proposed and approved directly.

## Data shape

Each entry in `DigestDoc["fred"]` (`functions/src/lib/types.ts`) gains two new fields. The existing `label`, `value`, and `note` fields are **unchanged** — `note` is still consumed by `marketHealth`'s digest-building in `claude.ts`, which needs the full descriptive context, not just a short status word. This is additive, not a breaking rename.

```typescript
export interface FredIndicator {
  label: string;
  value: number;
  note: string;                                    // unchanged, still used by marketHealth's AI digest
  unit: "percent-signed" | "percent" | "count-k";   // new
  status: "normal" | "warning";                     // new
  statusLabel: string;                              // new — exact caption text
}
```

(`DigestDoc["fred"]` becomes `FredIndicator[] | undefined`, replacing today's inline `{ label; value; note }[]` shape.)

## Thresholds and units

Computed inline in `loadFred()` in `functions/src/lib/pipeline.ts` — six simple range-checks, one per indicator. This does **not** warrant a dedicated pure module like `quant.ts`/`screen.ts`; those exist for multi-factor weighted composites, and this is a single value compared to a single threshold, computed independently per indicator.

| Indicator | Unit | Warning when | statusLabel if warning | statusLabel if normal |
|---|---|---|---|---|
| 10Y-2Y Yield Spread | `percent-signed` | value < 0 | "⚠ inverted" | "normal range" |
| Unemployment Rate | `percent` | value > 5.0 | "⚠ elevated" | "normal range" |
| Fed Funds Rate | `percent` | never (no natural threshold) | — | "normal range" (always) |
| CPI Inflation (YoY) | `percent-signed` | value > 3.0 | "⚠ elevated" | "normal range" |
| Initial Jobless Claims | `count-k` | value > 275000 | "⚠ elevated" | "normal range" |
| Industrial Production (YoY) | `percent-signed` | value < 0 | "⚠ contracting" | "normal range" |

The card labels for the last two indicators change from "CPI Inflation" / "Industrial Production" to **"CPI Inflation (YoY)"** / **"Industrial Production (YoY)"** to make the time window explicit, matching the mockup.

The 275,000/week Jobless Claims threshold is the midpoint of the "250k-300k weekly" range this app's own generated `marketHealth` prose has already used as an informal recession-warning zone — not a new invented number.

## Formatting

A small formatter in `frontend/src/digest.js`, driven by the new `unit` field:
- `percent-signed`: `+`/`-` sign prefix, `%` suffix, 1 decimal place (e.g. `+3.5%`, `-0.3%`)
- `percent`: `%` suffix, no sign, 1 decimal place (e.g. `4.2%`)
- `count-k`: divide by 1000, round to nearest whole number, `K` suffix (e.g. `187K`)

All percentages render to 1 decimal place uniformly, for consistency. (The mockup showed mixed precision across cards — treated as illustrative rather than an exact spec.)

## Frontend rendering

`renderQuantBlock`-style small formatter function in `digest.js` replaces the plain-gray `.if` note caption (added in the immediately preceding hotfix) with a colored `statusLabel` line: green for `status: "normal"`, a warning/red color for `status: "warning"`. Because `statusLabel` is always short (2-3 words), this also resolves the jagged-card-height problem as a side effect — every card's caption is now roughly the same length, so the grid lines up cleanly without needing separate height-normalization CSS.

CSS: reuse the existing `--pos`/`--neg` color variables already used elsewhere in this file (e.g. the screen/quant verdict chips), for consistency rather than introducing new colors.

## Error handling

Unchanged from today: `loadFred()` already isolates each of the 6 FRED calls independently (fixed earlier this session) — a single failed call drops that one indicator from the array rather than failing the whole strip. The new `status`/`statusLabel`/`unit` fields are computed only for indicators that successfully returned data, so there's no new failure surface.

## Testing

Extend `functions/test/pipeline.test.ts` (which already tests `loadFred` indirectly through `runPipeline`) with cases proving each indicator's warning/normal boundary — e.g. a 10Y-2Y value of exactly 0 and one below 0, a CPI value at/above/below 3.0, etc. No frontend test harness exists in this repo (confirmed established precedent from the quant-score feature) — the frontend formatting change gets the same manual-verification treatment as prior frontend work, not a new test framework.
