# Congressional Trading Tiles

Date: 2026-07-28
Status: **Approved** — ready for implementation planning.

## Context

The user wants to see what political figures are buying/selling on the Signal dashboard, as a new tile section below "Economic Indicators." An existing personal script, `~/congress_trader/congress_trader.py` (unrelated repo, runs on its own cron job — mirrors the top-performing member's positions into an Alpaca paper account and emails a daily summary), already solves the data-sourcing problem: it pulls congressional trade disclosures from QuiverQuant's free, unauthenticated API (`https://api.quiverquant.com/beta/live/congresstrading`) and ranks members by a 30-day weighted return on their disclosed purchases. This spec ports that ranking logic into Signal's own backend rather than reusing the Python script directly (different runtime — TypeScript/Firebase Functions vs. standalone Python/cron).

One correction made relative to the source script: its ranking is actually computed over a 30-day lookback (`LOOKBACK_DAYS = 30`), but its email UI mislabels it "24-Month Weighted Return." Signal's version keeps the 30-day computation but labels it correctly.

## Scope decision

Initially scoped like the FRED section (computed once per digest run, stored on the digest document), but the user explicitly wants these tiles to behave like the **Major Indices / Volatility & Credit** tiles instead — auto-updating independent of "Run analysis," not gated behind a digest run. This changes the architecture: instead of extending `loadFred`-style pipeline logic, this is a new standalone live-polled section, decoupled entirely from `runPipeline`/`DigestDoc`. Congressional trade disclosures update far less often than stock quotes (weeks-long legal filing lag vs. real-time price moves), so the poll interval is 20 minutes, not the existing strips' 60 seconds.

## Architecture

```
Browser (digest.js, on page load + every 20 min)
        │  GET /congressTraders  (Authorization: Bearer <owner ID token>)
        ▼
congressTraders  (new onRequest Cloud Function, functions/src/index.ts)
        │  same owner-auth pattern as the existing liveQuote function:
        │  CORS headers, verify Firebase ID token, check OWNER_UID
        ▼
getTopCongressTraders()  (new pure-ish module, functions/src/lib/congress.ts)
        │  fetches QuiverQuant /live/congresstrading (no auth), filters to
        │  last 30 days of "Purchase" transactions, computes weighted
        │  return per member, ranks descending, takes top 10, computes
        │  each member's largest net open position ("top holding")
        ▼
JSON response → rendered as 10 tiles in a new dashboard section
```

No new secrets — the QuiverQuant endpoint used here is public and unauthenticated (confirmed in the existing script: no API key sent). No changes to `runPipeline`, `DigestDoc`, or any Firestore document — this data is never persisted, matching how the Major Indices/Volatility strips already work (live-fetched, never stored).

## Ranking logic

Ported from `congress_trader.py`'s `rank_members_by_return`/`get_top_performer_positions`, generalized from "just the #1 performer" to "the top 10":

1. Fetch all trades from `/live/congresstrading`.
2. Filter to trades where `TransactionDate` is within the last 30 days, `Transaction` contains "purchase" (case-insensitive), `Ticker` is non-empty, and `TickerType === "ST"` (common stock — excludes options/other instrument types, matching the source script).
3. Group by `Representative`. For each, compute the `Amount`-weighted average of `PriceChange` — this is the 30-day weighted return.
4. Sort descending by weighted return, take the top 10.
5. For each of those 10, separately compute their largest net open position: sum `Amount` for purchases minus `Amount` for sales per ticker (same lookback window), keep only positive net exposure, take the largest by net amount — this is their "top holding."

## Data shape

```typescript
interface CongressTrader {
  name: string;           // Representative
  party: string;          // e.g. "D", "R", "I"
  chamber: string;        // e.g. "House", "Senate"
  returnPct: number;      // 30-day weighted return, e.g. 18.3 for +18.3%
  tradeCount: number;     // number of qualifying purchase disclosures in the window
  topHolding: string | null;  // largest net-open-position ticker, or null if none
}
```

The `congressTraders` function returns `CongressTrader[]` (always an array, length 0-10; empty array if the QuiverQuant fetch fails or no qualifying data exists — the frontend renders nothing for an empty response, same as a failed index-quote card today).

## Frontend rendering

New section "CONGRESSIONAL TRADING · TOP PERFORMERS (30-DAY)" below "ECONOMIC INDICATORS · FRED", using the existing `.idx-card` tile styling (same grid, same card look as every other strip on the page — no new visual language introduced). Each tile shows:
- Member name (`.in`)
- Return %, sign-prefixed, colored green/red by sign, reusing `--pos`/`--neg` (`.ip`)
- A caption line: party/chamber and trade count, e.g. "D · House · 4 trades" (`.if`-style caption, styled neutral/faint — no normal/warning semantics here, this isn't a threshold check like FRED)
- Top holding ticker as a second small caption line, or omitted entirely if `topHolding` is null

`loadCongressTraders()` in `digest.js` follows the same shape as the existing `loadStrip()`: fetch on page load, `setInterval(loadCongressTraders, 20 * 60 * 1000)` thereafter. Reuses the existing `Authorization: Bearer <idToken>` pattern already used for `liveQuote` calls.

## Error handling

- `congress.ts`'s QuiverQuant fetch failure → `congressTraders` function returns an empty array (HTTP 200, `[]`), not a 5xx — matches the "degrade gracefully, never break the page" precedent used everywhere else in this app.
- Frontend fetch failure (network error, non-owner auth failure, etc.) → the section's container simply isn't populated, exactly like a failed `loadStrip` card today; no error banner, no broken layout.
- No retries beyond the natural next poll cycle (20 minutes) — matches the existing live-strip behavior, no new retry logic introduced.

## Testing

- `functions/test/congress.test.ts` (new): unit tests for the ranking/top-holding computation logic against mocked QuiverQuant responses — covers weighted-return calculation, the top-10 cutoff, the "Purchase" transaction filter, the `TickerType === "ST"` filter, and the top-holding net-position calculation (including a member with no positive net exposure, where `topHolding` should be `null`).
- `functions/test/index.test.ts`: extend with auth-wiring tests for the new `congressTraders` HTTP function, matching the existing coverage pattern for `liveQuote` (missing/malformed Authorization header, invalid token, non-owner UID) if such coverage already exists for `liveQuote`; otherwise this is new coverage added consistent with that function's actual behavior.
- No frontend test harness exists in this repo (established precedent) — `loadCongressTraders()` and its rendering get manual verification against the live dashboard, same as every other frontend change this session.
