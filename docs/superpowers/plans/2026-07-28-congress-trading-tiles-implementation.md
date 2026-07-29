# Congressional Trading Tiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new, live-polled "Congressional Trading" tile section to the Signal dashboard showing the top 10 congress members by 30-day weighted return on disclosed stock purchases, each with their top net-open holding.

**Architecture:** A new pure ranking module (`functions/src/lib/congress.ts`) fetches QuiverQuant's free, unauthenticated API and computes the ranking. A new HTTP Cloud Function (`congressTraders`, `functions/src/index.ts`) exposes it with the same owner-only auth as the existing `liveQuote` function — that auth logic is extracted into a shared, now-testable helper (`verifyOwnerAuth`) used by both functions, removing duplication. The frontend polls this endpoint every 20 minutes, independent of the digest pipeline entirely (no `DigestDoc`/Firestore involvement), the same way the Major Indices/Volatility strips already poll `liveQuote` every 60 seconds.

**Tech Stack:** TypeScript, Firebase Functions v2 (`onRequest`), Vitest, vanilla JS/HTML frontend (no bundler, no frontend test harness).

## Global Constraints

- No new secrets — QuiverQuant's `/live/congresstrading` endpoint requires no API key (confirmed in the existing `~/congress_trader/congress_trader.py` script: no key sent).
- No changes to `runPipeline`, `DigestDoc`, or any Firestore document — this data is never persisted, purely live-fetched.
- Ranking window: 30 days. Top N: 10.
- Ranking filter: `Transaction` contains "purchase" (case-insensitive), `Ticker` non-empty, `TickerType === "ST"`, `TransactionDate` within the last 30 days.
- Return calculation: `Amount`-weighted average of `PriceChange` across a member's qualifying purchases; if total disclosed `Amount` is 0, fall back to a plain (unweighted) average of `PriceChange`.
- Top holding: per member, sum `Amount` for purchases minus `Amount` for sales per ticker (same 30-day window, `TickerType === "ST"`, missing `Amount` defaults to 1000 — matches the source script's fallback), keep only positive net totals, take the largest. `null` if no ticker has positive net exposure.
- Poll interval: 20 minutes (`20 * 60 * 1000` ms) — independent of the 60-second interval already used for Major Indices/Volatility.
- Any failure (QuiverQuant fetch fails, non-OK response, malformed body) degrades to an empty result — never breaks the page, never throws past the boundary that would surface an error to the user.
- Visual style: reuse the existing `.idx-card`/`.indices-strip.macro` CSS exactly as used for Volatility & Credit and Economic Indicators — no new card chrome introduced.
- No frontend build step or test harness exists in this repo — none introduced for this feature.

---

### Task 1: Pure ranking module

**Files:**
- Create: `functions/src/lib/congress.ts`
- Create: `functions/test/congress.test.ts`

**Interfaces:**
- Produces: `CongressTrader { name: string; party: string; chamber: string; returnPct: number; tradeCount: number; topHolding: string | null }`, `computeCongressRanking(trades: RawTrade[], now?: Date, topN?: number): CongressTrader[]` (pure, exported for direct testing), and `getTopCongressTraders(): Promise<CongressTrader[]>` (the network-fetching wrapper, used by Task 2).

- [ ] **Step 1: Write the failing tests**

Create `functions/test/congress.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { computeCongressRanking, getTopCongressTraders } from "../src/lib/congress.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date("2026-07-28T12:00:00Z");

function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe("computeCongressRanking", () => {
  it("excludes trades older than 30 days", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 10000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Bob", Ticker: "TSLA", Transaction: "Purchase", Amount: 10000, TransactionDate: daysAgo(40), Party: "R", House: "Senate", TickerType: "ST", PriceChange: 20 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result.map((r) => r.name)).toEqual(["Alice"]);
  });

  it("excludes non-purchase transactions from the ranking", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Sale (Full)", Amount: 10000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result).toEqual([]);
  });

  it("excludes non-ST ticker types (e.g. options)", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 10000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "OP", PriceChange: 5 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result).toEqual([]);
  });

  it("computes the amount-weighted average return per member", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 10000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 10 },
      { Representative: "Alice", Ticker: "MSFT", Transaction: "Purchase", Amount: 30000, TransactionDate: daysAgo(3), Party: "D", House: "House", TickerType: "ST", PriceChange: 2 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].returnPct).toBeCloseTo(4, 5); // (10*10000 + 2*30000) / 40000 = 4
    expect(result[0].tradeCount).toBe(2);
  });

  it("falls back to an unweighted average return when total disclosed amount is zero", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 0, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 10 },
      { Representative: "Alice", Ticker: "MSFT", Transaction: "Purchase", Amount: 0, TransactionDate: daysAgo(3), Party: "D", House: "House", TickerType: "ST", PriceChange: 20 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result[0].returnPct).toBeCloseTo(15, 5); // unweighted average of 10 and 20
  });

  it("ranks descending by return and limits to topN", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 1000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Bob", Ticker: "TSLA", Transaction: "Purchase", Amount: 1000, TransactionDate: daysAgo(5), Party: "R", House: "Senate", TickerType: "ST", PriceChange: 20 },
      { Representative: "Carol", Ticker: "NVDA", Transaction: "Purchase", Amount: 1000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 10 },
    ];
    const result = computeCongressRanking(trades, NOW, 2);
    expect(result.map((r) => r.name)).toEqual(["Bob", "Carol"]);
  });

  it("computes topHolding as the ticker with the largest net positive position", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 5000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Alice", Ticker: "MSFT", Transaction: "Purchase", Amount: 20000, TransactionDate: daysAgo(4), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Sale (Partial)", Amount: 3000, TransactionDate: daysAgo(2), Party: "D", House: "House", TickerType: "ST", PriceChange: 0 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result[0].topHolding).toBe("MSFT"); // net AAPL = 2000, net MSFT = 20000
  });

  it("returns a null topHolding when a member has no positive net exposure", () => {
    const trades = [
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 5000, TransactionDate: daysAgo(5), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
      { Representative: "Alice", Ticker: "AAPL", Transaction: "Sale (Full)", Amount: 5000, TransactionDate: daysAgo(2), Party: "D", House: "House", TickerType: "ST", PriceChange: 0 },
    ];
    const result = computeCongressRanking(trades, NOW);
    expect(result).toHaveLength(1); // still ranked (has a qualifying purchase)
    expect(result[0].topHolding).toBeNull();
  });
});

describe("getTopCongressTraders", () => {
  it("returns the ranked list on a successful fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { Representative: "Alice", Ticker: "AAPL", Transaction: "Purchase", Amount: 10000, TransactionDate: new Date().toISOString(), Party: "D", House: "House", TickerType: "ST", PriceChange: 5 },
        ],
      })
    );
    const result = await getTopCongressTraders();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Alice");
  });

  it("returns an empty array when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network error")));
    expect(await getTopCongressTraders()).toEqual([]);
  });

  it("returns an empty array when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false }));
    expect(await getTopCongressTraders()).toEqual([]);
  });

  it("returns an empty array when the response body isn't an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ error: "rate limited" }) }));
    expect(await getTopCongressTraders()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd functions && npm test -- congress`
Expected: FAIL — `../src/lib/congress.js` doesn't exist yet.

- [ ] **Step 3: Implement `congress.ts`**

Create `functions/src/lib/congress.ts`:

```typescript
const QUIVER_URL = "https://api.quiverquant.com/beta/live/congresstrading";
const LOOKBACK_DAYS = 30;
const TOP_N = 10;

interface RawTrade {
  Representative?: string;
  Ticker?: string;
  Transaction?: string;
  Amount?: string | number;
  TransactionDate?: string;
  Party?: string;
  House?: string;
  TickerType?: string;
  PriceChange?: string | number;
}

export interface CongressTrader {
  name: string;
  party: string;
  chamber: string;
  returnPct: number;
  tradeCount: number;
  topHolding: string | null;
}

function toNumber(v: string | number | undefined): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function cutoffDate(now: Date): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - LOOKBACK_DAYS);
  return d;
}

function isWithinWindow(dateStr: string | undefined, cutoff: Date): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime()) && d >= cutoff;
}

function computeTopHolding(allTrades: RawTrade[], representative: string, cutoff: Date): string | null {
  const memberTrades = allTrades.filter(
    (t) => t.Representative === representative && isWithinWindow(t.TransactionDate, cutoff) && t.TickerType === "ST" && !!t.Ticker
  );

  const holdings = new Map<string, number>();
  for (const t of memberTrades) {
    const ticker = t.Ticker as string;
    const tx = (t.Transaction || "").toLowerCase();
    const amt = toNumber(t.Amount) || 1000;
    const current = holdings.get(ticker) || 0;
    if (tx.includes("purchase")) {
      holdings.set(ticker, current + amt);
    } else if (tx.includes("sale")) {
      holdings.set(ticker, current - amt);
    }
  }

  let topTicker: string | null = null;
  let topAmount = 0;
  for (const [ticker, amt] of holdings.entries()) {
    if (amt > 0 && amt > topAmount) {
      topTicker = ticker;
      topAmount = amt;
    }
  }
  return topTicker;
}

export function computeCongressRanking(trades: RawTrade[], now: Date = new Date(), topN: number = TOP_N): CongressTrader[] {
  const cutoff = cutoffDate(now);

  const purchases = trades.filter(
    (t) =>
      isWithinWindow(t.TransactionDate, cutoff) &&
      typeof t.Transaction === "string" &&
      t.Transaction.toLowerCase().includes("purchase") &&
      !!t.Ticker &&
      t.TickerType === "ST" &&
      !!t.Representative
  );

  const byMember = new Map<string, RawTrade[]>();
  for (const t of purchases) {
    const key = t.Representative as string;
    if (!byMember.has(key)) byMember.set(key, []);
    byMember.get(key)!.push(t);
  }

  const ranked: CongressTrader[] = Array.from(byMember.entries()).map(([name, memberTrades]) => {
    const totalAmt = memberTrades.reduce((sum, t) => sum + toNumber(t.Amount), 0);
    const returnPct =
      totalAmt === 0
        ? memberTrades.reduce((sum, t) => sum + toNumber(t.PriceChange), 0) / memberTrades.length
        : memberTrades.reduce((sum, t) => sum + toNumber(t.PriceChange) * toNumber(t.Amount), 0) / totalAmt;
    return {
      name,
      party: memberTrades[0].Party || "?",
      chamber: memberTrades[0].House || "?",
      returnPct,
      tradeCount: memberTrades.length,
      topHolding: computeTopHolding(trades, name, cutoff),
    };
  });

  ranked.sort((a, b) => b.returnPct - a.returnPct);
  return ranked.slice(0, topN);
}

export async function getTopCongressTraders(): Promise<CongressTrader[]> {
  try {
    const res = await fetch(QUIVER_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const trades = (await res.json()) as unknown;
    if (!Array.isArray(trades)) return [];
    return computeCongressRanking(trades as RawTrade[]);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd functions && npm test -- congress && npm run build`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add functions/src/lib/congress.ts functions/test/congress.test.ts
git commit -m "feat: add congressional trading ranking module"
```

---

### Task 2: HTTP endpoint with shared owner-auth helper

**Files:**
- Modify: `functions/src/index.ts`
- Modify: `functions/test/index.test.ts`

**Interfaces:**
- Consumes: `getTopCongressTraders` from Task 1 (`functions/src/lib/congress.js`).
- Produces: exported `verifyOwnerAuth(authHeader: string | undefined): Promise<{ ok: true } | { ok: false; status: number; error: string }>`, and the new `congressTraders` Cloud Function, consumed by Task 3's frontend fetch call to `${FUNCTIONS_BASE_URL}/congressTraders`.

- [ ] **Step 1: Write the failing tests**

`liveQuote` (the existing HTTP function this pattern is copied from) currently has no test coverage at all — only `assertOwner`/`guardOverlap`/`resolveTargetDate` are tested in `functions/test/index.test.ts`. This task adds the first coverage for the owner-auth logic, via the new exported `verifyOwnerAuth` helper (both `liveQuote` and the new `congressTraders` will call it, removing the auth-check duplication between them).

In `functions/test/index.test.ts`, change the top import line:

```typescript
import { assertOwner, guardOverlap, resolveTargetDate } from "../src/index.js";
```

to:

```typescript
import { assertOwner, guardOverlap, resolveTargetDate, verifyOwnerAuth } from "../src/index.js";
```

Add this mock near the top of the file, right after the imports (before the `OWNER_UID` constant):

```typescript
import { vi } from "vitest";

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: vi.fn(async (token: string) => {
      if (token === "valid-owner-token") return { uid: "ETuFSQc87GXecZg8JEgLqpYhgkL2" };
      if (token === "valid-other-token") return { uid: "someone-else" };
      throw new Error("invalid token");
    }),
  }),
}));
```

Note: `functions/test/index.test.ts` currently only imports `{ describe, it, expect }` from `"vitest"` — add `vi` to that same import instead of a separate line, i.e. change:

```typescript
import { describe, it, expect } from "vitest";
```

to:

```typescript
import { describe, it, expect, vi } from "vitest";
```

Then add a new `describe` block at the end of the file:

```typescript
describe("verifyOwnerAuth", () => {
  it("rejects a missing Authorization header", async () => {
    const result = await verifyOwnerAuth(undefined);
    expect(result).toEqual({ ok: false, status: 401, error: "missing or malformed Authorization header" });
  });

  it("rejects a malformed Authorization header", async () => {
    const result = await verifyOwnerAuth("NotBearer abc");
    expect(result).toEqual({ ok: false, status: 401, error: "missing or malformed Authorization header" });
  });

  it("rejects an invalid token", async () => {
    const result = await verifyOwnerAuth("Bearer garbage-token");
    expect(result).toEqual({ ok: false, status: 401, error: "invalid token" });
  });

  it("rejects a valid token belonging to a non-owner", async () => {
    const result = await verifyOwnerAuth("Bearer valid-other-token");
    expect(result).toEqual({ ok: false, status: 403, error: "not authorized" });
  });

  it("accepts a valid owner token", async () => {
    const result = await verifyOwnerAuth("Bearer valid-owner-token");
    expect(result).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd functions && npm test -- index`
Expected: FAIL — `verifyOwnerAuth` is not exported from `index.ts`.

- [ ] **Step 3: Extract `verifyOwnerAuth` and refactor `liveQuote` to use it**

In `functions/src/index.ts`, add the import for the new module. Change:

```typescript
import { fredLatest, fredYoY, fredWithPrior } from "./lib/fred.js";
import type { DigestDoc } from "./lib/types.js";
```

to:

```typescript
import { fredLatest, fredYoY, fredWithPrior } from "./lib/fred.js";
import { getTopCongressTraders } from "./lib/congress.js";
import type { DigestDoc } from "./lib/types.js";
```

Add this new exported function immediately after `resolveTargetDate` (before the `const deps: PipelineDeps = {` block):

```typescript
export async function verifyOwnerAuth(authHeader: string | undefined): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "missing or malformed Authorization header" };
  }
  const idToken = authHeader.slice("Bearer ".length);

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(idToken);
  } catch {
    return { ok: false, status: 401, error: "invalid token" };
  }

  if (decoded.uid !== OWNER_UID) {
    return { ok: false, status: 403, error: "not authorized" };
  }

  return { ok: true };
}
```

Then replace the entire body of `liveQuote` (from `const authHeader = request.headers.authorization;` through the `if (decoded.uid !== OWNER_UID) { ... }` block) — i.e. everything between the `if (request.method === "OPTIONS") { ... }` block and `const sym = String(request.query.sym || "");` — with:

```typescript
  const auth = await verifyOwnerAuth(request.headers.authorization);
  if (!auth.ok) {
    response.status(auth.status).json({ error: auth.error });
    return;
  }
```

So the full `liveQuote` function reads:

```typescript
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

  const auth = await verifyOwnerAuth(request.headers.authorization);
  if (!auth.ok) {
    response.status(auth.status).json({ error: auth.error });
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

- [ ] **Step 4: Add the new `congressTraders` function**

At the end of `functions/src/index.ts`, after the `liveQuote` export, add:

```typescript
export const congressTraders = onRequest({}, async (request, response) => {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.set("Access-Control-Allow-Headers", "Authorization");
  if (request.method === "OPTIONS") {
    response.status(204).send("");
    return;
  }

  const auth = await verifyOwnerAuth(request.headers.authorization);
  if (!auth.ok) {
    response.status(auth.status).json({ error: auth.error });
    return;
  }

  const traders = await getTopCongressTraders();
  response.json(traders);
});
```

Note this function takes no `secrets` array (unlike `liveQuote`, which needs `finnhubKey`) — the QuiverQuant endpoint needs no key.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd functions && npm test && npm run build`
Expected: full suite PASS (this also re-confirms the existing `assertOwner`/`guardOverlap`/`resolveTargetDate` tests still pass, and that `liveQuote`'s refactor didn't change its externally-observable behavior), clean build.

- [ ] **Step 6: Commit**

```bash
git add functions/src/index.ts functions/test/index.test.ts
git commit -m "feat: add congressTraders endpoint, extract shared owner-auth helper"
```

---

### Task 3: Frontend — live-polled tile section

**Files:**
- Modify: `frontend/src/digest.js`
- Modify: `frontend/index.html`

**Interfaces:**
- Consumes: `GET ${FUNCTIONS_BASE_URL}/congressTraders` (Authorization: Bearer `<idToken>`), returning `CongressTrader[]` from Task 2 (`{ name, party, chamber, returnPct, tradeCount, topHolding }[]`).

No automated test harness exists for the frontend in this repo — this task ends with manual verification instead of automated tests, matching established precedent.

- [ ] **Step 1: Add the new section markup**

In `frontend/index.html`, find:

```html
      <div class="strip-section">
        <div class="strip-label">Economic Indicators <span>· FRED</span></div>
        <div class="indices-strip macro" id="fredStrip"></div>
      </div>

      <div id="macroSummary" class="daily-summary macro-summary"></div>
```

and insert a new section between them:

```html
      <div class="strip-section">
        <div class="strip-label">Economic Indicators <span>· FRED</span></div>
        <div class="indices-strip macro" id="fredStrip"></div>
      </div>

      <div class="strip-section">
        <div class="strip-label">Congressional Trading <span>· top performers (30-day)</span></div>
        <div class="indices-strip macro" id="congressStrip"></div>
      </div>

      <div id="macroSummary" class="daily-summary macro-summary"></div>
```

- [ ] **Step 2: Add the caption/return-color CSS**

In `frontend/index.html`, find:

```css
  .idx-card .if{font-family:"JetBrains Mono";font-size:11px;font-weight:600;margin-top:5px;letter-spacing:.01em}
  .idx-card .if.normal{color:var(--pos)}
  .idx-card .if.warning{color:var(--neg)}
```

and add immediately after it:

```css
  .idx-card .ip.pos{color:var(--pos)}
  .idx-card .ip.neg{color:var(--neg)}
  .idx-card .cc{font-size:11px;color:var(--faint);margin-top:4px;line-height:1.4}
```

- [ ] **Step 3: Add the fetch/render function**

In `frontend/src/digest.js`, add this function immediately after `loadStrip` (before `export function startLiveStrips()`):

```javascript
async function loadCongressTraders() {
  const el = document.getElementById("congressStrip");
  if (!el) return;
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) return; // not signed in yet (login gate hasn't resolved) — skip this cycle
  try {
    const r = await fetch(`${FUNCTIONS_BASE_URL}/congressTraders`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    const traders = await r.json();
    if (!Array.isArray(traders)) return;
    el.innerHTML = traders
      .map(
        (t) => `<div class="idx-card">
          <div class="in">${esc(t.name)}</div>
          <div class="ip ${t.returnPct >= 0 ? "pos" : "neg"}">${t.returnPct >= 0 ? "+" : ""}${t.returnPct.toFixed(1)}%</div>
          <div class="cc">${esc(t.party)} · ${esc(t.chamber)} · ${t.tradeCount} trade${t.tradeCount === 1 ? "" : "s"}</div>
          ${t.topHolding ? `<div class="cc">Top holding: ${esc(t.topHolding)}</div>` : ""}
        </div>`
      )
      .join("");
  } catch {
    // leave section empty
  }
}
```

- [ ] **Step 4: Wire the poller into `startLiveStrips`**

In `frontend/src/digest.js`, find:

```javascript
export function startLiveStrips() {
  const load = () => {
    loadStrip(INDEX_PROXIES, "indicesStrip");
    loadStrip(MACRO_PROXIES, "macroStrip");
  };
  load();
  setInterval(load, 60000);
}
```

and replace it with:

```javascript
export function startLiveStrips() {
  const load = () => {
    loadStrip(INDEX_PROXIES, "indicesStrip");
    loadStrip(MACRO_PROXIES, "macroStrip");
  };
  load();
  setInterval(load, 60000);

  loadCongressTraders();
  setInterval(loadCongressTraders, 20 * 60 * 1000);
}
```

- [ ] **Step 5: Syntax-check and self-review**

Run: `node --check frontend/src/digest.js`
Expected: no output (clean).

Re-read the diff: confirm `loadCongressTraders` follows the exact same guard-clause shape as `loadStrip` (missing element → return, missing idToken → return, fetch error → caught and swallowed), confirm the new CSS classes (`.ip.pos`, `.ip.neg`, `.cc`) don't collide with any existing class names, and confirm `#congressStrip` in the new HTML section matches the `getElementById("congressStrip")` call exactly.

- [ ] **Step 6: Manual verification**

This repo has no frontend test harness, so verify by hand once this is deployed:

1. Open the live dashboard, signed in as owner.
2. Confirm a new "Congressional Trading · top performers (30-day)" section appears below "Economic Indicators," populated within a few seconds of page load (not waiting for "Run analysis").
3. Confirm each tile shows a member name, a colored return % (green for positive, red for negative), a party/chamber/trade-count caption, and a "Top holding: TICKER" line when applicable (some members may legitimately have no top holding — confirm that tile just omits the line, doesn't break).
4. Confirm the section does not disappear or error out if you wait — it's independent of the "Run analysis" button entirely.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/digest.js frontend/index.html
git commit -m "feat: render live-polled congressional trading tiles"
```

---

## Post-plan

Once all three tasks are committed, deploy: `npx --yes firebase-tools deploy --only functions --project signal-stock-digest-67e26` for Tasks 1-2's backend changes, and push to `origin/main` for Task 3's frontend change (Netlify auto-deploys on push). Then do the manual verification from Task 3 Step 6 against the live site.
