# Congressional Trading Tiles v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v1 congressional-trading feature's QuiverQuant-based implementation (broken data source, never deployed) with one built on the Apify "Capitol Trades Scraper" actor, computing returns via Finnhub, running weekly, and delivering data through a real-time Firestore listener instead of HTTP polling.

**Architecture:** A pure module (`functions/src/lib/congress.ts`) parses Capitol Trades' scraped output and ranks members — this replaces v1's file of the same name entirely. A weekly `onSchedule` Cloud Function orchestrates the real I/O (Apify actor call → Finnhub price lookups → Firestore write), replacing v1's `congressTraders` HTTP endpoint. The frontend switches from polling that endpoint to a real-time Firestore listener, matching the existing `watchDate` pattern.

**Tech Stack:** TypeScript, Firebase Functions v2 (`onSchedule`, Firestore), Vitest, `@firebase/rules-unit-testing` (Firestore emulator), vanilla JS/HTML frontend (no bundler, no frontend test harness).

## Global Constraints

- **v1 cleanup, not a green-field build**: `functions/src/lib/congress.ts`, `functions/test/congress.test.ts`, the `congressTraders` HTTP endpoint in `functions/src/index.ts`, and the polling code in `frontend/src/digest.js` all currently exist (from the unreverted, undeployed v1 commits `60ec900c..de0c2d03`) and must be replaced/removed by this plan's tasks — not assumed absent.
- **Keep unchanged**: `verifyOwnerAuth` and the refactored `liveQuote` function in `index.ts` — this was a safe, reviewed improvement independent of the data-source change. Do not modify either.
- Capitol Trades Scraper actor ID: `VyNAX2PeuvQ8UQ7FK`. Real output field names (from the actor's own published README): `politician_name`, `politician_family` (e.g. `"Democrat House CA"` — space-separated party/chamber/state), `traded_issuer_ticker` (e.g. `"MSFT:US"` — strip the `:EXCHANGE` suffix), `published`, `traded` (both date strings like `"31 Jul 2024"`), `filed_after`, `owner`, `type` (`"buy"`/`"sell"`, lowercase), `size` (bucketed range string like `"1K–15K"` or open-ended `"50M+"`), `price` (numeric string, may be missing/invalid).
- 30-day lookback window (closed: not older than 30 days, not in the future), weekly cadence, top 10.
- Return calculation: `(currentPrice - tradePrice) / tradePrice * 100` per trade, only for trades with a valid positive `tradePrice` AND a resolvable current price. A member with zero valid-priced trades is excluded from the ranking entirely (not shown with a fabricated 0% return).
- Per-member return is a weighted average across their valid-priced trades, weighted by parsed size-bucket midpoint; falls back to an unweighted average if total weight is 0.
- Only `type === "buy"` trades count toward the ranking; `computeTopHolding` uses both buy and sell trades (net position), matching v1's convention.
- No hardcoded size-bucket lookup table — parse generically (extract numeric value + K/M multiplier from each side of the range, or the single value for an open-ended `"N+"` bucket).
- Delivery: Firestore document `congress/latest` (`{ traders: CongressTrader[]; computedAt: number }`), written by the weekly function, read by a real-time frontend listener — no HTTP polling.
- On Apify failure: leave the existing `congress/latest` document untouched (log the error, return early) rather than overwriting it with empty/error data — a transient scrape failure shouldn't erase a week's worth of good data.
- On a single ticker's Finnhub lookup failure: exclude that ticker from the return calculation only — do not fail the whole weekly run.
- No frontend build step or test harness exists in this repo — none introduced for Task 3.

---

### Task 1: Pure parsing and ranking module

**Files:**
- Modify (full rewrite): `functions/src/lib/congress.ts`
- Modify (full rewrite): `functions/test/congress.test.ts`

**Interfaces:**
- Produces: `RawCapitolTrade` (raw scraped shape), `ParsedTrade` (normalized shape), `CongressTrader { name, party, chamber, returnPct, tradeCount, topHolding }` (same shape as v1 — Task 3's frontend already expects these exact field names), `parseCapitolTrade(raw: RawCapitolTrade): ParsedTrade | null`, `computeCongressRanking(trades: ParsedTrade[], priceByTicker: Map<string, number>, now?: Date, topN?: number): CongressTrader[]` — all consumed by Task 2's orchestration function.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `functions/test/congress.test.ts` with:

```typescript
import { describe, it, expect } from "vitest";
import { parseCapitolTrade, computeCongressRanking, type RawCapitolTrade, type ParsedTrade } from "../src/lib/congress.js";

const NOW = new Date("2026-07-28T12:00:00Z");

function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  const day = d.getUTCDate();
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function rawTrade(overrides: Partial<RawCapitolTrade> = {}): RawCapitolTrade {
  return {
    politician_name: "Alice Example",
    politician_family: "Democrat House CA",
    traded_issuer_ticker: "AAPL:US",
    published: daysAgo(5),
    traded: daysAgo(5),
    filed_after: "5 days",
    owner: "Self",
    type: "buy",
    size: "1K–15K",
    price: "100.00",
    ...overrides,
  };
}

describe("parseCapitolTrade", () => {
  it("parses a well-formed trade", () => {
    const result = parseCapitolTrade(rawTrade());
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Alice Example");
    expect(result?.party).toBe("Democrat");
    expect(result?.chamber).toBe("House");
    expect(result?.ticker).toBe("AAPL");
    expect(result?.type).toBe("buy");
    expect(result?.tradePrice).toBe(100);
  });

  it("strips the :EXCHANGE suffix from the ticker", () => {
    const result = parseCapitolTrade(rawTrade({ traded_issuer_ticker: "MSFT:US" }));
    expect(result?.ticker).toBe("MSFT");
  });

  it("normalizes type to lowercase buy/sell, defaulting anything else to buy", () => {
    expect(parseCapitolTrade(rawTrade({ type: "sell" }))?.type).toBe("sell");
    expect(parseCapitolTrade(rawTrade({ type: "SELL" }))?.type).toBe("sell");
    expect(parseCapitolTrade(rawTrade({ type: "buy" }))?.type).toBe("buy");
  });

  it("parses a two-sided size bucket as the midpoint", () => {
    expect(parseCapitolTrade(rawTrade({ size: "1K–15K" }))?.sizeAmount).toBe(8000);
    expect(parseCapitolTrade(rawTrade({ size: "1M–5M" }))?.sizeAmount).toBe(3_000_000);
  });

  it("parses an open-ended size bucket as its lower bound", () => {
    expect(parseCapitolTrade(rawTrade({ size: "50M+" }))?.sizeAmount).toBe(50_000_000);
  });

  it("treats a missing or invalid price as null, not zero", () => {
    expect(parseCapitolTrade(rawTrade({ price: undefined }))?.tradePrice).toBeNull();
    expect(parseCapitolTrade(rawTrade({ price: "N/A" }))?.tradePrice).toBeNull();
  });

  it("returns null when politician_name is missing", () => {
    expect(parseCapitolTrade(rawTrade({ politician_name: undefined }))).toBeNull();
  });

  it("returns null when traded_issuer_ticker is missing", () => {
    expect(parseCapitolTrade(rawTrade({ traded_issuer_ticker: undefined }))).toBeNull();
  });

  it("returns null when the traded date is missing or unparseable", () => {
    expect(parseCapitolTrade(rawTrade({ traded: undefined }))).toBeNull();
    expect(parseCapitolTrade(rawTrade({ traded: "not a date" }))).toBeNull();
  });
});

function parsedTrade(overrides: Partial<ParsedTrade> = {}): ParsedTrade {
  return {
    name: "Alice Example",
    party: "Democrat",
    chamber: "House",
    ticker: "AAPL",
    type: "buy",
    sizeAmount: 8000,
    tradePrice: 100,
    tradedDate: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

describe("computeCongressRanking", () => {
  it("computes a member's return from current price vs. trade price", () => {
    const trades = [parsedTrade({ tradePrice: 100 })];
    const prices = new Map([["AAPL", 110]]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].returnPct).toBeCloseTo(10, 5); // (110-100)/100 * 100
  });

  it("excludes a member entirely when none of their trades have a resolvable price", () => {
    const trades = [parsedTrade({ ticker: "AAPL", tradePrice: 100 })];
    const prices = new Map<string, number>(); // no AAPL price available
    expect(computeCongressRanking(trades, prices, NOW)).toEqual([]);
  });

  it("excludes trades with a null tradePrice from the return calc, but still counts tradeCount", () => {
    const trades = [
      parsedTrade({ ticker: "AAPL", tradePrice: 100 }),
      parsedTrade({ ticker: "AAPL", tradePrice: null }),
    ];
    const prices = new Map([["AAPL", 110]]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result[0].returnPct).toBeCloseTo(10, 5); // only the priced trade counts
    expect(result[0].tradeCount).toBe(2); // both qualifying buys still counted
  });

  it("weights the average return by size when multiple trades have different sizes", () => {
    const trades = [
      parsedTrade({ ticker: "AAPL", tradePrice: 100, sizeAmount: 10000 }), // return 10%
      parsedTrade({ ticker: "MSFT", tradePrice: 200, sizeAmount: 30000 }), // return 2%
    ];
    const prices = new Map([
      ["AAPL", 110],
      ["MSFT", 204],
    ]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result[0].returnPct).toBeCloseTo((10 * 10000 + 2 * 30000) / 40000, 5); // = 4
  });

  it("falls back to an unweighted average when total size weight is zero", () => {
    const trades = [
      parsedTrade({ ticker: "AAPL", tradePrice: 100, sizeAmount: 0 }), // return 10%
      parsedTrade({ ticker: "MSFT", tradePrice: 200, sizeAmount: 0 }), // return 20%
    ];
    const prices = new Map([
      ["AAPL", 110],
      ["MSFT", 240],
    ]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result[0].returnPct).toBeCloseTo(15, 5); // unweighted average of 10 and 20
  });

  it("excludes sell trades from the ranking", () => {
    const trades = [parsedTrade({ type: "sell", tradePrice: 100 })];
    const prices = new Map([["AAPL", 110]]);
    expect(computeCongressRanking(trades, prices, NOW)).toEqual([]);
  });

  it("excludes trades traded more than 30 days ago", () => {
    const trades = [parsedTrade({ tradedDate: new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000) })];
    const prices = new Map([["AAPL", 110]]);
    expect(computeCongressRanking(trades, prices, NOW)).toEqual([]);
  });

  it("excludes trades dated in the future", () => {
    const trades = [parsedTrade({ tradedDate: new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000) })];
    const prices = new Map([["AAPL", 110]]);
    expect(computeCongressRanking(trades, prices, NOW)).toEqual([]);
  });

  it("ranks descending by return and limits to topN", () => {
    const trades = [
      parsedTrade({ name: "Alice", ticker: "AAPL", tradePrice: 100 }), // 5%
      parsedTrade({ name: "Bob", ticker: "MSFT", tradePrice: 100 }), // 20%
      parsedTrade({ name: "Carol", ticker: "NVDA", tradePrice: 100 }), // 10%
    ];
    const prices = new Map([
      ["AAPL", 105],
      ["MSFT", 120],
      ["NVDA", 110],
    ]);
    const result = computeCongressRanking(trades, prices, NOW, 2);
    expect(result.map((r) => r.name)).toEqual(["Bob", "Carol"]);
  });

  it("computes topHolding from net buy-minus-sell size across both buy and sell trades", () => {
    const trades = [
      parsedTrade({ ticker: "AAPL", type: "buy", sizeAmount: 8000, tradePrice: 100 }),
      parsedTrade({ ticker: "MSFT", type: "buy", sizeAmount: 32500, tradePrice: 100 }),
      parsedTrade({ ticker: "AAPL", type: "sell", sizeAmount: 3000 }),
    ];
    const prices = new Map([
      ["AAPL", 110],
      ["MSFT", 110],
    ]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result[0].topHolding).toBe("MSFT"); // net AAPL = 5000, net MSFT = 32500
  });

  it("returns a null topHolding when a member has no positive net position", () => {
    const trades = [
      parsedTrade({ ticker: "AAPL", type: "buy", sizeAmount: 8000, tradePrice: 100 }),
      parsedTrade({ ticker: "AAPL", type: "sell", sizeAmount: 8000 }),
    ];
    const prices = new Map([["AAPL", 110]]);
    const result = computeCongressRanking(trades, prices, NOW);
    expect(result[0].topHolding).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd functions && npm test -- congress`
Expected: FAIL — the current `congress.ts` exports `computeCongressRanking`/`getTopCongressTraders` with the old (QuiverQuant) signature, not `parseCapitolTrade` or the new `computeCongressRanking(trades, priceByTicker, ...)` signature.

- [ ] **Step 3: Replace `congress.ts`**

Replace the entire contents of `functions/src/lib/congress.ts` with:

```typescript
const LOOKBACK_DAYS = 30;
const TOP_N = 10;

export interface RawCapitolTrade {
  politician_name?: string;
  politician_family?: string;
  traded_issuer_ticker?: string;
  published?: string;
  traded?: string;
  filed_after?: string;
  owner?: string;
  type?: string;
  size?: string;
  price?: string;
}

export interface ParsedTrade {
  name: string;
  party: string;
  chamber: string;
  ticker: string;
  type: "buy" | "sell";
  sizeAmount: number;
  tradePrice: number | null;
  tradedDate: Date;
}

export interface CongressTrader {
  name: string;
  party: string;
  chamber: string;
  returnPct: number;
  tradeCount: number;
  topHolding: string | null;
}

function parseSizeBucket(size: string | undefined): number {
  if (!size) return 0;
  const cleaned = size.replace(/,/g, "").trim();
  const parseValue = (s: string): number => {
    const m = s.match(/^([\d.]+)\s*([KM]?)/i);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    const mult = m[2].toUpperCase() === "M" ? 1_000_000 : m[2].toUpperCase() === "K" ? 1_000 : 1;
    return num * mult;
  };
  if (cleaned.endsWith("+")) {
    return parseValue(cleaned.slice(0, -1));
  }
  const parts = cleaned.split(/[–-]/);
  if (parts.length !== 2) return parseValue(cleaned);
  return (parseValue(parts[0]) + parseValue(parts[1])) / 2;
}

export function parseCapitolTrade(raw: RawCapitolTrade): ParsedTrade | null {
  if (!raw.politician_name || !raw.traded_issuer_ticker || !raw.traded) return null;
  const tradedDate = new Date(raw.traded);
  if (isNaN(tradedDate.getTime())) return null;

  const ticker = raw.traded_issuer_ticker.split(":")[0];
  const familyParts = (raw.politician_family || "").split(/\s+/);
  const party = familyParts[0] || "?";
  const chamber = familyParts[1] || "?";
  const type: "buy" | "sell" = (raw.type || "").toLowerCase() === "sell" ? "sell" : "buy";
  const sizeAmount = parseSizeBucket(raw.size);
  const priceNum = raw.price ? parseFloat(raw.price) : NaN;
  const tradePrice = !isNaN(priceNum) && priceNum > 0 ? priceNum : null;

  return { name: raw.politician_name, party, chamber, ticker, type, sizeAmount, tradePrice, tradedDate };
}

function isWithinWindow(d: Date, cutoff: Date, now: Date): boolean {
  return d >= cutoff && d <= now;
}

function computeTopHolding(allTrades: ParsedTrade[], name: string, cutoff: Date, now: Date): string | null {
  const memberTrades = allTrades.filter((t) => t.name === name && isWithinWindow(t.tradedDate, cutoff, now));
  const holdings = new Map<string, number>();
  for (const t of memberTrades) {
    const current = holdings.get(t.ticker) || 0;
    holdings.set(t.ticker, t.type === "buy" ? current + t.sizeAmount : current - t.sizeAmount);
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

export function computeCongressRanking(
  trades: ParsedTrade[],
  priceByTicker: Map<string, number>,
  now: Date = new Date(),
  topN: number = TOP_N
): CongressTrader[] {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);

  const buys = trades.filter((t) => t.type === "buy" && isWithinWindow(t.tradedDate, cutoff, now));

  const byMember = new Map<string, ParsedTrade[]>();
  for (const t of buys) {
    if (!byMember.has(t.name)) byMember.set(t.name, []);
    byMember.get(t.name)!.push(t);
  }

  const ranked: CongressTrader[] = [];
  for (const [name, memberTrades] of byMember.entries()) {
    const returns: { pct: number; weight: number }[] = [];
    for (const t of memberTrades) {
      const currentPrice = priceByTicker.get(t.ticker);
      if (t.tradePrice == null || currentPrice == null) continue;
      returns.push({ pct: ((currentPrice - t.tradePrice) / t.tradePrice) * 100, weight: t.sizeAmount });
    }
    if (returns.length === 0) continue;

    const totalWeight = returns.reduce((sum, r) => sum + r.weight, 0);
    const returnPct =
      totalWeight === 0
        ? returns.reduce((sum, r) => sum + r.pct, 0) / returns.length
        : returns.reduce((sum, r) => sum + r.pct * r.weight, 0) / totalWeight;

    ranked.push({
      name,
      party: memberTrades[0].party,
      chamber: memberTrades[0].chamber,
      returnPct,
      tradeCount: memberTrades.length,
      topHolding: computeTopHolding(trades, name, cutoff, now),
    });
  }

  ranked.sort((a, b) => b.returnPct - a.returnPct);
  return ranked.slice(0, topN);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd functions && npm test -- congress && npm run build`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add functions/src/lib/congress.ts functions/test/congress.test.ts
git commit -m "feat: replace congress.ts with Capitol Trades parsing + Finnhub-return ranking"
```

---

### Task 2: Weekly orchestration, HTTP endpoint removal, Firestore rule

**Files:**
- Modify: `functions/src/lib/congress.ts` (add orchestration on top of Task 1)
- Modify: `functions/test/congress.test.ts` (add orchestration tests)
- Modify: `functions/src/index.ts`
- Modify: `firestore.rules`
- Modify: `firestore-tests/rules.test.ts`

**Interfaces:**
- Consumes: `parseCapitolTrade`, `computeCongressRanking`, `CongressTrader`, `ParsedTrade`, `RawCapitolTrade` from Task 1.
- Produces: `CongressDeps { runActor; getQuote; setDoc }`, `runCongressTradersUpdate(secrets: { apifyToken: string; finnhubKey: string }, deps: CongressDeps, now?: Date): Promise<void>`, and the deployed `congressTradersWeekly` Cloud Function that wires it to real Apify/Finnhub/Firestore.

- [ ] **Step 1: Write the failing orchestration tests**

Add to the top of `functions/test/congress.test.ts`, change the import line from:

```typescript
import { parseCapitolTrade, computeCongressRanking, type RawCapitolTrade, type ParsedTrade } from "../src/lib/congress.js";
```

to:

```typescript
import { describe, it, expect, vi } from "vitest";
import { parseCapitolTrade, computeCongressRanking, runCongressTradersUpdate, type RawCapitolTrade, type ParsedTrade } from "../src/lib/congress.js";
```

(This replaces the file's original `import { describe, it, expect } from "vitest";` line — merge `vi` into that same import instead of adding a second one.)

Then add this at the end of the file:

```typescript
describe("runCongressTradersUpdate", () => {
  const secrets = { apifyToken: "at", finnhubKey: "fk" };

  function rawItem(overrides: Partial<RawCapitolTrade> = {}): RawCapitolTrade {
    return {
      politician_name: "Alice Example",
      politician_family: "Democrat House CA",
      traded_issuer_ticker: "AAPL:US",
      published: daysAgo(5),
      traded: daysAgo(5),
      filed_after: "5 days",
      owner: "Self",
      type: "buy",
      size: "1K–15K",
      price: "100.00",
      ...overrides,
    };
  }

  it("writes the computed ranking to the doc on success", async () => {
    const setDoc = vi.fn().mockResolvedValue(undefined);
    const deps = {
      runActor: vi.fn().mockResolvedValue([rawItem()]),
      getQuote: vi.fn().mockResolvedValue({ price: 110, changePct: 1 }),
      setDoc,
    };
    await runCongressTradersUpdate(secrets, deps, NOW);
    expect(setDoc).toHaveBeenCalledTimes(1);
    const written = setDoc.mock.calls[0][0];
    expect(written.traders).toHaveLength(1);
    expect(written.traders[0].name).toBe("Alice Example");
    expect(typeof written.computedAt).toBe("number");
  });

  it("leaves the existing doc untouched when the Apify run fails", async () => {
    const setDoc = vi.fn().mockResolvedValue(undefined);
    const deps = {
      runActor: vi.fn().mockRejectedValue(new Error("Apify 500")),
      getQuote: vi.fn(),
      setDoc,
    };
    await runCongressTradersUpdate(secrets, deps, NOW);
    expect(setDoc).not.toHaveBeenCalled();
  });

  it("dedupes Finnhub calls to one per distinct ticker", async () => {
    const getQuote = vi.fn().mockResolvedValue({ price: 110, changePct: 1 });
    const deps = {
      runActor: vi.fn().mockResolvedValue([
        rawItem({ politician_name: "Alice Example" }),
        rawItem({ politician_name: "Bob Example", politician_family: "Republican Senate TX" }),
      ]),
      getQuote,
      setDoc: vi.fn().mockResolvedValue(undefined),
    };
    await runCongressTradersUpdate(secrets, deps, NOW);
    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(getQuote).toHaveBeenCalledWith("AAPL", "fk");
  });

  it("excludes a ticker from the ranking when its Finnhub lookup fails, without failing the whole run", async () => {
    const setDoc = vi.fn().mockResolvedValue(undefined);
    const deps = {
      runActor: vi.fn().mockResolvedValue([rawItem()]),
      getQuote: vi.fn().mockRejectedValue(new Error("Finnhub 429")),
      setDoc,
    };
    await runCongressTradersUpdate(secrets, deps, NOW);
    expect(setDoc).toHaveBeenCalledTimes(1);
    expect(setDoc.mock.calls[0][0].traders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd functions && npm test -- congress`
Expected: FAIL — `runCongressTradersUpdate` is not exported from `congress.ts` yet.

- [ ] **Step 3: Add the orchestration function to `congress.ts`**

Append to the end of `functions/src/lib/congress.ts` (after `computeCongressRanking`):

```typescript
const CONGRESS_ACTOR_ID = "VyNAX2PeuvQ8UQ7FK";

export interface CongressDeps {
  runActor: (actorId: string, token: string, input: object) => Promise<unknown[]>;
  getQuote: (sym: string, key: string) => Promise<{ price: number; changePct: number } | null>;
  setDoc: (data: { traders: CongressTrader[]; computedAt: number }) => Promise<void>;
}

export async function runCongressTradersUpdate(
  secrets: { apifyToken: string; finnhubKey: string },
  deps: CongressDeps,
  now: Date = new Date()
): Promise<void> {
  let rawItems: unknown[];
  try {
    rawItems = await deps.runActor(CONGRESS_ACTOR_ID, secrets.apifyToken, {
      start_urls: ["https://www.capitoltrades.com/trades?pageSize=96&txDate=90d"],
      max_page: 1,
    });
  } catch (e) {
    console.error("Congress trades Apify run failed:", e);
    return; // leave the existing doc untouched
  }

  const parsed: ParsedTrade[] = [];
  for (const item of rawItems) {
    const t = parseCapitolTrade(item as RawCapitolTrade);
    if (t) parsed.push(t);
  }

  const tickers = Array.from(new Set(parsed.map((t) => t.ticker)));
  const priceByTicker = new Map<string, number>();
  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const quote = await deps.getQuote(ticker, secrets.finnhubKey);
        if (quote) priceByTicker.set(ticker, quote.price);
      } catch {
        // leave this ticker unpriced -> its trades are excluded from the return calc
      }
    })
  );

  const traders = computeCongressRanking(parsed, priceByTicker, now);
  await deps.setDoc({ traders, computedAt: Date.now() });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd functions && npm test -- congress && npm run build`
Expected: PASS, clean build.

- [ ] **Step 5: Wire the real Cloud Function into `index.ts`**

In `functions/src/index.ts`, change:

```typescript
import { getTopCongressTraders } from "./lib/congress.js";
```

to:

```typescript
import { runCongressTradersUpdate } from "./lib/congress.js";
```

Then delete the entire `congressTraders` export at the end of the file:

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

and replace it with:

```typescript
export const congressTradersWeekly = onSchedule(
  { schedule: "every monday 08:00", timeZone: "America/New_York", secrets: [apifyToken, finnhubKey], timeoutSeconds: 1800, memory: "512MiB" },
  async () => {
    const docRef = db.collection("congress").doc("latest");
    await runCongressTradersUpdate(
      { apifyToken: apifyToken.value(), finnhubKey: finnhubKey.value() },
      {
        runActor,
        getQuote,
        setDoc: async (data) => {
          await docRef.set(data);
        },
      }
    );
  }
);
```

- [ ] **Step 6: Add the Firestore security rule**

In `firestore.rules`, change:

```
    match /config/settings {
      allow read, write: if isOwner();
    }
  }
}
```

to:

```
    match /config/settings {
      allow read, write: if isOwner();
    }

    match /congress/{docId} {
      allow read, write: if isOwner();
    }
  }
}
```

- [ ] **Step 7: Add and run the Firestore rules test**

In `firestore-tests/rules.test.ts`, add at the end of the file:

```typescript
describe("congress/{docId}", () => {
  it("owner can read and write", async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(db.doc("congress/latest").set({ traders: [], computedAt: Date.now() }));
    await assertSucceeds(db.doc("congress/latest").get());
  });

  it("stranger cannot read", async () => {
    const db = testEnv.authenticatedContext("someone-else").firestore();
    await assertFails(db.doc("congress/latest").get());
  });

  it("stranger cannot write", async () => {
    const db = testEnv.authenticatedContext("someone-else").firestore();
    await assertFails(db.doc("congress/latest").set({ traders: [] }));
  });

  it("unauthenticated cannot read", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.doc("congress/latest").get());
  });
});
```

Install dependencies if not already present, then run the suite against the Firestore emulator:

Run: `cd firestore-tests && npm install && cd .. && npx --yes firebase-tools emulators:exec --only firestore "cd firestore-tests && npm test"`
Expected: all tests in `rules.test.ts` pass, including the 4 new `congress/{docId}` cases.

- [ ] **Step 8: Run the full functions test suite and build to confirm no regressions**

Run: `cd functions && npm test && npm run build`
Expected: full suite PASS, clean build (this also confirms `liveQuote`/`verifyOwnerAuth` are untouched and still pass).

- [ ] **Step 9: Commit**

```bash
git add functions/src/lib/congress.ts functions/test/congress.test.ts functions/src/index.ts firestore.rules firestore-tests/rules.test.ts
git commit -m "feat: add weekly congressTradersWeekly function, remove HTTP polling endpoint"
```

---

### Task 3: Frontend — real-time Firestore listener

**Files:**
- Modify: `frontend/src/digest.js`
- Modify: `frontend/index.html`

**Interfaces:**
- Consumes: Firestore document `congress/latest` (`{ traders: CongressTrader[]; computedAt: number }` from Task 2), read via a real-time listener — no HTTP call.

No automated test harness exists for the frontend in this repo — this task ends with manual verification instead of automated tests, matching established precedent. The tile HTML/CSS itself is unchanged from v1 (`#congressStrip`, `.idx-card`, `.ip.pos`/`.ip.neg`, `.cc` — already present in `frontend/index.html`, confirmed unchanged by this task).

- [ ] **Step 1: Replace the polling function with a Firestore listener**

In `frontend/src/digest.js`, find the entire `loadCongressTraders` function:

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

and replace it with:

```javascript
export function watchCongressTraders() {
  return onSnapshot(doc(db, "congress", "latest"), (snap) => {
    const el = document.getElementById("congressStrip");
    if (!el || !snap.exists()) return;
    const traders = snap.data().traders || [];
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
  });
}
```

(`doc` and `onSnapshot` are already imported at the top of this file — `import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";` — no new import needed.)

- [ ] **Step 2: Remove the polling wiring from `startLiveStrips`**

In `frontend/src/digest.js`, find:

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

and replace it with:

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

- [ ] **Step 3: Start the listener from the bootstrap script**

In `frontend/index.html`, find:

```html
    import { watchDate, runNow, startLiveStrips } from "./src/digest.js";
```

and replace it with:

```html
    import { watchDate, runNow, startLiveStrips, watchCongressTraders } from "./src/digest.js";
```

Then find:

```html
      document.getElementById("reviewDate").value = todayKey;
      selectDate(todayKey);
      startLiveStrips();
    });
```

and replace it with:

```html
      document.getElementById("reviewDate").value = todayKey;
      selectDate(todayKey);
      startLiveStrips();
      watchCongressTraders();
    });
```

- [ ] **Step 4: Syntax-check and self-review**

Run: `node --check frontend/src/digest.js`
Expected: no output (clean).

Re-read the diff: confirm `loadCongressTraders` no longer exists anywhere in the file, confirm `watchCongressTraders` is exported and follows the same `onSnapshot(doc(db, ...))` shape as `watchDate`, and confirm the tile-rendering template literal is byte-for-byte the same as v1's (same field names, same escaping, same conditional `topHolding` line) — only the data-fetching mechanism changed, not the rendering.

- [ ] **Step 5: Manual verification**

This repo has no frontend test harness, so verify by hand once this is deployed and the weekly function has run at least once:

1. Open the live dashboard, signed in as owner.
2. Confirm the "Congressional Trading · top performers (30-day)" section populates without needing to click "Run analysis" — it should appear as soon as the page loads (reading from Firestore directly), not after any delay or poll interval.
3. Confirm each tile shows a member name, colored return % (green/red by sign), a party/chamber/trade-count caption, and a "Top holding: TICKER" line when applicable.
4. If `congress/latest` doesn't exist yet (the weekly function hasn't run), confirm the section renders as empty/absent rather than showing an error.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/digest.js frontend/index.html
git commit -m "feat: switch congressional trading tiles to a real-time Firestore listener"
```

---

## Post-plan

Once all three tasks are committed:
1. Deploy functions: `npx --yes firebase-tools deploy --only functions --project signal-stock-digest-67e26`.
2. Deploy Firestore rules: `npx --yes firebase-tools deploy --only firestore:rules --project signal-stock-digest-67e26`.
3. Push to `origin/main` for the frontend change (Netlify auto-deploys on push).
4. `congressTradersWeekly` won't populate `congress/latest` until its first scheduled run (next Monday 08:00 America/New_York) or a manual trigger. Manually invoking a scheduled Cloud Function requires either the Firebase Console or `gcloud scheduler jobs run` — decide with the user whether to wait for the natural schedule or trigger it once manually to verify end-to-end (this involves a real, paid Apify run, ~$1 — get explicit go-ahead first, same as every other paid-run decision this session).
