# Congressional Trading Tiles — v2 (Revised Data Source)

Date: 2026-07-28
Status: **Approved** — ready for implementation planning.

## Context

This supersedes `docs/superpowers/specs/2026-07-28-congress-trading-tiles-design.md`. That design was fully implemented and task-reviewed (commits `76f4bbae..de0c2d03`, 3 tasks, all approved), but the final whole-branch review discovered its foundational premise was wrong: QuiverQuant's `/live/congresstrading` endpoint, assumed free and unauthenticated, now returns `401 Unauthorized` — confirmed independently via direct `curl`, and corroborated by the user's own unrelated `~/congress_trader/congress_trader.py` cron script, which has failed identically on every run since 2026-06-29. The feature was never deployed.

Two replacement data sources were evaluated:
- **Alpha Vantage** — checked directly against their documentation. No congressional/political trading data exists in their catalog at all. Ruled out.
- **Apify actor "Capitol Trades Scraper"** (actor ID `VyNAX2PeuvQ8UQ7FK`, publisher `saswave`, scrapes capitoltrades.com) — confirmed viable: actively maintained (83k+ total runs, last run ~1 hour before this spec was written, ~81% success rate over the last 30 days). Signal already has an Apify integration (`functions/src/lib/apify.ts`, used for Instagram scraping), so this reuses an existing billing relationship rather than introducing a new one.

Two material differences from the original design follow from this switch:
1. **Cost**: Capitol Trades Scraper is pay-per-result (~$0.01/item on Apify's free tier), roughly $1 for a ~96-item page — not free. This rules out the original 20-minute live-poll cadence (~$70+/day). The user chose **weekly** instead.
2. **Data shape**: capitoltrades.com has no return/performance field. Its real output schema (confirmed from the actor's own published README, not guessed):
   ```json
   {
     "politician_name": "Nancy Pelosi",
     "politician_family": "Democrat House CA",
     "politician_link": "https://www.capitoltrades.com/politicians/P000197",
     "traded_issuer_name": "Microsoft Corp",
     "traded_issuer_ticker": "MSFT:US",
     "traded_issuer_link": "https://www.capitoltrades.com/issuers/433382",
     "published": "31 Jul 2024",
     "traded": "26 Jul 2024",
     "filed_after": "4 days",
     "owner": "Spouse",
     "type": "sell",
     "size": "1M–5M",
     "price": "425.27"
   }
   ```
   There is no `PriceChange` (or equivalent) field, so the original "rank by weighted return" logic has nothing to rank by as-is.

## Scope decisions (settled during this brainstorm)

1. **Ranking metric**: Signal computes its own return, rather than switching to a trade-activity ranking or a plain recent-trades feed. For each qualifying trade, fetch the ticker's current price via the Finnhub integration Signal already uses elsewhere (`functions/src/lib/finnhub.ts`'s `getQuote`, no additional cost — Finnhub is a flat-rate key, not pay-per-call) and compute return since the trade. This preserves the original "top performers" framing. The extra cost of this option is engineering complexity, not money.
2. **Cadence**: weekly, not live-polled. A new `onSchedule` Cloud Function, matching the existing `dailyDigestRun` pattern.
3. **Lookback window**: stays 30 days (not widened to 90), recomputed fresh each week.
4. **Delivery mechanism**: the weekly function writes its result to a single Firestore document; the frontend subscribes with a real-time listener (same pattern `watchDate` already uses for the daily digest) instead of polling an HTTP endpoint. This satisfies "independent of Run analysis" more directly than the original live-poll design — updates happen the instant the weekly job completes, no interval needed at all.
5. **Disposition of the already-built v1 code** (commits `76f4bbae..de0c2d03`, not deployed):
   - **Keep**: the `verifyOwnerAuth` extraction and `liveQuote` refactor from Task 2 — a safe, tested, reviewed improvement (removed duplicated, previously-untested auth logic) that stands on its own merits regardless of this feature's data source.
   - **Discard/replace**: Task 1's `congress.ts` (built for QuiverQuant's data shape, doesn't apply to Capitol Trades' fields), the `congressTraders` HTTP endpoint itself (superseded by the Firestore-listener delivery model), and Task 3's polling frontend code (superseded by a listener).

## Architecture

```
onSchedule (weekly, new function congressTradersWeekly)
        │
        ▼
runActor(actorId, apifyToken, { start_urls: [...], max_page: 1 })
        │  (existing functions/src/lib/apify.ts client — same one
        │   already used for Instagram scraping)
        ▼
parseCapitolTrades(rawItems)  — new pure module, functions/src/lib/congress.ts
        │  filter: type === "buy", traded date within last 30 days, has ticker
        ▼
for each distinct ticker → getQuote(ticker, finnhubKey)  (existing finnhub.ts)
        │  (deduplicated — one call per distinct ticker, not per trade)
        ▼
computeReturns + rank top 10 + compute top holding
        │
        ▼
Firestore doc: congress/latest = { traders: CongressTrader[], computedAt: number }
        │
        ▼
Frontend: onSnapshot(doc(db, "congress", "latest"), ...) — real-time, no polling
```

## Data parsing details

- **Ticker**: `traded_issuer_ticker` is formatted `"MSFT:US"` — strip the `:EXCHANGE` suffix (split on `:`, take the first segment) before using with Finnhub, which expects bare tickers.
- **Party/chamber**: `politician_family` is a combined string like `"Democrat House CA"` — split on whitespace; first token is party, second is chamber, remainder is state (state isn't used in this feature, discarded).
- **Dates**: `published`/`traded` are strings like `"31 Jul 2024"` — parseable with `new Date(...)`, verify parses to a valid date before using; skip trades whose `traded` date fails to parse.
- **Type filter**: `type` is lowercase (`"buy"`/`"sell"`) in the real payload — match case-insensitively regardless, matching the defensive convention used elsewhere in this codebase.
- **Size buckets**: `size` is a string like `"1K–15K"`, `"1M–5M"`, or an open-ended `"50M+"`. Parsed generically (not via a hardcoded lookup table, since the exact bucket boundaries weren't independently re-verified beyond the two confirmed examples): extract each side's numeric value and K/M multiplier, take the midpoint of a two-sided range, or the raw value of an open-ended `"N+"` range (used as a conservative lower-bound estimate). This is intentionally a generic parser so it doesn't break if Capitol Trades' exact bucket boundaries differ slightly from what's assumed.
- **Price**: `price` is a numeric string like `"425.27"`, or may be missing/non-numeric for some trades (observed directly on the live site). Trades with an unparseable price are excluded from the return calculation (but may still count toward `tradeCount` — open question resolved as: excluded entirely from ranking, since a trade with no price can't contribute a return, matching the "only count what we have data for" pattern used throughout this codebase).

## Return and ranking calculation

- Per-trade return: `(currentPrice - tradePrice) / tradePrice * 100`, only for trades with a valid, positive `tradePrice`.
- Per-member weighted return: weighted by each trade's parsed size-bucket midpoint (same "weighted average, fall back to unweighted if total weight is 0" pattern as the original v1 design).
- Rank descending by weighted return, top 10.
- Top holding: same net-purchase-minus-sale-by-ticker logic as v1, using the parsed size-bucket midpoint as the amount (in place of QuiverQuant's exact disclosed `Amount`).

## Data shape (Firestore document `congress/latest`)

```typescript
interface CongressTrader {
  name: string;
  party: string;
  chamber: string;
  returnPct: number;
  tradeCount: number;
  topHolding: string | null;
}

interface CongressDoc {
  traders: CongressTrader[];
  computedAt: number; // Date.now() at the time the weekly function ran
}
```

Same `CongressTrader` shape as v1 — only the computation feeding it changes. `computedAt` is new, so the frontend can show a "last updated" timestamp (mirrors the digest's `startedAt`/`completedAt` pattern).

## Firestore security rule

New rule needed in `firestore.rules`, matching the existing owner-only pattern:

```
match /congress/{docId} {
  allow read, write: if isOwner();
}
```

## Error handling

- Apify actor call fails, times out, or returns unparseable data → the weekly function logs the error (console.error, matching the FRED-indicator logging precedent from earlier this session) and leaves the existing `congress/latest` document untouched — the dashboard keeps showing last week's data rather than going blank, since a transient scrape failure shouldn't erase a week's worth of otherwise-good data. `computedAt` staying stale is the visible signal that a refresh failed.
- A Finnhub `getQuote` failure for one ticker excludes that ticker's trades from the return calculation entirely (their member's other qualifying trades still count) — matches the "one failure doesn't wipe out everything" isolation pattern used throughout this codebase (FRED indicators, ticker fundamentals, etc.).
- If zero members have any qualifying trades with valid data, `congress/latest` is written with `traders: []` — the frontend renders nothing extra for an empty array (no orphan section header with dead space beneath it — this specific failure mode is what made the v1 QuiverQuant outage silent and undetectable, and won't recur here since a stale-but-present document with a visible `computedAt` timestamp is a much clearer signal than "section exists but is permanently empty forever").

## Frontend

Replace v1's polling-based `loadCongressTraders()`/`startLiveStrips()` wiring with a new `watchCongressTraders()` function in `frontend/src/digest.js`, following the exact shape of the existing `watchDate()` (real-time `onSnapshot` listener, not a fetch-based poll). Tile markup and CSS (`.idx-card`, `.ip.pos`/`.ip.neg`, `.cc` caption classes) carry over unchanged from v1's Task 3 design — only the data-fetching mechanism changes, not the visual presentation.

## Testing

- `functions/test/congress.test.ts` (new, replacing v1's file entirely): unit tests for the Capitol Trades parsing (ticker-suffix stripping, party/chamber splitting, date parsing with invalid-date rejection, case-insensitive type matching, the generic size-bucket parser across two-sided and open-ended formats), the return calculation (valid price, missing/invalid price exclusion), the weighted-ranking logic (same weighted/unweighted-fallback shape as v1, retestable with the same style of fixtures), and the top-holding computation.
- A new test file for the scheduled function's orchestration logic (mocked `runActor`/`getQuote`/Firestore write), verifying the "leave the existing doc untouched on failure" behavior specifically, since that's new behavior not present in v1's design.
- No frontend test harness exists in this repo (established precedent) — `watchCongressTraders()` gets manual verification against the live dashboard.
- **Before implementation**: this design's understanding of Capitol Trades' output schema comes from the actor's published README example (real, but a single example, not an exhaustive sample) — implementation should stay defensive about field variations (missing fields, unexpected `size` bucket strings, unparseable dates) rather than assuming the one example generalizes perfectly. Running the actor for a real sample (~$1) during implementation, to check against a live multi-item response, is worthwhile before finalizing test fixtures — but requires the user's explicit go-ahead before spending real money, the same discipline already used this session for triggering paid digest runs.
