# Signal Cloud Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the client-only Signal prototype (`~/Downloads/stock-video-dashboard_23.html`) into a hosted app that runs the scrape → extract → rank → fundamentals → summaries pipeline automatically once a day, stores results in Firestore, and is viewable/triggerable from a phone via a Netlify-hosted frontend.

**Architecture:** Firebase Cloud Functions (2nd gen) run the pipeline on a Cloud Scheduler trigger or on-demand via a callable function, writing one digest document per day to Firestore. A static frontend on Netlify reads Firestore directly via the Firebase client SDK, gated by Firebase Auth. Per `docs/superpowers/specs/2026-07-23-cloud-pipeline-design.md`.

**Tech Stack:** Firebase Functions v2 (Node 20, TypeScript), Firestore, Firebase Auth (Google sign-in), Firebase Secret Manager, Vitest for backend tests, `@firebase/rules-unit-testing` for security-rules tests, vanilla JS/HTML/CSS frontend (no framework — porting the existing prototype), Netlify for static hosting.

## Global Constraints

- Single-user app: every write path and every Firestore read is gated to one allow-listed Firebase Auth UID (the owner's Google account). No per-user data model.
- API keys (Apify token, Anthropic key, Finnhub key, FRED key) live only in Firebase Secret Manager, injected into Cloud Functions at runtime. They must never appear in any file under `frontend/` or be sent to the browser.
- The Cloudflare Worker FRED proxy (`fred-proxy.matthew-emrani1.workers.dev`) is retired — FRED is called directly from the Cloud Function using `https://api.stlouisfed.org/fred/series/observations`.
- `runNow` must refuse to start if `digests/{today}.status === "running"` (overlap guard — avoids double-billing Apify).
- A failed run writes `status: "error"` to `digests/{today}` and must never overwrite or touch any other day's document.
- Model, prompts, and formulas (ticker-extraction prompt, screen formula, summary prompts, Apify poll logic) are ported verbatim from `~/Downloads/stock-video-dashboard_23.html` — no rewriting of working logic, only relocation.

## File Structure

```
stock-video-dashboard/
├── firebase.json                  # Functions + Firestore + emulator config
├── .firebaserc                    # Project alias (filled in Task 10)
├── firestore.rules
├── firestore.indexes.json
├── functions/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── lib/
│   │   │   ├── ranking.ts         # pure: aggregate extractions -> ranked tickers
│   │   │   ├── screen.ts          # pure: Pass/Watch/Caution formula
│   │   │   ├── apify.ts           # runActor: start+poll+fetch dataset items
│   │   │   ├── claude.ts          # extractTickers, videoWrap, marketRecap
│   │   │   ├── finnhub.ts         # quote, fundamentals, profile, analyst, news
│   │   │   ├── fred.ts            # fredLatest, fredYoY, fredWithPrior
│   │   │   ├── pipeline.ts        # orchestrates one full digest run
│   │   │   └── types.ts           # shared interfaces (RankedTicker, DigestDoc, etc.)
│   │   └── index.ts               # exports dailyDigestRun, runNow, liveQuote
│   └── test/
│       ├── ranking.test.ts
│       ├── screen.test.ts
│       ├── apify.test.ts
│       ├── claude.test.ts
│       ├── finnhub.test.ts
│       ├── fred.test.ts
│       ├── pipeline.test.ts
│       └── index.test.ts
├── firestore-tests/
│   └── rules.test.ts              # @firebase/rules-unit-testing
├── frontend/
│   ├── index.html                 # digest view + settings modal (ported markup/CSS)
│   ├── netlify.toml
│   └── src/
│       ├── firebase-init.js       # Firebase app/auth/firestore init
│       ├── auth.js                # login gate
│       ├── digest.js              # Firestore listener, render(), run-now wiring
│       └── settings.js            # config/settings read/write
└── README.md
```

Shared types (`functions/src/lib/types.ts`) are defined once in Task 3 and imported everywhere else — later tasks must not redeclare `RankedTicker`, `Fundamentals`, `Analyst`, `ScreenResult`, or `DigestDoc`.

**Deliberate refinement vs. the spec's schema wording:** the spec describes `fundamentals` as a separate top-level map keyed by symbol. This plan instead nests `fundamentals` / `profile` / `analyst` directly on each `RankedTicker` entry, matching the prototype's existing `render()` function exactly (see `~/Downloads/stock-video-dashboard_23.html:848-874`). This is functionally equivalent — per-ticker fundamentals data, or absent when unavailable — and means the frontend port in Task 12 can reuse the prototype's rendering code almost unchanged instead of restructuring it around a lookup map.

---

### Task 1: Project scaffolding

**Files:**
- Create: `firebase.json`
- Create: `.firebaserc`
- Create: `functions/package.json`
- Create: `functions/tsconfig.json`
- Create: `functions/vitest.config.ts`
- Create: `functions/src/index.ts` (placeholder)
- Test: `functions/test/smoke.test.ts`

**Interfaces:**
- Produces: a working `npm test` in `functions/` and a `firebase.json` that points at `functions/` and the (not-yet-created) `frontend/` directory for hosting.

- [ ] **Step 1: Create `functions/package.json`**

```json
{
  "name": "signal-functions",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": "20" },
  "main": "lib/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "firebase-admin": "^12.6.0",
    "firebase-functions": "^6.0.1"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: Create `functions/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "lib",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `functions/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create placeholder `functions/src/index.ts`**

```ts
export const placeholder = true;
```

- [ ] **Step 5: Write the smoke test**

```ts
// functions/test/smoke.test.ts
import { describe, it, expect } from "vitest";
import { placeholder } from "../src/index.js";

describe("scaffolding", () => {
  it("loads the functions package", () => {
    expect(placeholder).toBe(true);
  });
});
```

- [ ] **Step 6: Install dependencies and run the test**

```bash
cd functions && npm install
```

```bash
npm test
```
Expected: 1 test file, 1 test, PASS.

- [ ] **Step 7: Create `firebase.json`**

```json
{
  "functions": [{ "source": "functions", "codebase": "default", "predeploy": ["npm --prefix \"$RESOURCE_DIR\" run build"] }],
  "firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" },
  "emulators": {
    "functions": { "port": 5001 },
    "firestore": { "port": 8080 },
    "auth": { "port": 9099 },
    "ui": { "enabled": true }
  }
}
```

- [ ] **Step 8: Create `.firebaserc` placeholder**

```json
{
  "projects": { "default": "REPLACE_WITH_FIREBASE_PROJECT_ID" }
}
```

- [ ] **Step 9: Create empty `firestore.indexes.json`**

```json
{ "indexes": [], "fieldOverrides": [] }
```

- [ ] **Step 10: Commit**

```bash
cd ~/stock-video-dashboard
git add firebase.json .firebaserc firestore.indexes.json functions/package.json functions/tsconfig.json functions/vitest.config.ts functions/src/index.ts functions/test/smoke.test.ts
git commit -m "chore: scaffold Firebase Functions project"
```

---

### Task 2: Firestore security rules

**Files:**
- Create: `firestore.rules`
- Create: `firestore-tests/rules.test.ts`
- Create: `firestore-tests/package.json`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `digests/{date}` and `config/settings` collections readable/writable only by UID `OWNER_UID` (a placeholder constant, replaced with the real UID at deploy time in Task 10).

- [ ] **Step 1: Write the failing rules test**

```json
// firestore-tests/package.json
{
  "name": "signal-firestore-tests",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run" },
  "devDependencies": {
    "@firebase/rules-unit-testing": "^3.0.4",
    "vitest": "^2.1.4"
  }
}
```

```ts
// firestore-tests/rules.test.ts
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";

const OWNER_UID = "owner-test-uid";
let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "signal-rules-test",
    firestore: { rules: readFileSync("../firestore.rules", "utf8") },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe("digests/{date}", () => {
  it("owner can read", async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(db.doc("digests/2026-07-23").get());
  });

  it("stranger cannot read", async () => {
    const db = testEnv.authenticatedContext("someone-else").firestore();
    await assertFails(db.doc("digests/2026-07-23").get());
  });

  it("unauthenticated cannot read", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.doc("digests/2026-07-23").get());
  });

  it("stranger cannot write", async () => {
    const db = testEnv.authenticatedContext("someone-else").firestore();
    await assertFails(db.doc("digests/2026-07-23").set({ status: "running" }));
  });
});

describe("config/settings", () => {
  it("owner can read and write", async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(db.doc("config/settings").set({ trackedHandles: ["a"] }));
    await assertSucceeds(db.doc("config/settings").get());
  });

  it("stranger cannot write", async () => {
    const db = testEnv.authenticatedContext("someone-else").firestore();
    await assertFails(db.doc("config/settings").set({ trackedHandles: ["a"] }));
  });
});
```

- [ ] **Step 2: Install deps and run to verify it fails**

```bash
cd firestore-tests && npm install && npm test
```
Expected: FAIL — `firestore.rules` doesn't exist yet, or rules default-deny everything (test file read fails / assertSucceeds calls fail).

- [ ] **Step 3: Write `firestore.rules`**

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner() {
      return request.auth != null && request.auth.uid == "owner-test-uid";
    }

    match /digests/{date} {
      allow read, write: if isOwner();
    }

    match /config/settings {
      allow read, write: if isOwner();
    }
  }
}
```

Note: `"owner-test-uid"` is a placeholder matching the test file. Task 10 replaces it with the real Firebase Auth UID after the owner signs in once.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd firestore-tests && npm test
```
Expected: 5 tests, all PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/stock-video-dashboard
git add firestore.rules firestore-tests/
git commit -m "feat: add Firestore security rules, owner-only access"
```

---

### Task 3: Pure logic modules — ranking and screening

**Files:**
- Create: `functions/src/lib/types.ts`
- Create: `functions/src/lib/ranking.ts`
- Create: `functions/src/lib/screen.ts`
- Test: `functions/test/ranking.test.ts`
- Test: `functions/test/screen.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `Take`, `RankedTicker`, `Fundamentals`, `Profile`, `Analyst`, `ScreenCheck`, `ScreenResult`, `Extraction`, `DigestDoc`
  - `ranking.ts`: `rankMentions(extractions: (Extraction & { who: string })[]): RankedTicker[]`
  - `screen.ts`: `screenStock(f: Fundamentals | null, an: Analyst | null): ScreenResult | null`

- [ ] **Step 1: Write `functions/src/lib/types.ts`**

```ts
export interface Extraction {
  ticker: string;
  company: string;
  view: "buy" | "sell" | "hold" | "mention";
  buyLevel: string;
  sellLevel: string;
  recap: string;
  quote: string;
}

export interface Take {
  who: string;
  view: "buy" | "sell" | "hold" | "mention";
  buy: string;
  sell: string;
  recap: string;
  quote: string;
}

export interface Fundamentals {
  pe: number | null;
  marketCap: number | null;
  week52High: number | null;
  week52Low: number | null;
  beta: number | null;
}

export interface Profile {
  industry: string | null;
  name: string | null;
  weburl: string | null;
}

export interface Analyst {
  buy: number;
  hold: number;
  sell: number;
  period: string;
}

export interface RankedTicker {
  sym: string;
  company: string;
  takes: Take[];
  count: number;
  price?: number;
  fundamentals?: Fundamentals;
  profile?: Profile;
  analyst?: Analyst;
}

export interface ScreenCheck {
  label: string;
  pass: boolean;
  detail: string;
}

export interface ScreenResult {
  verdict: "Pass" | "Watch" | "Caution";
  checks: ScreenCheck[];
  passed: number;
  total: number;
}

export interface DigestDoc {
  status: "running" | "complete" | "error";
  errorMessage?: string;
  dateLabel: string;
  rankedTickers: RankedTicker[];
  screen: Record<string, ScreenResult>;
  videoWrap?: string;
  marketRecap?: string;
  marketHealth?: string;
  fred?: { label: string; value: number; note: string }[];
  skippedReelCount: number;
  startedAt: number;
  completedAt?: number;
}
```

Note: there's no `indexSnapshot`/`macroSnapshot` field on `DigestDoc`. Unlike the ranked-ticker digest, the index/macro proxy strip (SPY/DIA/QQQ/IWM, VIXY/TLT/HYG/UUP) isn't part of a day's stored digest — it's live, polled on demand by the frontend via the `liveQuote` function (Task 9, wired into the frontend in Task 12), matching how the prototype's `loadIndices()` already worked independently of `render()`.

- [ ] **Step 2: Write the failing ranking test**

```ts
// functions/test/ranking.test.ts
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
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd functions && npx vitest run test/ranking.test.ts
```
Expected: FAIL — `../src/lib/ranking.js` has no exported member `rankMentions`.

- [ ] **Step 4: Write `functions/src/lib/ranking.ts`**

Ported from `~/Downloads/stock-video-dashboard_23.html:599-617`.

```ts
import type { Extraction, RankedTicker, Take } from "./types.js";

export function rankMentions(extractions: (Extraction & { who: string })[]): RankedTicker[] {
  const mentions: Record<string, { company: string; takes: Take[] }> = {};

  for (const it of extractions) {
    const sym = (it.ticker || "").toUpperCase().replace(/[^A-Z.]/g, "");
    if (!sym) continue;
    if (!mentions[sym]) mentions[sym] = { company: it.company || "", takes: [] };
    if (!mentions[sym].company && it.company) mentions[sym].company = it.company;
    mentions[sym].takes.push({
      who: it.who,
      view: ((it.view || "mention") as string).toLowerCase() as Take["view"],
      buy: it.buyLevel || "",
      sell: it.sellLevel || "",
      recap: it.recap || "",
      quote: it.quote || "",
    });
  }

  return Object.entries(mentions)
    .map(([sym, d]) => ({ sym, ...d, count: d.takes.length }))
    .sort((a, b) => b.count - a.count);
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd functions && npx vitest run test/ranking.test.ts
```
Expected: 2 tests, PASS.

- [ ] **Step 6: Write the failing screen test**

```ts
// functions/test/screen.test.ts
import { describe, it, expect } from "vitest";
import { screenStock } from "../src/lib/screen.js";

describe("screenStock", () => {
  it("returns null when there's no fundamentals or analyst data", () => {
    expect(screenStock(null, null)).toBeNull();
  });

  it("returns Pass when all checks pass", () => {
    const result = screenStock(
      { pe: 20, marketCap: 1000, week52High: 200, week52Low: 100, beta: 1.2 },
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
    const result = screenStock({ pe: 90, marketCap: 1000, week52High: 200, week52Low: 100, beta: 3.5 }, { buy: 1, hold: 5, sell: 5, period: "2026-07" });
    expect(result?.verdict).toBe("Caution");
    expect(result?.passed).toBe(0);
  });

  it("skips the analyst check when there's no analyst data", () => {
    const result = screenStock({ pe: 20, marketCap: 1000, week52High: 200, week52Low: 100, beta: 1.2 }, null);
    expect(result?.total).toBe(2);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

```bash
cd functions && npx vitest run test/screen.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 8: Write `functions/src/lib/screen.ts`**

Ported from `~/Downloads/stock-video-dashboard_23.html:805-828`.

```ts
import type { Analyst, Fundamentals, ScreenCheck, ScreenResult } from "./types.js";

export function screenStock(f: Fundamentals | null, an: Analyst | null): ScreenResult | null {
  if (!f && !an) return null;
  const checks: ScreenCheck[] = [];

  if (f && f.pe != null) {
    checks.push({ label: "Valuation (P/E 0–25)", pass: f.pe > 0 && f.pe <= 25, detail: f.pe.toFixed(1) });
  }
  if (an) {
    const total = an.buy + an.hold + an.sell;
    if (total > 0) {
      checks.push({
        label: "Analyst consensus",
        pass: an.buy > an.hold + an.sell,
        detail: `${an.buy} buy / ${an.hold} hold / ${an.sell} sell`,
      });
    }
  }
  if (f && f.beta != null) {
    checks.push({ label: "Stability (beta < 2.5)", pass: f.beta < 2.5, detail: f.beta.toFixed(2) });
  }
  if (checks.length === 0) return null;

  const passed = checks.filter((c) => c.pass).length;
  let verdict: ScreenResult["verdict"];
  if (passed >= Math.ceil(checks.length * 0.66)) verdict = "Pass";
  else if (passed >= Math.ceil(checks.length * 0.33)) verdict = "Watch";
  else verdict = "Caution";

  return { verdict, checks, passed, total: checks.length };
}
```

- [ ] **Step 9: Run both test files to verify they pass**

```bash
cd functions && npx vitest run test/ranking.test.ts test/screen.test.ts
```
Expected: 6 tests total, PASS.

- [ ] **Step 10: Commit**

```bash
cd ~/stock-video-dashboard
git add functions/src/lib/types.ts functions/src/lib/ranking.ts functions/src/lib/screen.ts functions/test/ranking.test.ts functions/test/screen.test.ts
git commit -m "feat: port ranking and screening logic as pure, tested modules"
```

---

### Task 4: Apify client

**Files:**
- Create: `functions/src/lib/apify.ts`
- Test: `functions/test/apify.test.ts`

**Interfaces:**
- Consumes: nothing (no shared types needed — returns `unknown[]`, caller shapes it).
- Produces: `runActor(actorId: string, token: string, input: object, onTick?: (status: string, sec: number) => void): Promise<unknown[]>`

- [ ] **Step 1: Write the failing test**

```ts
// functions/test/apify.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runActor } from "../src/lib/apify.js";

describe("runActor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts the run, polls until SUCCEEDED, and returns dataset items", async () => {
    const fetchMock = vi
      .fn()
      // start run
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "run1", defaultDatasetId: "ds1", status: "RUNNING" } }) })
      // first poll: still running
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "run1", defaultDatasetId: "ds1", status: "RUNNING" } }) })
      // second poll: succeeded
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "run1", defaultDatasetId: "ds1", status: "SUCCEEDED" } }) })
      // dataset items
      .mockResolvedValueOnce({ ok: true, json: async () => [{ text: "hello" }] });
    vi.stubGlobal("fetch", fetchMock);

    const ticks: string[] = [];
    const resultPromise = runActor("apify/instagram-reel-scraper", "tok", { username: ["a"] }, (status) => ticks.push(status));

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result).toEqual([{ text: "hello" }]);
    expect(ticks).toEqual(["RUNNING", "SUCCEEDED"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws when the start request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: { message: "bad token" } }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runActor("actor", "bad-tok", {})).rejects.toThrow("bad token");
  });

  it("throws when the run status is not SUCCEEDED", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "run1", defaultDatasetId: "ds1", status: "FAILED" } }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runActor("actor", "tok", {})).rejects.toThrow("run FAILED");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd functions && npx vitest run test/apify.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `functions/src/lib/apify.ts`**

Ported from `~/Downloads/stock-video-dashboard_23.html:480-506`.

```ts
interface ApifyRunData {
  id: string;
  defaultDatasetId: string;
  status: string;
}

export async function runActor(
  actorId: string,
  token: string,
  input: object,
  onTick?: (status: string, sec: number) => void
): Promise<unknown[]> {
  const startRes = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!startRes.ok) {
    let msg = String(startRes.status);
    try {
      const errBody = await startRes.json();
      msg += " — " + (errBody?.error?.message || JSON.stringify(errBody));
    } catch {
      // ignore body parse failure, keep status-only message
    }
    throw new Error(msg);
  }
  const run = ((await startRes.json()) as { data: ApifyRunData }).data;
  const runId = run.id;
  let datasetId = run.defaultDatasetId;
  let status = run.status;
  const started = Date.now();
  const MAX = 25 * 60 * 1000;
  const terminal = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"];

  while (!terminal.includes(status)) {
    if (Date.now() - started > MAX) throw new Error("still running after 25 min — try fewer videos");
    await new Promise((r) => setTimeout(r, 5000));
    const pr = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    if (pr.ok) {
      const pd = ((await pr.json()) as { data: ApifyRunData }).data;
      status = pd.status;
      datasetId = pd.defaultDatasetId || datasetId;
    }
    if (onTick) onTick(status, Math.round((Date.now() - started) / 1000));
  }
  if (status !== "SUCCEEDED") throw new Error("run " + status);

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&format=json&clean=true`);
  if (!itemsRes.ok) throw new Error("couldn't read results (" + itemsRes.status + ")");
  const data = await itemsRes.json();
  return Array.isArray(data) ? data : [];
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd functions && npx vitest run test/apify.test.ts
```
Expected: 3 tests, PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/stock-video-dashboard
git add functions/src/lib/apify.ts functions/test/apify.test.ts
git commit -m "feat: port Apify start-and-poll client"
```

---

### Task 5: Claude client (extraction + summaries)

**Files:**
- Create: `functions/src/lib/claude.ts`
- Test: `functions/test/claude.test.ts`

**Interfaces:**
- Consumes: `Extraction`, `RankedTicker` from `./types.js`
- Produces:
  - `extractTickers(text: string, cfg: { apiKey: string; model: string }): Promise<Extraction[]>`
  - `videoWrap(ranked: RankedTicker[], dateLabel: string, cfg: { apiKey: string; model: string }): Promise<string>`
  - `marketRecap(headlines: { headline: string; summary?: string }[], dateLabel: string, cfg: { apiKey: string; model: string }): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
// functions/test/claude.test.ts
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd functions && npx vitest run test/claude.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `functions/src/lib/claude.ts`**

Ported from `~/Downloads/stock-video-dashboard_23.html:770-796` (extraction), `:690-729` (video wrap), `:731-768` (market recap).

```ts
import type { Extraction, RankedTicker } from "./types.js";

interface ClaudeConfig {
  apiKey: string;
  model: string;
}

async function callClaude(system: string, userContent: string, maxTokens: number, cfg: ClaudeConfig): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }] }),
  });
  if (!res.ok) throw new Error("AI " + res.status);
  const data = (await res.json()) as { content?: { type: string; text: string }[] };
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

export async function extractTickers(text: string, cfg: ClaudeConfig): Promise<Extraction[]> {
  const sys = `You extract stock mentions from a transcript of a stock video. Return ONLY a JSON array, no prose, no code fences. Each element: {"ticker","company","view","buyLevel","sellLevel","recap","quote"}.
- ticker: the stock symbol (uppercase). If only a company name is given, infer the ticker. Skip if unsure.
- view: one of "buy","sell","hold","mention" — what the SPEAKER expressed.
- buyLevel/sellLevel: any price the speaker named (e.g. "$150"), else "".
- recap: one sentence, <=25 words, on what the speaker said about this stock.
- quote: a short verbatim phrase (<15 words) from the transcript, else "".
If no stocks are discussed, return [].`;

  let out = await callClaude(sys, text.slice(0, 6000), 1024, cfg);
  out = out.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = out.indexOf("[");
  const end = out.lastIndexOf("]");
  if (start >= 0 && end > start) out = out.slice(start, end + 1);
  try {
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function videoWrap(ranked: RankedTicker[], dateLabel: string, cfg: ClaudeConfig): Promise<string> {
  const digest = ranked
    .slice(0, 12)
    .map((s) => {
      const views = s.takes.map((t) => `${t.who}: ${t.view}${t.recap ? " — " + t.recap : ""}`).join(" | ");
      return `${s.sym} (${s.count} mention${s.count > 1 ? "s" : ""}): ${views}`;
    })
    .join("\n");

  const sys = `You are writing a short daily wrap-up for a personal stock-video research dashboard. Based on the stock mentions and speaker takes below, write:
1. A 2-3 sentence summary of what stood out today across the videos (themes, hot tickers, notable disagreements).
2. A 1-2 sentence read on sentiment heading into the next trading day, based ONLY on what the video speakers said (not your own market opinion).
Keep it factual and attribute views to speakers where relevant. Do not give buy/sell advice of your own. Plain text, no headers, no markdown, 2 short paragraphs max.`;

  return (await callClaude(sys, `Date: ${dateLabel}\n\n${digest}`, 400, cfg)).trim();
}

export async function marketRecap(headlines: { headline: string; summary?: string }[], dateLabel: string, cfg: ClaudeConfig): Promise<string> {
  const top = headlines
    .slice(0, 15)
    .map((h) => `- ${h.headline}${h.summary ? ": " + h.summary.slice(0, 140) : ""}`)
    .join("\n");

  const sys = `You are writing a short daily market recap for a personal dashboard, based on general financial news headlines (not the person's own video sources). Write:
1. A 2-3 sentence summary of the day's key market news and themes.
2. A 1-2 sentence read on sentiment heading into the next trading day, based on this news.
Plain text, no headers, no markdown, 2 short paragraphs max. Do not give buy/sell advice.`;

  return (await callClaude(sys, `Date: ${dateLabel}\n\nHeadlines:\n${top}`, 400, cfg)).trim();
}
```

Note: the browser-only header `anthropic-dangerous-direct-browser-access` from the prototype is dropped — it's not needed (or valid) for a server-side call.

- [ ] **Step 4: Run to verify it passes**

```bash
cd functions && npx vitest run test/claude.test.ts
```
Expected: 5 tests, PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/stock-video-dashboard
git add functions/src/lib/claude.ts functions/test/claude.test.ts
git commit -m "feat: port Claude extraction and summary generation"
```

---

### Task 6: Finnhub client

**Files:**
- Create: `functions/src/lib/finnhub.ts`
- Test: `functions/test/finnhub.test.ts`

**Interfaces:**
- Consumes: `Fundamentals`, `Profile`, `Analyst` from `./types.js`
- Produces:
  - `getQuote(sym: string, key: string): Promise<{ price: number; changePct: number } | null>`
  - `getFundamentals(sym: string, key: string): Promise<Fundamentals | null>`
  - `getProfile(sym: string, key: string): Promise<Profile | null>`
  - `getAnalystConsensus(sym: string, key: string): Promise<Analyst | null>`
  - `getGeneralNews(key: string): Promise<{ headline: string; summary?: string }[]>`

- [ ] **Step 1: Write the failing test**

```ts
// functions/test/finnhub.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { getQuote, getFundamentals, getProfile, getAnalystConsensus, getGeneralNews } from "../src/lib/finnhub.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getQuote", () => {
  it("returns price and change percent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ c: 150.5, dp: 1.2 }) }));
    expect(await getQuote("AAPL", "k")).toEqual({ price: 150.5, changePct: 1.2 });
  });

  it("returns null when there's no current price", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) }));
    expect(await getQuote("AAPL", "k")).toBeNull();
  });
});

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

describe("getProfile", () => {
  it("maps the profile response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ name: "Apple Inc", finnhubIndustry: "Technology", weburl: "https://apple.com" }) }));
    expect(await getProfile("AAPL", "k")).toEqual({ industry: "Technology", name: "Apple Inc", weburl: "https://apple.com" });
  });
});

describe("getAnalystConsensus", () => {
  it("sums strongBuy+buy and strongSell+sell from the latest period", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [{ strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0, period: "2026-07-01" }] }));
    expect(await getAnalystConsensus("AAPL", "k")).toEqual({ buy: 15, hold: 3, sell: 1, period: "2026-07-01" });
  });

  it("returns null when the response is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] }));
    expect(await getAnalystConsensus("AAPL", "k")).toBeNull();
  });
});

describe("getGeneralNews", () => {
  it("returns the headline list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [{ headline: "Fed holds rates", summary: "..." }] }));
    expect(await getGeneralNews("k")).toEqual([{ headline: "Fed holds rates", summary: "..." }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd functions && npx vitest run test/finnhub.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `functions/src/lib/finnhub.ts`**

Ported from `~/Downloads/stock-video-dashboard_23.html:628-672` (quote/metric/profile/recommendation) and `:737` (news).

```ts
import type { Analyst, Fundamentals, Profile } from "./types.js";

const BASE = "https://finnhub.io/api/v1";

export async function getQuote(sym: string, key: string): Promise<{ price: number; changePct: number } | null> {
  const r = await fetch(`${BASE}/quote?symbol=${sym}&token=${encodeURIComponent(key)}`);
  const q = (await r.json()) as { c?: number; dp?: number };
  if (!q || !q.c) return null;
  return { price: q.c, changePct: q.dp ?? 0 };
}

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

export async function getProfile(sym: string, key: string): Promise<Profile | null> {
  const r = await fetch(`${BASE}/stock/profile2?symbol=${sym}&token=${encodeURIComponent(key)}`);
  const pd = (await r.json()) as { name?: string; finnhubIndustry?: string; weburl?: string };
  if (!pd || !pd.name) return null;
  return { industry: pd.finnhubIndustry || null, name: pd.name || null, weburl: pd.weburl || null };
}

export async function getAnalystConsensus(sym: string, key: string): Promise<Analyst | null> {
  const r = await fetch(`${BASE}/stock/recommendation?symbol=${sym}&token=${encodeURIComponent(key)}`);
  const ad = (await r.json()) as { strongBuy?: number; buy?: number; hold?: number; sell?: number; strongSell?: number; period?: string }[];
  if (!Array.isArray(ad) || ad.length === 0) return null;
  const latest = ad[0];
  return {
    buy: (latest.strongBuy || 0) + (latest.buy || 0),
    hold: latest.hold || 0,
    sell: (latest.sell || 0) + (latest.strongSell || 0),
    period: latest.period || "",
  };
}

export async function getGeneralNews(key: string): Promise<{ headline: string; summary?: string }[]> {
  const r = await fetch(`${BASE}/news?category=general&token=${encodeURIComponent(key)}`);
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd functions && npx vitest run test/finnhub.test.ts
```
Expected: 7 tests, PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/stock-video-dashboard
git add functions/src/lib/finnhub.ts functions/test/finnhub.test.ts
git commit -m "feat: port Finnhub quote, fundamentals, profile, analyst, news client"
```

---

### Task 7: FRED client (direct API, no Cloudflare Worker)

**Files:**
- Create: `functions/src/lib/fred.ts`
- Test: `functions/test/fred.test.ts`

**Interfaces:**
- Produces:
  - `fredLatest(seriesId: string, apiKey: string): Promise<{ value: number; date: string }>`
  - `fredYoY(seriesId: string, apiKey: string): Promise<{ value: number; date: string }>`
  - `fredWithPrior(seriesId: string, apiKey: string): Promise<{ value: number; prior: number; date: string }>`

- [ ] **Step 1: Write the failing test**

```ts
// functions/test/fred.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fredLatest, fredYoY, fredWithPrior } from "../src/lib/fred.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fredLatest", () => {
  it("returns the most recent non-missing observation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ observations: [{ value: ".", date: "2026-07-22" }, { value: "4.31", date: "2026-07-21" }] }),
      })
    );
    expect(await fredLatest("FEDFUNDS", "key")).toEqual({ value: 4.31, date: "2026-07-21" });
  });

  it("hits the FRED API directly with sort_order=desc, not the Cloudflare Worker", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ observations: [{ value: "1", date: "2026-07-21" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    await fredLatest("FEDFUNDS", "key");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("api.stlouisfed.org");
    expect(url).toContain("sort_order=desc");
    expect(url).not.toContain("fred-proxy");
  });
});

describe("fredYoY", () => {
  it("computes year-over-year percent change from the latest and year-ago values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          observations: [
            { value: "110", date: "2026-07-01" },
            { value: "100", date: "2025-07-01" },
          ],
        }),
      })
    );
    const result = await fredYoY("CPIAUCSL", "key");
    expect(result.value).toBeCloseTo(10, 5);
  });
});

describe("fredWithPrior", () => {
  it("returns the latest value alongside the prior observation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ observations: [{ value: "220000", date: "2026-07-19" }, { value: "215000", date: "2026-07-12" }] }) })
    );
    expect(await fredWithPrior("ICSA", "key")).toEqual({ value: 220000, prior: 215000, date: "2026-07-19" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd functions && npx vitest run test/fred.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `functions/src/lib/fred.ts`**

Ported from `~/Downloads/stock-video-dashboard_23.html:932-982`, with the Cloudflare Worker URL replaced by a direct call to the FRED API (server-side calls aren't subject to the browser CORS restriction the Worker existed to work around).

```ts
interface FredObservation {
  value: number;
  date: string;
}

function fredUrl(seriesId: string, apiKey: string, start: string, end: string): string {
  return `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&observation_start=${start}&observation_end=${end}`;
}

interface RawObservation {
  value: string;
  date: string;
}

async function fetchObservations(seriesId: string, apiKey: string, start: string, end: string): Promise<RawObservation[]> {
  const r = await fetch(fredUrl(seriesId, apiKey, start, end));
  if (!r.ok) throw new Error("FRED " + r.status);
  const d = (await r.json()) as { observations?: RawObservation[] };
  return d.observations || [];
}

export async function fredLatest(seriesId: string, apiKey: string): Promise<FredObservation> {
  const end = new Date().toISOString().slice(0, 10);
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 1);
  const start = startDate.toISOString().slice(0, 10);

  const obs = await fetchObservations(seriesId, apiKey, start, end);
  for (const o of obs) {
    if (o.value !== "." && o.value != null) return { value: parseFloat(o.value), date: o.date };
  }
  throw new Error("no data");
}

export async function fredYoY(seriesId: string, apiKey: string): Promise<FredObservation> {
  const end = new Date().toISOString().slice(0, 10);
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 2);
  const start = startDate.toISOString().slice(0, 10);

  const obs = (await fetchObservations(seriesId, apiKey, start, end)).filter((o) => o.value !== "." && o.value != null);
  if (obs.length === 0) throw new Error("no data");
  const latest = obs[0];
  const latestDate = new Date(latest.date);
  const targetDate = new Date(latestDate);
  targetDate.setFullYear(targetDate.getFullYear() - 1);
  let prior: RawObservation | null = null;
  for (const o of obs) {
    if (new Date(o.date) <= targetDate) {
      prior = o;
      break;
    }
  }
  if (!prior) throw new Error("no year-ago data");
  const yoy = ((parseFloat(latest.value) - parseFloat(prior.value)) / parseFloat(prior.value)) * 100;
  return { value: yoy, date: latest.date };
}

export async function fredWithPrior(seriesId: string, apiKey: string): Promise<{ value: number; prior: number; date: string }> {
  const end = new Date().toISOString().slice(0, 10);
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - 3);
  const start = startDate.toISOString().slice(0, 10);

  const obs = (await fetchObservations(seriesId, apiKey, start, end)).filter((o) => o.value !== "." && o.value != null);
  if (obs.length < 2) throw new Error("no data");
  return { value: parseFloat(obs[0].value), prior: parseFloat(obs[1].value), date: obs[0].date };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd functions && npx vitest run test/fred.test.ts
```
Expected: 4 tests, PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/stock-video-dashboard
git add functions/src/lib/fred.ts functions/test/fred.test.ts
git commit -m "feat: port FRED client, calling FRED API directly instead of via Cloudflare Worker"
```

---

### Task 8: Pipeline orchestrator

**Files:**
- Create: `functions/src/lib/pipeline.ts`
- Test: `functions/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `RankedTicker`, `DigestDoc`, `Extraction` from `./types.js`; function signatures from Tasks 4–7 (`runActor`, `extractTickers`, `videoWrap`, `marketRecap`, `getQuote`, `getFundamentals`, `getProfile`, `getAnalystConsensus`, `getGeneralNews`, `fredLatest`, `fredYoY`, `fredWithPrior`).
- Produces: `runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<DigestDoc>` — pure orchestration, no Firestore access (the caller in Task 9 handles reading config and writing the result).

This is the task that implements the spec's Data Flow and Error Handling sections end to end, so its dependencies are injected (not imported directly) to make every failure branch testable without real network calls.

- [ ] **Step 1: Write the failing test**

```ts
// functions/test/pipeline.test.ts
import { describe, it, expect, vi } from "vitest";
import { runPipeline, type PipelineDeps, type PipelineInput } from "../src/lib/pipeline.js";

function baseDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    runActor: vi.fn().mockResolvedValue([{ transcript: "AAPL is a solid buy", url: "https://ig.com/p/1", pageName: "trader1", timestamp: input.targetDate.getTime() }]),
    extractTickers: vi.fn().mockResolvedValue([{ ticker: "AAPL", company: "Apple", view: "buy", buyLevel: "", sellLevel: "", recap: "bullish", quote: "" }]),
    videoWrap: vi.fn().mockResolvedValue("wrap text"),
    marketRecap: vi.fn().mockResolvedValue("recap text"),
    getQuote: vi.fn().mockResolvedValue({ price: 200, changePct: 1 }),
    getFundamentals: vi.fn().mockResolvedValue({ pe: 20, marketCap: 3000, week52High: 220, week52Low: 150, beta: 1.1 }),
    getProfile: vi.fn().mockResolvedValue({ industry: "Tech", name: "Apple", weburl: "https://apple.com" }),
    getAnalystConsensus: vi.fn().mockResolvedValue({ buy: 10, hold: 2, sell: 1, period: "2026-07" }),
    getGeneralNews: vi.fn().mockResolvedValue([{ headline: "Fed holds" }]),
    fredLatest: vi.fn().mockResolvedValue({ value: 4.3, date: "2026-07-20" }),
    fredYoY: vi.fn().mockResolvedValue({ value: 2.9, date: "2026-07-20" }),
    fredWithPrior: vi.fn().mockResolvedValue({ value: 220000, prior: 215000, date: "2026-07-20" }),
    ...overrides,
  };
}

const input: PipelineInput = {
  dateLabel: "Jul 23, 2026",
  targetDate: new Date("2026-07-23T12:00:00"),
  trackedHandles: ["trader1"],
  topN: 15,
  secrets: { apifyToken: "at", actorId: "apify/instagram-reel-scraper", aiKey: "ak", model: "claude-haiku-4-5-20251001", priceKey: "pk", fredKey: "fk" },
};

describe("runPipeline", () => {
  it("produces a complete digest on the happy path", async () => {
    const doc = await runPipeline(input, baseDeps());
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers).toHaveLength(1);
    expect(doc.rankedTickers[0].sym).toBe("AAPL");
    expect(doc.rankedTickers[0].fundamentals).toEqual({ pe: 20, marketCap: 3000, week52High: 220, week52Low: 150, beta: 1.1 });
    expect(doc.screen.AAPL.verdict).toBe("Pass");
    expect(doc.videoWrap).toBe("wrap text");
    expect(doc.marketRecap).toBe("recap text");
    expect(doc.skippedReelCount).toBe(0);
  });

  it("sets status error and does not throw when Apify fails", async () => {
    const deps = baseDeps({ runActor: vi.fn().mockRejectedValue(new Error("Apify 401 — bad token")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("error");
    expect(doc.errorMessage).toContain("bad token");
    expect(doc.rankedTickers).toEqual([]);
  });

  it("skips a reel whose extraction fails and keeps going", async () => {
    const deps = baseDeps({
      runActor: vi.fn().mockResolvedValue([
        { transcript: "AAPL is a solid buy", url: "https://ig.com/p/1", pageName: "trader1", timestamp: input.targetDate.getTime() },
        { transcript: "NVDA looks strong", url: "https://ig.com/p/2", pageName: "trader1", timestamp: input.targetDate.getTime() },
      ]),
      extractTickers: vi
        .fn()
        .mockResolvedValueOnce([{ ticker: "AAPL", company: "Apple", view: "buy", buyLevel: "", sellLevel: "", recap: "", quote: "" }])
        .mockRejectedValueOnce(new Error("AI 500")),
    });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.skippedReelCount).toBe(1);
    expect(doc.rankedTickers.map((r) => r.sym)).toEqual(["AAPL"]);
  });

  it("marks a ticker's fundamentals unavailable when Finnhub fails for it, without failing the run", async () => {
    const deps = baseDeps({ getFundamentals: vi.fn().mockRejectedValue(new Error("Finnhub 429")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers[0].fundamentals).toBeUndefined();
  });

  it("leaves fred undefined when FRED calls fail, without failing the run", async () => {
    const deps = baseDeps({ fredLatest: vi.fn().mockRejectedValue(new Error("FRED 500")) });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.fred).toBeUndefined();
  });

  it("filters out reels not posted on input.targetDate", async () => {
    const onDate = new Date(input.targetDate);
    const offDate = new Date(input.targetDate);
    offDate.setDate(offDate.getDate() - 3);
    const deps = baseDeps({
      runActor: vi.fn().mockResolvedValue([
        { transcript: "AAPL is a solid buy", url: "https://ig.com/p/1", pageName: "trader1", timestamp: onDate.getTime() },
        { transcript: "MSFT is a solid buy", url: "https://ig.com/p/2", pageName: "trader1", timestamp: offDate.getTime() },
      ]),
      extractTickers: vi.fn().mockImplementation(async (text: string) => {
        if (text.includes("AAPL")) {
          return [{ ticker: "AAPL", company: "Apple", view: "buy", buyLevel: "", sellLevel: "", recap: "", quote: "" }];
        }
        return [{ ticker: "MSFT", company: "Microsoft", view: "buy", buyLevel: "", sellLevel: "", recap: "", quote: "" }];
      }),
    });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers.map((r) => r.sym)).toEqual(["AAPL"]);
  });

  it("treats a non-array runActor response as an empty reel list instead of throwing", async () => {
    const deps = baseDeps({
      runActor: vi.fn().mockResolvedValue(null) as unknown as PipelineDeps["runActor"],
    });
    const doc = await runPipeline(input, deps);
    expect(doc.status).toBe("complete");
    expect(doc.rankedTickers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd functions && npx vitest run test/pipeline.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `functions/src/lib/pipeline.ts`**

Orchestration ported from `~/Downloads/stock-video-dashboard_23.html:509-687` (`run()`), restructured as pure async logic with injected I/O and the error-handling rules from the spec.

```ts
import type { DigestDoc, Extraction, RankedTicker } from "./types.js";
import { rankMentions } from "./ranking.js";
import { screenStock } from "./screen.js";

export interface PipelineInput {
  dateLabel: string;
  targetDate: Date;
  trackedHandles: string[];
  topN: number;
  secrets: { apifyToken: string; actorId: string; aiKey: string; model: string; priceKey: string; fredKey: string };
}

export interface PipelineDeps {
  runActor: (actorId: string, token: string, input: object, onTick?: (status: string, sec: number) => void) => Promise<unknown[]>;
  extractTickers: (text: string, cfg: { apiKey: string; model: string }) => Promise<Extraction[]>;
  videoWrap: (ranked: RankedTicker[], dateLabel: string, cfg: { apiKey: string; model: string }) => Promise<string>;
  marketRecap: (headlines: { headline: string; summary?: string }[], dateLabel: string, cfg: { apiKey: string; model: string }) => Promise<string>;
  getQuote: (sym: string, key: string) => Promise<{ price: number; changePct: number } | null>;
  getFundamentals: (sym: string, key: string) => Promise<RankedTicker["fundamentals"] | null>;
  getProfile: (sym: string, key: string) => Promise<RankedTicker["profile"] | null>;
  getAnalystConsensus: (sym: string, key: string) => Promise<RankedTicker["analyst"] | null>;
  getGeneralNews: (key: string) => Promise<{ headline: string; summary?: string }[]>;
  fredLatest: (seriesId: string, apiKey: string) => Promise<{ value: number; date: string }>;
  fredYoY: (seriesId: string, apiKey: string) => Promise<{ value: number; date: string }>;
  fredWithPrior: (seriesId: string, apiKey: string) => Promise<{ value: number; prior: number; date: string }>;
}

interface ReelLike {
  transcript?: string;
  text?: string;
  url?: string;
  pageName?: string;
  timestamp?: number;
  // Apify's raw scrape output isn't strictly typed, and the post-date candidate
  // fields below vary by actor/source — accept arbitrary extra fields.
  [key: string]: unknown;
}

function getText(v: ReelLike): string {
  return v.transcript || v.text || "";
}

function getAuthor(v: ReelLike): string {
  return v.pageName || "Unknown account";
}

const TIMESTAMP_KEYS = [
  "timestamp",
  "creationTime",
  "createdTime",
  "taken_at",
  "takenAt",
  "date_posted",
  "publishedAt",
  "published_at",
  "date",
  "time",
  "created_at",
];

// prototype: ~/Downloads/stock-video-dashboard_23.html:448-453
function pick(obj: ReelLike | null | undefined, keys: string[]): unknown {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

// prototype: ~/Downloads/stock-video-dashboard_23.html:454-462
function getTimestamp(v: ReelLike): number | null {
  const t = pick(v, TIMESTAMP_KEYS);
  if (t === null) return null;
  if (typeof t === "number") return t < 2e10 ? t * 1000 : t;
  const n = Number(t);
  if (!isNaN(n) && String(t).trim() !== "") return n < 2e10 ? n * 1000 : n;
  const d = Date.parse(String(t));
  return isNaN(d) ? null : d;
}

// prototype: ~/Downloads/stock-video-dashboard_23.html:463-467
function isOnDate(ms: number | null, target: Date): boolean {
  if (ms === null) return true; // no timestamp field found -> don't exclude it, matches source's permissive fallback
  const d = new Date(ms);
  return d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth() && d.getDate() === target.getDate();
}

async function loadFred(secrets: PipelineInput["secrets"], deps: PipelineDeps): Promise<DigestDoc["fred"] | undefined> {
  try {
    const [spread, unrate, fedfunds, cpi, claims, indpro] = await Promise.all([
      deps.fredLatest("T10Y2Y", secrets.fredKey),
      deps.fredLatest("UNRATE", secrets.fredKey),
      deps.fredLatest("FEDFUNDS", secrets.fredKey),
      deps.fredYoY("CPIAUCSL", secrets.fredKey),
      deps.fredWithPrior("ICSA", secrets.fredKey),
      deps.fredYoY("INDPRO", secrets.fredKey),
    ]);
    const claimsUp = claims.value > claims.prior;
    return [
      { label: "10Y-2Y Yield Spread", value: spread.value, note: "negative = inverted curve, historically a recession warning" },
      { label: "Unemployment Rate", value: unrate.value, note: "%" },
      { label: "Fed Funds Rate", value: fedfunds.value, note: "% — the Fed's benchmark interest rate" },
      { label: "CPI Inflation", value: cpi.value, note: "% year-over-year — above ~3% is elevated vs. the Fed's ~2% target" },
      { label: "Initial Jobless Claims", value: claims.value, note: `weekly new unemployment claims, ${claimsUp ? "rising" : "falling"} vs. prior week` },
      { label: "Industrial Production", value: indpro.value, note: "% year-over-year — manufacturing/production health proxy" },
    ];
  } catch {
    return undefined;
  }
}

export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<DigestDoc> {
  const startedAt = Date.now();
  const { secrets } = input;
  const claudeCfg = { apiKey: secrets.aiKey, model: secrets.model };

  let reels: ReelLike[];
  try {
    const urlList = input.trackedHandles.map((u) => u.trim().replace(/^@/, "")).filter(Boolean);
    const rawReels = await deps.runActor(secrets.actorId, secrets.apifyToken, { username: urlList, resultsLimit: 5, includeTranscript: true });
    reels = Array.isArray(rawReels) ? (rawReels as ReelLike[]) : [];
    reels = reels.filter((v) => isOnDate(getTimestamp(v), input.targetDate));
  } catch (e) {
    return {
      status: "error",
      errorMessage: e instanceof Error ? e.message : String(e),
      dateLabel: input.dateLabel,
      rankedTickers: [],
      screen: {},
      skippedReelCount: 0,
      startedAt,
      completedAt: Date.now(),
    };
  }

  const extractions: (Extraction & { who: string })[] = [];
  let skippedReelCount = 0;
  for (const reel of reels) {
    const text = getText(reel);
    const who = getAuthor(reel);
    if (!text || text.length < 15) {
      skippedReelCount++;
      continue;
    }
    try {
      const extracted = await deps.extractTickers(text, claudeCfg);
      for (const e of extracted) extractions.push({ ...e, who });
    } catch {
      skippedReelCount++;
    }
  }

  const ranked = rankMentions(extractions).slice(0, input.topN);

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
  }

  const screen: DigestDoc["screen"] = {};
  for (const ticker of ranked) {
    const result = screenStock(ticker.fundamentals ?? null, ticker.analyst ?? null);
    if (result) screen[ticker.sym] = result;
  }

  let videoWrap: string | undefined;
  try {
    videoWrap = await deps.videoWrap(ranked, input.dateLabel, claudeCfg);
  } catch {
    videoWrap = undefined;
  }

  let marketRecap: string | undefined;
  try {
    const headlines = await deps.getGeneralNews(secrets.priceKey);
    marketRecap = await deps.marketRecap(headlines, input.dateLabel, claudeCfg);
  } catch {
    marketRecap = undefined;
  }

  const fred = await loadFred(secrets, deps);

  return {
    status: "complete",
    dateLabel: input.dateLabel,
    rankedTickers: ranked,
    screen,
    videoWrap,
    marketRecap,
    fred,
    skippedReelCount,
    startedAt,
    completedAt: Date.now(),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd functions && npx vitest run test/pipeline.test.ts
```
Expected: 7 tests, PASS.

- [ ] **Step 5: Run the full backend test suite**

```bash
cd functions && npm test
```
Expected: all test files PASS (ranking, screen, apify, claude, finnhub, fred, pipeline, smoke).

- [ ] **Step 6: Commit**

```bash
cd ~/stock-video-dashboard
git add functions/src/lib/pipeline.ts functions/test/pipeline.test.ts
git commit -m "feat: add pipeline orchestrator with per-step error isolation"
```

---

### Task 9: Cloud Functions entrypoints

**Files:**
- Modify: `functions/src/index.ts` (replace placeholder)
- Test: `functions/test/index.test.ts`

**Interfaces:**
- Consumes: `runPipeline`, `PipelineDeps` from `./lib/pipeline.js`; real implementations from `./lib/apify.js`, `./lib/claude.js`, `./lib/finnhub.js`, `./lib/fred.js`.
- Produces: exported `dailyDigestRun`, `runNow`, `liveQuote` Cloud Functions. `runNow` and `liveQuote` are the only two invoked directly by the frontend (Tasks 12–13).

- [ ] **Step 1: Write the failing test for the overlap guard and auth check**

These are the two pieces of real logic in this file worth testing in isolation (the rest is Firebase Functions wiring, verified in Task 10's deploy smoke test). Test them as plain functions extracted from the handlers.

```ts
// functions/test/index.test.ts
import { describe, it, expect } from "vitest";
import { assertOwner, guardOverlap } from "../src/index.js";

const OWNER_UID = "owner-test-uid";

describe("assertOwner", () => {
  it("passes for the owner UID", () => {
    expect(() => assertOwner({ uid: OWNER_UID })).not.toThrow();
  });

  it("throws for any other UID", () => {
    expect(() => assertOwner({ uid: "someone-else" })).toThrow("permission-denied");
  });

  it("throws when there's no auth context", () => {
    expect(() => assertOwner(undefined)).toThrow("permission-denied");
  });
});

describe("guardOverlap", () => {
  it("does nothing when there's no existing doc", () => {
    expect(() => guardOverlap(undefined)).not.toThrow();
  });

  it("does nothing when the existing doc is complete", () => {
    expect(() => guardOverlap({ status: "complete" })).not.toThrow();
  });

  it("throws when a run is already in progress", () => {
    expect(() => guardOverlap({ status: "running" })).toThrow("already-exists");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd functions && npx vitest run test/index.test.ts
```
Expected: FAIL — module not found / no such exports.

- [ ] **Step 3: Write `functions/src/index.ts`**

```ts
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { runPipeline, type PipelineDeps } from "./lib/pipeline.js";
import { runActor } from "./lib/apify.js";
import { extractTickers, videoWrap, marketRecap } from "./lib/claude.js";
import { getQuote, getFundamentals, getProfile, getAnalystConsensus, getGeneralNews } from "./lib/finnhub.js";
import { fredLatest, fredYoY, fredWithPrior } from "./lib/fred.js";
import type { DigestDoc } from "./lib/types.js";

initializeApp();

// DigestDoc has several optional fields (fred, errorMessage, videoWrap,
// marketRecap) that are legitimately `undefined` on any given run — e.g.
// when FRED calls fail. The Admin SDK rejects `undefined` in a document by
// default (throws, doesn't just drop the field), which previously crashed
// docRef.set() *after* a fully successful pipeline run, leaving the digest
// doc stuck at status:"running" forever. This must be set once, before any
// other Firestore call on this instance.
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

const OWNER_UID = "owner-test-uid"; // replaced with the real Firebase Auth UID in Task 10

const apifyToken = defineSecret("APIFY_TOKEN");
const anthropicKey = defineSecret("ANTHROPIC_KEY");
const finnhubKey = defineSecret("FINNHUB_KEY");
const fredKey = defineSecret("FRED_KEY");

export function assertOwner(auth: { uid: string } | undefined): void {
  if (!auth || auth.uid !== OWNER_UID) {
    throw new HttpsError("permission-denied", "not authorized");
  }
}

export function guardOverlap(existing: { status: string } | undefined): void {
  if (existing?.status === "running") {
    throw new HttpsError("already-exists", "already-exists: a run is already in progress for this date");
  }
}

// Post-launch addition: lets runNow target a past date (the frontend passes
// the date picker's current value), not just "today". dailyDigestRun still
// always calls executeDigestRun() with no argument, defaulting to today.
export function resolveTargetDate(dateKey: string | undefined): { targetDate: Date; dateKey: string } {
  if (dateKey === undefined) {
    const now = new Date();
    return { targetDate: now, dateKey: now.toISOString().slice(0, 10) };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new HttpsError("invalid-argument", "invalid-argument: dateKey must be in YYYY-MM-DD format");
  }
  // Anchor at noon local time, not midnight, so the calendar day doesn't
  // shift backward for timezones behind UTC (matches the prototype's
  // original date-picker handling).
  return { targetDate: new Date(`${dateKey}T12:00:00`), dateKey };
}

const deps: PipelineDeps = {
  runActor,
  extractTickers,
  videoWrap,
  marketRecap,
  getQuote,
  getFundamentals,
  getProfile,
  getAnalystConsensus,
  getGeneralNews,
  fredLatest,
  fredYoY,
  fredWithPrior,
};

async function executeDigestRun(requestedDateKey?: string): Promise<void> {
  const { targetDate, dateKey } = resolveTargetDate(requestedDateKey);
  const dateLabel = targetDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const docRef = db.collection("digests").doc(dateKey);

  const existing = await docRef.get();
  guardOverlap(existing.data() as { status: string } | undefined);

  const settingsSnap = await db.collection("config").doc("settings").get();
  const settings = settingsSnap.data() as { trackedHandles?: string[]; topN?: number } | undefined;

  const startedAt = Date.now();
  await docRef.set({ status: "running", dateLabel, startedAt } satisfies Partial<DigestDoc>);

  // runPipeline is designed to never throw (every network-facing step is
  // self-contained and degrades to an "error" DigestDoc or an undefined
  // field instead). This catch is a second line of defense only: if it
  // ever did throw, this doc would otherwise be stuck at "running" forever
  // and guardOverlap would permanently block all future runs.
  let result: DigestDoc;
  try {
    result = await runPipeline(
      {
        dateLabel,
        targetDate,
        trackedHandles: settings?.trackedHandles ?? [],
        topN: settings?.topN ?? 15,
        secrets: {
          apifyToken: apifyToken.value(),
          actorId: "apify/instagram-reel-scraper",
          aiKey: anthropicKey.value(),
          model: "claude-haiku-4-5-20251001",
          priceKey: finnhubKey.value(),
          fredKey: fredKey.value(),
        },
      },
      deps
    );
  } catch (e) {
    result = {
      status: "error",
      errorMessage: e instanceof Error ? e.message : String(e),
      dateLabel,
      rankedTickers: [],
      screen: {},
      skippedReelCount: 0,
      startedAt,
      completedAt: Date.now(),
    };
  }

  await docRef.set(result);
}

export const dailyDigestRun = onSchedule(
  { schedule: "every day 07:00", timeZone: "America/New_York", secrets: [apifyToken, anthropicKey, finnhubKey, fredKey], timeoutSeconds: 1800, memory: "512MiB" },
  async () => {
    await executeDigestRun();
  }
);

export const runNow = onCall({ secrets: [apifyToken, anthropicKey, finnhubKey, fredKey], timeoutSeconds: 1800, memory: "512MiB" }, async (request) => {
  assertOwner(request.auth);
  const requestedDateKey = typeof request.data?.dateKey === "string" ? request.data.dateKey : undefined;
  await executeDigestRun(requestedDateKey);
  return { ok: true };
});

export const liveQuote = onRequest({ secrets: [finnhubKey] }, async (request, response) => {
  // Browsers preflight cross-origin requests carrying an Authorization header
  // with an OPTIONS request that never includes that header. CORS itself
  // isn't the security boundary here (the ID-token check below is), so it's
  // safe to answer preflights from any origin.
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.set("Access-Control-Allow-Headers", "Authorization");
  if (request.method === "OPTIONS") {
    response.status(204).send("");
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    response.status(401).json({ error: "missing or malformed Authorization header" });
    return;
  }
  const idToken = authHeader.slice("Bearer ".length);

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(idToken);
  } catch {
    response.status(401).json({ error: "invalid token" });
    return;
  }

  if (decoded.uid !== OWNER_UID) {
    response.status(403).json({ error: "not authorized" });
    return;
  }

  const sym = String(request.query.sym || "");
  if (!sym) {
    response.status(400).json({ error: "missing sym" });
    return;
  }
  const quote = await getQuote(sym, finnhubKey.value());
  response.json(quote ?? { price: null, changePct: null });
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd functions && npx vitest run test/index.test.ts
```
Expected: 6 tests, PASS.

- [ ] **Step 5: Build and run the full suite**

```bash
cd functions && npm run build && npm test
```
Expected: TypeScript build succeeds, all tests PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/stock-video-dashboard
git add functions/src/index.ts functions/test/index.test.ts
git commit -m "feat: add dailyDigestRun, runNow, liveQuote Cloud Functions"
```

---

### Task 10: Deploy the Firebase backend

This task requires the owner's own Firebase account (interactive login) — it cannot be run unattended. Follow these steps yourself; ping back if any command's output doesn't match.

**Files:**
- Modify: `.firebaserc` (real project ID)
- Modify: `firestore.rules` (real owner UID)
- Modify: `functions/src/index.ts` (real owner UID, line with `const OWNER_UID = "owner-test-uid"`)
- Modify: `firestore-tests/rules.test.ts` (real owner UID, so the rules tests still match reality)
- Modify: `functions/test/index.test.ts` (real owner UID — its own local `OWNER_UID` constant, used to test `assertOwner`/`guardOverlap`, must match `functions/src/index.ts`'s real value or those tests fail)

- [ ] **Step 1: Install the Firebase CLI if needed and log in**

```bash
npm install -g firebase-tools
firebase login
```

- [ ] **Step 2: Create the Firebase project**

```bash
firebase projects:create signal-stock-digest
```
Note the returned project ID (it may differ from `signal-stock-digest` if taken).

- [ ] **Step 3: Update `.firebaserc` with the real project ID**

```json
{ "projects": { "default": "YOUR_PROJECT_ID" } }
```

- [ ] **Step 4: Enable Firestore and Google sign-in**

```bash
firebase firestore:databases:create '(default)' --project YOUR_PROJECT_ID --location nam5
```

Then in the Firebase Console (console.firebase.google.com → your project → Authentication → Sign-in method), enable the **Google** provider.

- [ ] **Step 5: Sign in once via a throwaway page to learn your UID**

Deploy hosting with a temporary login-only page first (Task 11 will replace it), or simplest: open the Firebase Console → Authentication → Users after signing in once through any Firebase Auth quickstart, and copy your UID. Record it — call it `<OWNER_UID>`.

- [ ] **Step 6: Replace the placeholder UID everywhere**

```bash
cd ~/stock-video-dashboard
grep -rl "owner-test-uid" firestore.rules functions/src/index.ts firestore-tests/rules.test.ts functions/test/index.test.ts
```

Edit each matched file, replacing `"owner-test-uid"` with `"<OWNER_UID>"`.

- [ ] **Step 7: Re-run the rules and function tests with the real UID**

```bash
cd firestore-tests && npm test
cd ../functions && npm test
```
Expected: all PASS (same counts as before — only the UID literal changed).

- [ ] **Step 8: Set the secrets**

```bash
firebase functions:secrets:set APIFY_TOKEN --project YOUR_PROJECT_ID
firebase functions:secrets:set ANTHROPIC_KEY --project YOUR_PROJECT_ID
firebase functions:secrets:set FINNHUB_KEY --project YOUR_PROJECT_ID
firebase functions:secrets:set FRED_KEY --project YOUR_PROJECT_ID
```
Each prompts for the value interactively — paste the corresponding key from the current prototype's Settings modal (or generate fresh ones).

- [ ] **Step 9: Deploy Firestore rules and Cloud Functions**

```bash
firebase deploy --only firestore:rules,functions --project YOUR_PROJECT_ID
```
Expected: deploy succeeds, output lists `dailyDigestRun`, `runNow`, `liveQuote` as deployed functions.

- [ ] **Step 10: Seed initial config**

In the Firebase Console → Firestore → create document `config/settings` with:
```json
{
  "trackedHandles": ["kaycapitals", "tradeliquid", "mrinvestr", "overkilltrading", "darstrades", "trade.momentum", "xavierwagnerfinance", "ocious_finance", "jtcapitall", "stockbuster_", "mordy_invests", "ericnomics", "stoxmee_official", "mrmtrades"],
  "scheduleTime": "07:00",
  "topN": 15
}
```
(Ported from `DEFAULTS.urls` in `~/Downloads/stock-video-dashboard_23.html:367-380`.)

- [ ] **Step 11: Commit the UID and project-ID changes**

```bash
cd ~/stock-video-dashboard
git add .firebaserc firestore.rules functions/src/index.ts firestore-tests/rules.test.ts functions/test/index.test.ts frontend/src/firebase-init.js
git commit -m "chore: wire up real Firebase project ID, owner UID, and web app config"
```

---

### Task 11: Frontend — Firebase init and login gate

**Files:**
- Create: `frontend/src/firebase-init.js`
- Create: `frontend/src/auth.js`
- Create: `frontend/index.html` (shell only — digest/settings markup added in Tasks 12–13)

**Interfaces:**
- Produces: `frontend/src/firebase-init.js` exports `app`, `auth`, `db`, `functions` (initialized Firebase SDK instances). `frontend/src/auth.js` exports `requireOwner(onSignedIn: (user) => void): void`.

This task has no automated test — it's SDK wiring and a login redirect, verified manually against the live Firebase project from Task 10 (there is no useful pure-logic unit to isolate here, unlike Tasks 3–9).

- [ ] **Step 1: Write `frontend/src/firebase-init.js`**

Replace `YOUR_PROJECT_ID` and the rest of the config block with the values from Firebase Console → Project settings → General → Your apps → Web app (create a web app there first if none exists).

```js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

// liveQuote is a plain HTTP function (onRequest), not callable, so the
// frontend fetches it directly rather than through the Functions SDK.
export const FUNCTIONS_BASE_URL = "https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net";
```

- [ ] **Step 2: Write `frontend/src/auth.js`**

```js
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { auth } from "./firebase-init.js";

export function requireOwner(onSignedIn) {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      onSignedIn(user);
    } else {
      document.getElementById("loginGate").style.display = "block";
    }
  });
}

export function signIn() {
  signInWithPopup(auth, new GoogleAuthProvider());
}

export function signOutUser() {
  signOut(auth);
}
```

- [ ] **Step 3: Write `frontend/index.html` shell**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Signal — Daily Stock Video Digest</title>
</head>
<body>
  <div id="loginGate" style="display:none">
    <button id="signInBtn">Sign in with Google</button>
  </div>
  <div id="app" style="display:none">
    <!-- digest view (Task 12) and settings view (Task 13) go here -->
  </div>
  <script type="module">
    import { requireOwner, signIn } from "./src/auth.js";
    document.getElementById("signInBtn").addEventListener("click", signIn);
    requireOwner((user) => {
      document.getElementById("loginGate").style.display = "none";
      document.getElementById("app").style.display = "block";
    });
  </script>
</body>
</html>
```

- [ ] **Step 4: Manual verification**

Serve the frontend locally and confirm the login gate appears, Google sign-in works, and after signing in with the owner account the `#app` div becomes visible:

```bash
cd ~/stock-video-dashboard/frontend && npx serve .
```
Open the printed localhost URL, click "Sign in with Google," complete the flow, confirm `#loginGate` hides and `#app` shows.

- [ ] **Step 5: Commit**

```bash
cd ~/stock-video-dashboard
git add frontend/src/firebase-init.js frontend/src/auth.js frontend/index.html
git commit -m "feat: add Firebase Auth login gate to frontend"
```

---

### Task 12: Frontend — digest view

**Files:**
- Modify: `frontend/index.html` (add digest markup + CSS, ported from the prototype)
- Create: `frontend/src/digest.js`

**Interfaces:**
- Consumes: `db`, `functions`, `FUNCTIONS_BASE_URL` from `./firebase-init.js`.
- Produces: `watchDate(dateKey): () => void` (Firestore listener + render), `runNow(): Promise<void>`, `startLiveStrips(): void` (60s-polled index/macro strip via `liveQuote`). Renders a `digests/{date}` document into the page; wires the date picker and "Run now" button.

No automated test — DOM rendering ported near-verbatim from a working prototype. Verified manually against the live Firebase project.

- [ ] **Step 1: Port the CSS and card markup structure from the prototype**

Copy the `<style>` block and the results-container markup from `~/Downloads/stock-video-dashboard_23.html` (search for `.card`, `.chip`, `.fund-row`, `.analyst-row`, `.screen-row`, `.idx-card`, `.ds-head`/`.ds-body` classes) into `frontend/index.html`'s `<head>` and into the `#app` div (date picker, `#results`, `#dailySummary`, `#newsSummary`, `#indicesStrip`, `#macroStrip`, `#fredStrip`, `#lastRun`, `#runBtn`). This is a direct copy — the visual design doesn't change.

- [ ] **Step 2: Write `frontend/src/digest.js`**

`render()`'s markup, `viewChip()`, and `esc()` are ported unchanged from `~/Downloads/stock-video-dashboard_23.html:800-899`. There is no client-side `screenStock()` — the Pass/Watch/Caution verdict is computed once, server-side, in Task 3's `screen.ts`, and the frontend just reads the precomputed result straight off `docData.screen[sym]`. The only new code here is the Firestore listener and the "Run now" wiring, replacing the old `run()` function's direct API calls.

```js
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { db, functions, auth, FUNCTIONS_BASE_URL } from "./firebase-init.js";

const INDEX_PROXIES = [
  { sym: "SPY", label: "S&P 500" },
  { sym: "DIA", label: "Dow Jones" },
  { sym: "QQQ", label: "Nasdaq 100" },
  { sym: "IWM", label: "Russell 2000" },
];
const MACRO_PROXIES = [
  { sym: "VIXY", label: "Volatility (VIX proxy)" },
  { sym: "TLT", label: "20Y+ Treasuries" },
  { sym: "HYG", label: "High-Yield Credit" },
  { sym: "UUP", label: "US Dollar Index" },
];

function esc(s) {
  return (s || "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}
function viewChip(v) {
  const cls = { buy: "buy", sell: "sell", hold: "hold" }[v] || "count";
  const label = { buy: "Buy", sell: "Sell", hold: "Hold" }[v] || "Mention";
  return `<span class="chip ${cls}">${label}</span>`;
}

function renderScreenBlock(screenResult) {
  if (!screenResult) return "";
  return `
    <div class="screen-row">
      <span class="ak">Basic screen — ${screenResult.passed}/${screenResult.total} checks passed</span>
      <div class="screen-checks">
        ${screenResult.checks.map((c) => `<span class="scheck ${c.pass ? "pass" : "fail"}">${c.pass ? "✓" : "✗"} ${esc(c.label)} <span class="scheck-detail">(${esc(c.detail)})</span></span>`).join("")}
      </div>
    </div>`;
}

function renderDigest(docData) {
  const results = document.getElementById("results");
  const lastRun = document.getElementById("lastRun");

  if (docData.status === "error") {
    results.innerHTML = `<div class="note"><b>Today's run failed.</b><br>${esc(docData.errorMessage || "unknown error")}</div>`;
    return;
  }
  if (docData.status === "running") {
    results.innerHTML = `<div class="note">Run in progress…</div>`;
    return;
  }

  const ranked = docData.rankedTickers || [];
  const total = ranked.reduce((a, b) => a + b.count, 0);
  let html = `<div class="section-label"><h2>Most discussed — ${esc(docData.dateLabel)}</h2><span>${ranked.length} stocks · ${total} mentions</span></div>`;

  ranked.forEach((s, i) => {
    const counts = {};
    s.takes.forEach((t) => (counts[t.view] = (counts[t.view] || 0) + 1));
    const dom = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "mention";
    const takesHtml = s.takes
      .map(
        (t) => `
      <div class="take">
        <div class="take-top">
          <span class="who">${esc(t.who)}</span>
          ${viewChip(t.view)}
          ${t.buy || t.sell ? `<span class="lvl">${t.buy ? `buy <b>${esc(t.buy)}</b>` : ""}${t.buy && t.sell ? " · " : ""}${t.sell ? `sell <b>${esc(t.sell)}</b>` : ""}</span>` : ""}
        </div>
        ${t.recap ? `<div class="recap">${esc(t.recap)}</div>` : ""}
        ${t.quote ? `<div class="quote">"${esc(t.quote)}"</div>` : ""}
      </div>`
      )
      .join("");

    const f = s.fundamentals;
    const p = s.profile;
    const an = s.analyst;
    const screenResult = docData.screen?.[s.sym];
    const screenChip = screenResult ? `<span class="chip screen-${screenResult.verdict.toLowerCase()}">${screenResult.verdict}</span>` : "";
    const fundHtml = f
      ? `
      <div class="fund-row">
        ${f.pe != null ? `<div class="fund"><span class="fk">P/E</span><span class="fv">${f.pe.toFixed(1)}</span></div>` : ""}
        ${f.marketCap != null ? `<div class="fund"><span class="fk">Mkt Cap</span><span class="fv">$${(f.marketCap / 1000).toFixed(1)}B</span></div>` : ""}
        ${f.week52Low != null && f.week52High != null ? `<div class="fund"><span class="fk">52wk Range</span><span class="fv">$${f.week52Low.toFixed(0)}–$${f.week52High.toFixed(0)}</span></div>` : ""}
        ${f.beta != null ? `<div class="fund"><span class="fk">Beta</span><span class="fv">${f.beta.toFixed(2)}</span></div>` : ""}
        ${p && p.industry ? `<div class="fund"><span class="fk">Industry</span><span class="fv">${esc(p.industry)}</span></div>` : ""}
      </div>`
      : `<div class="fund-unavailable">Fundamentals unavailable</div>`;
    const analystHtml = an
      ? `
      <div class="analyst-row">
        <span class="ak">Wall St. analysts (${esc(an.period)})</span>
        <span class="ac buy">${an.buy} buy</span>
        <span class="ac hold">${an.hold} hold</span>
        <span class="ac sell">${an.sell} sell</span>
      </div>`
      : "";

    html += `
      <div class="card ${i === 0 ? "featured" : ""}" id="c${i}">
        <div class="card-head" onclick="document.getElementById('c${i}').classList.toggle('open')">
          <div class="rank">${i + 1}</div>
          <div class="tick"><div class="sym">${esc(s.sym)}</div><div class="co">${esc(s.company || "")}</div></div>
          <div class="headmid"><span class="chip count">${s.count} video${s.count > 1 ? "s" : ""}</span>${viewChip(dom)}${screenChip}</div>
          <div class="price"><div class="p">${s.price ? "$" + s.price.toFixed(2) : "—"}</div><div class="l">${s.price ? "current" : "no price"}</div></div>
          <div class="chev">▾</div>
        </div>
        <div class="card-body"><div class="inner">${renderScreenBlock(screenResult)}${fundHtml}${analystHtml}${takesHtml}</div></div>
      </div>`;
  });
  results.innerHTML = html;
  if (ranked[0]) document.getElementById("c0").classList.add("open");

  if (docData.videoWrap) {
    document.getElementById("dailySummary").innerHTML = `<div class="ds-head">Video Wrap — ${esc(docData.dateLabel)}</div><div class="ds-body"><p>${esc(docData.videoWrap).replace(/\n\n/g, "</p><p>")}</p></div>`;
  }
  if (docData.marketRecap) {
    document.getElementById("newsSummary").innerHTML = `<div class="ds-head">Market Recap (news) — ${esc(docData.dateLabel)}</div><div class="ds-body"><p>${esc(docData.marketRecap).replace(/\n\n/g, "</p><p>")}</p></div>`;
  }
  if (docData.fred) {
    document.getElementById("fredStrip").innerHTML = docData.fred
      .map((cd) => `<div class="idx-card"><div class="in">${esc(cd.label)}</div><div class="ip">${cd.value.toFixed(2)}</div></div>`)
      .join("");
  }

  const now = new Date();
  lastRun.textContent = now.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function watchDate(dateKey) {
  return onSnapshot(doc(db, "digests", dateKey), (snap) => {
    if (snap.exists()) renderDigest(snap.data());
    else document.getElementById("results").innerHTML = `<div class="note"><b>No digest for ${esc(dateKey)}.</b></div>`;
  });
}

async function loadStrip(list, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) return; // not signed in yet (login gate hasn't resolved) — skip this cycle
  const cards = await Promise.all(
    list.map(async (idx) => {
      try {
        const r = await fetch(`${FUNCTIONS_BASE_URL}/liveQuote?sym=${idx.sym}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const q = await r.json();
        if (q.price == null) return "";
        const up = q.changePct >= 0;
        return `<div class="idx-card">
          <div class="in">${esc(idx.label)}<span class="tick">${esc(idx.sym)}</span></div>
          <div class="ip">$${q.price.toFixed(2)}</div>
          <div class="ic ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(q.changePct).toFixed(2)}%</div>
        </div>`;
      } catch {
        return "";
      }
    })
  );
  el.innerHTML = cards.join("");
}

export function startLiveStrips() {
  const load = () => {
    loadStrip(INDEX_PROXIES, "indicesStrip");
    loadStrip(MACRO_PROXIES, "macroStrip");
  };
  load();
  setInterval(load, 60000);
}

export async function runNow() {
  const runBtn = document.getElementById("runBtn");
  runBtn.disabled = true;
  try {
    const dateKey = document.getElementById("reviewDate").value || undefined;
    const call = httpsCallable(functions, "runNow");
    await call({ dateKey });
  } catch (e) {
    document.getElementById("results").innerHTML = `<div class="note"><b>Couldn't start a run.</b><br>${esc(e.message)}</div>`;
  } finally {
    runBtn.disabled = false;
  }
}
```

- [ ] **Step 3: Wire it up in `frontend/index.html`**

Add to the module script from Task 11:

```html
<script type="module">
  import { requireOwner, signIn } from "./src/auth.js";
  import { watchDate, runNow, startLiveStrips } from "./src/digest.js";

  document.getElementById("signInBtn").addEventListener("click", signIn);
  document.getElementById("runBtn").addEventListener("click", runNow);

  let unsubscribe = null;
  function selectDate(dateKey) {
    if (unsubscribe) unsubscribe();
    unsubscribe = watchDate(dateKey);
  }

  document.getElementById("reviewDate").addEventListener("change", (e) => {
    selectDate(e.target.value || new Date().toISOString().slice(0, 10));
  });

  requireOwner((user) => {
    document.getElementById("loginGate").style.display = "none";
    document.getElementById("app").style.display = "block";
    const todayKey = new Date().toISOString().slice(0, 10);
    document.getElementById("reviewDate").value = todayKey;
    selectDate(todayKey);
    startLiveStrips();
  });
</script>
```

- [ ] **Step 4: Manual verification**

With the Task 10 backend deployed and at least one `digests/{today}` doc present (trigger `runNow` once for real, or manually create a test doc in the Firestore console matching the `DigestDoc` shape):

```bash
cd ~/stock-video-dashboard/frontend && npx serve .
```
Confirm: signed in as owner, the ticker cards render with rank/price/screen chip, expanding a card shows fundamentals/analyst/takes, changing the date picker swaps to a different day's doc (or shows the "no digest" note), "Run now" triggers a real run (status flips to "running" then "complete" live, no page refresh needed), and the index/macro strips populate on load and update again after 60 seconds.

- [ ] **Step 5: Commit**

```bash
cd ~/stock-video-dashboard
git add frontend/index.html frontend/src/digest.js
git commit -m "feat: add digest view with live Firestore listener and Run now"
```

---

### Task 13: Frontend — settings view

**Files:**
- Modify: `frontend/index.html` (add settings modal markup, ported from the prototype's Settings modal)
- Create: `frontend/src/settings.js`

**Interfaces:**
- Consumes: `db` from `./firebase-init.js`.
- Produces: reads/writes `config/settings` (`trackedHandles`, `scheduleTime`, `topN`).

No automated test — thin Firestore read/write wiring behind a form, verified manually.

- [ ] **Step 1: Port the settings modal markup**

Copy the settings overlay/modal HTML from `~/Downloads/stock-video-dashboard_23.html` (search for `id="overlay"`, the Settings form fields), trimmed to only the fields still owner-editable: tracked handles (one per line, replacing the `urls` textarea), `scheduleTime`, `topN`. Drop the API-key input fields entirely — those are Secret Manager values now, not something the frontend ever touches.

- [ ] **Step 2: Write `frontend/src/settings.js`**

```js
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";

const settingsRef = doc(db, "config", "settings");

export async function openSettings() {
  const snap = await getDoc(settingsRef);
  const s = snap.exists() ? snap.data() : { trackedHandles: [], scheduleTime: "07:00", topN: 15 };
  document.getElementById("trackedHandles").value = (s.trackedHandles || []).join("\n");
  document.getElementById("scheduleTime").value = s.scheduleTime || "07:00";
  document.getElementById("topN").value = s.topN ?? 15;
  document.getElementById("settingsOverlay").classList.add("show");
}

export function closeSettings() {
  document.getElementById("settingsOverlay").classList.remove("show");
}

export async function saveSettings() {
  const trackedHandles = document
    .getElementById("trackedHandles")
    .value.split(/\n+/)
    .map((h) => h.trim().replace(/^@/, ""))
    .filter(Boolean);
  const scheduleTime = document.getElementById("scheduleTime").value.trim() || "07:00";
  const topN = parseInt(document.getElementById("topN").value, 10) || 15;
  await setDoc(settingsRef, { trackedHandles, scheduleTime, topN });
  closeSettings();
}
```

- [ ] **Step 3: Wire it up in `frontend/index.html`**

```html
<script type="module">
  import { openSettings, closeSettings, saveSettings } from "./src/settings.js";
  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  document.getElementById("settingsCancelBtn").addEventListener("click", closeSettings);
  document.getElementById("settingsSaveBtn").addEventListener("click", saveSettings);
</script>
```

- [ ] **Step 4: Manual verification**

```bash
cd ~/stock-video-dashboard/frontend && npx serve .
```
Confirm: opening Settings shows the seeded `trackedHandles`/`scheduleTime`/`topN` from Task 10 Step 10, editing and saving updates `config/settings` in the Firestore console, and reopening Settings shows the saved values.

- [ ] **Step 5: Commit**

```bash
cd ~/stock-video-dashboard
git add frontend/index.html frontend/src/settings.js
git commit -m "feat: add Firestore-backed settings view"
```

---

### Task 14: Deploy to Netlify

This task requires the owner's own Netlify account — like Task 10, it cannot be run unattended.

**Files:**
- Create: `frontend/netlify.toml`

- [ ] **Step 1: Write `frontend/netlify.toml`**

```toml
[build]
  publish = "."

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
```

- [ ] **Step 2: Push the repo to a git remote Netlify can deploy from**

```bash
cd ~/stock-video-dashboard
gh repo create stock-video-dashboard --private --source=. --remote=origin
git push -u origin main
```

- [ ] **Step 3: Connect the site in Netlify**

In the Netlify dashboard: "Add new site" → "Import an existing project" → pick the `stock-video-dashboard` repo → set base directory to `frontend`, publish directory `frontend`, no build command (static files). Deploy.

- [ ] **Step 4: Allow-list the Netlify origin in Firebase**

In Firebase Console → Authentication → Settings → Authorized domains, add the Netlify site's domain (e.g. `your-site.netlify.app`) so Google sign-in works from it.

- [ ] **Step 5: Manual end-to-end verification on the deployed site**

Open the Netlify URL on your phone. Confirm: login gate appears, Google sign-in works, today's digest renders (or the "no digest" note if `dailyDigestRun` hasn't fired yet today), "Run now" successfully triggers a real run and the result appears live, Settings opens/saves correctly, and the date picker can browse a prior day if one exists.

- [ ] **Step 6: Commit**

```bash
cd ~/stock-video-dashboard
git add frontend/netlify.toml
git commit -m "chore: add Netlify config"
```

---

## Post-launch addition: "Market Health" summary (2026-07-27)

Discovered via user review after the initial launch: the original prototype had a third AI summary, `renderMacroSummary()` (prototype `~/Downloads/stock-video-dashboard_23.html:1054-1098`, heading "Market Health — what to watch for"), that was missed during brainstorming's "carry everything over" scoping — only Video Wrap and Market Recap were enumerated. The `.macro-summary` CSS class was even carried over in Task 12 but left unused, confirming the oversight.

Added, following the same pattern as `videoWrap`/`marketRecap` (computed once per pipeline run, stored on the digest doc, not a live/client-side call):

- **`functions/src/lib/types.ts`**: `DigestDoc.marketHealth?: string`.
- **`functions/src/lib/claude.ts`**: new `marketHealth(indexAndMacro, fred, cfg)`, system prompt ported verbatim from the prototype. Unlike `videoWrap`/`marketRecap`, this call has no date prefix in its user content and no date suffix in its rendered heading — matches source exactly.
- **`functions/src/lib/pipeline.ts`**: added `PipelineDeps.marketHealth`; added local `INDEX_PROXIES`/`MACRO_PROXIES` constants (mirroring `frontend/src/digest.js`'s copies) and a `loadIndexAndMacroQuotes()` helper that pulls fresh quotes via the existing `getQuote` dep; calls `deps.marketHealth(indexAndMacro, fred, claudeCfg)` after `fred` is computed, wrapped in try/catch (isolated failure — `marketHealth` left `undefined`, run still `"complete"`), matching every other optional-field pattern in this file.
- **`functions/src/index.ts`**: wired the real `marketHealth` from `claude.ts` into the `deps` object passed to `runPipeline`.
- **`frontend/index.html`**: added `<div id="macroSummary" class="daily-summary macro-summary"></div>` right after the FRED strip section (matches prototype placement exactly), using CSS already present from Task 12.
- **`frontend/src/digest.js`**: renders `docData.marketHealth` into `#macroSummary` with heading "Market Health — what to watch for" (no date suffix), same paragraph-splitting pattern as the other two summaries.

Tests: `functions/test/claude.test.ts` (`marketHealth` describe block — response pass-through, digest-format with/without FRED data, full system-prompt/max_tokens/model body assertion) and `functions/test/pipeline.test.ts` (happy-path assertion, failure-isolation test, and a test confirming `marketHealth` receives both the live index/macro quotes and the `fred` data). Verified visually in the browser with mocked data before deploy.
