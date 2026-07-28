# FRED Indicator Status Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the FRED indicator strip's long static note captions with a computed normal/warning status per indicator — a formatted value (`+3.5%`, `4.2%`, `187K`) plus a short colored status label ("normal range" / "⚠ elevated" / etc.), matching an approved mockup.

**Architecture:** Six independent threshold checks computed inline in the existing `loadFred()` in `functions/src/lib/pipeline.ts` (already isolates each of the 6 FRED calls independently, from an earlier fix this session — this plan builds on that, doesn't touch the isolation logic itself). Two new fields (`unit`, `status`, `statusLabel` — three, not two) ride alongside the existing `label`/`value`/`note` fields on each `DigestDoc["fred"]` entry. The frontend gets a small formatter function and swaps today's plain-gray note caption for a colored status caption.

**Tech Stack:** TypeScript, Firebase Functions v2, Vitest, vanilla JS/HTML frontend (no bundler, no frontend test harness).

## Global Constraints

- `note` stays on every `FredIndicator` entry unchanged — `marketHealth`'s digest-building in `claude.ts` still consumes it for AI context. This is additive, not a breaking rename.
- Six thresholds, exact values:
  - 10Y-2Y Yield Spread (`percent-signed`): warning when value < 0, label "⚠ inverted"
  - Unemployment Rate (`percent`): warning when value > 5.0, label "⚠ elevated"
  - Fed Funds Rate (`percent`): never warns — always `status: "normal"`, `statusLabel: "normal range"`
  - CPI Inflation (YoY) (`percent-signed`): warning when value > 3.0, label "⚠ elevated" — label also renames from "CPI Inflation" to "CPI Inflation (YoY)"
  - Initial Jobless Claims (`count-k`): warning when value > 275000, label "⚠ elevated"
  - Industrial Production (YoY) (`percent-signed`): warning when value < 0, label "⚠ contracting" — label also renames from "Industrial Production" to "Industrial Production (YoY)"
  - Every non-warning case: `status: "normal"`, `statusLabel: "normal range"`
- Value formatting: `percent-signed` = sign prefix (`+`/`-`) + 1 decimal + `%` (e.g. `+3.5%`, `-0.3%`); `percent` = 1 decimal + `%`, no sign (e.g. `4.2%`); `count-k` = value ÷ 1000, rounded to nearest whole number, `K` suffix (e.g. `187K`).
- No dedicated pure module for this (unlike `quant.ts`/`screen.ts`) — six simple range-checks computed inline in `loadFred()`.
- No frontend build step or test harness exists in this repo — none introduced for this feature; frontend task ends with manual verification instead of automated tests.

---

### Task 1: Backend — FRED status computation

**Files:**
- Modify: `functions/src/lib/types.ts`
- Modify: `functions/src/lib/pipeline.ts:121-167` (the `loadFred` function)
- Modify: `functions/test/pipeline.test.ts`

**Interfaces:**
- Produces: `FredIndicator` type — `{ label: string; value: number; note: string; unit: "percent-signed" | "percent" | "count-k"; status: "normal" | "warning"; statusLabel: string }`. `DigestDoc["fred"]` becomes `FredIndicator[] | undefined`. Consumed by Task 2's frontend formatter.

- [ ] **Step 1: Add the `FredIndicator` type and update `DigestDoc`**

In `functions/src/lib/types.ts`, add a new exported interface right before `DigestDoc`:

```typescript
export interface FredIndicator {
  label: string;
  value: number;
  note: string;
  unit: "percent-signed" | "percent" | "count-k";
  status: "normal" | "warning";
  statusLabel: string;
}
```

Then change the `fred` field on `DigestDoc` from:

```typescript
  fred?: { label: string; value: number; note: string }[];
```

to:

```typescript
  fred?: FredIndicator[];
```

- [ ] **Step 2: Write the failing tests**

In `functions/test/pipeline.test.ts`, add a new `describe` block at the end of the file:

```typescript
describe("runPipeline — FRED indicator status", () => {
  it("flags an inverted 10Y-2Y spread as a warning", async () => {
    const deps = baseDeps({
      fredLatest: vi.fn().mockImplementation((seriesId: string) => {
        if (seriesId === "T10Y2Y") return Promise.resolve({ value: -0.15, date: "2026-07-20" });
        return Promise.resolve({ value: 4.3, date: "2026-07-20" });
      }),
    });
    const doc = await runPipeline(input, deps);
    const spread = doc.fred?.find((f) => f.label === "10Y-2Y Yield Spread");
    expect(spread).toEqual({
      label: "10Y-2Y Yield Spread",
      value: -0.15,
      note: "negative = inverted curve, historically a recession warning",
      unit: "percent-signed",
      status: "warning",
      statusLabel: "⚠ inverted",
    });
  });

  it("treats a positive 10Y-2Y spread as normal", async () => {
    const doc = await runPipeline(input, baseDeps());
    const spread = doc.fred?.find((f) => f.label === "10Y-2Y Yield Spread");
    expect(spread?.status).toBe("normal");
    expect(spread?.statusLabel).toBe("normal range");
  });

  it("flags elevated unemployment (>5.0%) as a warning", async () => {
    const deps = baseDeps({
      fredLatest: vi.fn().mockImplementation((seriesId: string) => {
        if (seriesId === "UNRATE") return Promise.resolve({ value: 5.5, date: "2026-07-20" });
        return Promise.resolve({ value: 4.3, date: "2026-07-20" });
      }),
    });
    const doc = await runPipeline(input, deps);
    const unrate = doc.fred?.find((f) => f.label === "Unemployment Rate");
    expect(unrate).toEqual({
      label: "Unemployment Rate",
      value: 5.5,
      note: "%",
      unit: "percent",
      status: "warning",
      statusLabel: "⚠ elevated",
    });
  });

  it("never flags Fed Funds Rate as a warning, regardless of value", async () => {
    const deps = baseDeps({
      fredLatest: vi.fn().mockImplementation((seriesId: string) => {
        if (seriesId === "FEDFUNDS") return Promise.resolve({ value: 20, date: "2026-07-20" });
        return Promise.resolve({ value: 4.3, date: "2026-07-20" });
      }),
    });
    const doc = await runPipeline(input, deps);
    const fedfunds = doc.fred?.find((f) => f.label === "Fed Funds Rate");
    expect(fedfunds).toEqual({
      label: "Fed Funds Rate",
      value: 20,
      note: "% — the Fed's benchmark interest rate",
      unit: "percent",
      status: "normal",
      statusLabel: "normal range",
    });
  });

  it("flags elevated CPI (>3.0%) as a warning and renames the label to include (YoY)", async () => {
    const deps = baseDeps({ fredYoY: vi.fn().mockResolvedValue({ value: 3.5, date: "2026-07-20" }) });
    const doc = await runPipeline(input, deps);
    const cpi = doc.fred?.find((f) => f.label === "CPI Inflation (YoY)");
    expect(cpi).toEqual({
      label: "CPI Inflation (YoY)",
      value: 3.5,
      note: "% year-over-year — above ~3% is elevated vs. the Fed's ~2% target",
      unit: "percent-signed",
      status: "warning",
      statusLabel: "⚠ elevated",
    });
  });

  it("flags elevated jobless claims (>275000) as a warning", async () => {
    const deps = baseDeps({ fredWithPrior: vi.fn().mockResolvedValue({ value: 300000, prior: 280000, date: "2026-07-20" }) });
    const doc = await runPipeline(input, deps);
    const claims = doc.fred?.find((f) => f.label === "Initial Jobless Claims");
    expect(claims).toEqual({
      label: "Initial Jobless Claims",
      value: 300000,
      note: "weekly new unemployment claims, rising vs. prior week",
      unit: "count-k",
      status: "warning",
      statusLabel: "⚠ elevated",
    });
  });

  it("flags contracting industrial production (<0%) as a warning and renames the label to include (YoY)", async () => {
    const deps = baseDeps({ fredYoY: vi.fn().mockResolvedValue({ value: -1.2, date: "2026-07-20" }) });
    const doc = await runPipeline(input, deps);
    const indpro = doc.fred?.find((f) => f.label === "Industrial Production (YoY)");
    expect(indpro).toEqual({
      label: "Industrial Production (YoY)",
      value: -1.2,
      note: "% year-over-year — manufacturing/production health proxy",
      unit: "percent-signed",
      status: "warning",
      statusLabel: "⚠ contracting",
    });
  });
});
```

**Note:** the "flags elevated CPI" and "flags contracting industrial production" tests both override `fredYoY` globally (it's used for both CPIAUCSL and INDPRO) — this is fine because each test only asserts on the one indicator it's testing.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd functions && npm test -- pipeline`
Expected: FAIL — `doc.fred` entries don't have `unit`/`status`/`statusLabel` fields yet, and `TypeScript` will also flag the `NonNullable<DigestDoc["fred"]>` push calls in `pipeline.ts` as missing required fields once Step 1's type change lands (run `npm run build` too if `npm test` doesn't surface it — vitest may not type-check).

- [ ] **Step 4: Implement the threshold classification**

In `functions/src/lib/pipeline.ts`, add this helper function immediately before `loadFred` (after `loadIndexAndMacroQuotes`, before the `async function loadFred` line):

```typescript
function classifyFred(isWarning: boolean, warningLabel: string): { status: "normal" | "warning"; statusLabel: string } {
  return isWarning ? { status: "warning", statusLabel: warningLabel } : { status: "normal", statusLabel: "normal range" };
}
```

Then replace the entire body of `loadFred` (from `const results: NonNullable<DigestDoc["fred"]> = [];` through the final `if (indpro.status === "fulfilled") { ... }` block, just before `return results.length > 0 ? results : undefined;`) with:

```typescript
  const results: NonNullable<DigestDoc["fred"]> = [];
  if (spread.status === "fulfilled") {
    results.push({
      label: "10Y-2Y Yield Spread",
      value: spread.value.value,
      note: "negative = inverted curve, historically a recession warning",
      unit: "percent-signed",
      ...classifyFred(spread.value.value < 0, "⚠ inverted"),
    });
  } else {
    console.error("FRED T10Y2Y failed:", spread.reason);
  }
  if (unrate.status === "fulfilled") {
    results.push({
      label: "Unemployment Rate",
      value: unrate.value.value,
      note: "%",
      unit: "percent",
      ...classifyFred(unrate.value.value > 5.0, "⚠ elevated"),
    });
  } else {
    console.error("FRED UNRATE failed:", unrate.reason);
  }
  if (fedfunds.status === "fulfilled") {
    results.push({
      label: "Fed Funds Rate",
      value: fedfunds.value.value,
      note: "% — the Fed's benchmark interest rate",
      unit: "percent",
      status: "normal",
      statusLabel: "normal range",
    });
  } else {
    console.error("FRED FEDFUNDS failed:", fedfunds.reason);
  }
  if (cpi.status === "fulfilled") {
    results.push({
      label: "CPI Inflation (YoY)",
      value: cpi.value.value,
      note: "% year-over-year — above ~3% is elevated vs. the Fed's ~2% target",
      unit: "percent-signed",
      ...classifyFred(cpi.value.value > 3.0, "⚠ elevated"),
    });
  } else {
    console.error("FRED CPIAUCSL failed:", cpi.reason);
  }
  if (claims.status === "fulfilled") {
    const claimsUp = claims.value.value > claims.value.prior;
    results.push({
      label: "Initial Jobless Claims",
      value: claims.value.value,
      note: `weekly new unemployment claims, ${claimsUp ? "rising" : "falling"} vs. prior week`,
      unit: "count-k",
      ...classifyFred(claims.value.value > 275000, "⚠ elevated"),
    });
  } else {
    console.error("FRED ICSA failed:", claims.reason);
  }
  if (indpro.status === "fulfilled") {
    results.push({
      label: "Industrial Production (YoY)",
      value: indpro.value.value,
      note: "% year-over-year — manufacturing/production health proxy",
      unit: "percent-signed",
      ...classifyFred(indpro.value.value < 0, "⚠ contracting"),
    });
  } else {
    console.error("FRED INDPRO failed:", indpro.reason);
  }
```

Leave the `Promise.allSettled([...])` block above it and the final `return results.length > 0 ? results : undefined;` line untouched.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd functions && npm test && npm run build`
Expected: full suite PASS (this also re-confirms the pre-existing FRED isolation tests — "keeps the other FRED indicators when only one call fails" and "leaves fred undefined when every FRED call fails" — still pass unchanged, since Task 1 doesn't touch the `Promise.allSettled` isolation logic), clean build.

- [ ] **Step 6: Commit**

```bash
git add functions/src/lib/types.ts functions/src/lib/pipeline.ts functions/test/pipeline.test.ts
git commit -m "feat: compute normal/warning status per FRED indicator"
```

---

### Task 2: Frontend — formatted values and colored status captions

**Files:**
- Modify: `frontend/src/digest.js:134-137`
- Modify: `frontend/index.html:116` (the `.idx-card .if` rule)

**Interfaces:**
- Consumes: `FredIndicator` shape from Task 1 (`{ label, value, note, unit, status, statusLabel }`), delivered through the existing `digests/{date}` Firestore snapshot listener.

No automated test harness exists for the frontend in this repo — this task ends with manual verification instead of automated tests, matching established precedent.

- [ ] **Step 1: Add the value formatter**

In `frontend/src/digest.js`, add this function immediately after the existing `viewChip` function (before `renderScreenBlock`):

```javascript
function formatFredValue(cd) {
  if (cd.unit === "count-k") {
    return `${Math.round(cd.value / 1000)}K`;
  }
  const sign = cd.unit === "percent-signed" && cd.value >= 0 ? "+" : "";
  return `${sign}${cd.value.toFixed(1)}%`;
}
```

- [ ] **Step 2: Update the FRED strip rendering**

In `frontend/src/digest.js`, find:

```javascript
  if (docData.fred) {
    document.getElementById("fredStrip").innerHTML = docData.fred
      .map((cd) => `<div class="idx-card"><div class="in">${esc(cd.label)}</div><div class="ip">${cd.value.toFixed(2)}</div><div class="if">${esc(cd.note)}</div></div>`)
      .join("");
  }
```

and replace it with:

```javascript
  if (docData.fred) {
    document.getElementById("fredStrip").innerHTML = docData.fred
      .map((cd) => `<div class="idx-card"><div class="in">${esc(cd.label)}</div><div class="ip">${formatFredValue(cd)}</div><div class="if ${cd.status}">${esc(cd.statusLabel)}</div></div>`)
      .join("");
  }
```

- [ ] **Step 3: Update the status caption CSS**

In `frontend/index.html`, find:

```css
  .idx-card .if{font-size:11px;color:var(--faint);margin-top:5px;line-height:1.4}
```

and replace it with:

```css
  .idx-card .if{font-family:"JetBrains Mono";font-size:11px;font-weight:600;margin-top:5px;letter-spacing:.01em}
  .idx-card .if.normal{color:var(--pos)}
  .idx-card .if.warning{color:var(--neg)}
```

(This matches the existing `.idx-card .ic.up`/`.idx-card .ic.down` color-by-state pattern already used for the Major Indices/Volatility cards in this same file.)

- [ ] **Step 4: Syntax-check and self-review**

Run: `node --check frontend/src/digest.js`
Expected: no output (clean).

Re-read the diff: confirm `formatFredValue` handles all three units (`percent-signed`, `percent`, `count-k`), confirm the `.if` class now always gets a second class (`normal` or `warning`) so the CSS selector matches, and confirm no other code path references the old `.if` single-class styling.

- [ ] **Step 5: Manual verification**

This repo has no frontend test harness, so verify by hand once this is deployed:

1. Open the live dashboard, signed in as owner.
2. Confirm each FRED card shows a formatted value with the correct unit (`%` with sign for spread/CPI/industrial production, plain `%` for unemployment/fed funds, `K` for jobless claims) and a colored status caption ("normal range" in the positive/green color, or the "⚠ ..." warning text in the negative/red color when a threshold is crossed).
3. Confirm all 6 cards are now visually uniform height (short captions should make the grid line up cleanly, resolving the earlier jagged-height issue).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/digest.js frontend/index.html
git commit -m "feat: show formatted values and colored status captions on FRED cards"
```

---

## Post-plan

Once both tasks are committed, deploy: `npx --yes firebase-tools deploy --only functions --project signal-stock-digest-67e26` for the backend change (Task 1), and push to `origin/main` for the frontend change (Task 2) — Netlify auto-deploys on push. Then do the manual verification from Task 2 Step 5 against the live site.
