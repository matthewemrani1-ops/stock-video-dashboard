# Signal — Cloud Pipeline Design (Phase 1)

Date: 2026-07-23
Status: Approved, ready for implementation planning

## Context

"Signal" is a daily stock-research tool: it scrapes stock-related Instagram
Reels, extracts ticker mentions via AI, ranks them by frequency, and surfaces
fundamentals, analyst sentiment, and market/macro context. The existing
version (`stock-video-dashboard_23.html` in `~/Downloads`) is a single
1,100-line HTML file that runs entirely client-side, with API keys in
`localStorage` and a manual "Run analysis" button.

The goal of this phase is to turn that prototype into a real hosted web app,
usable from a phone, that runs the pipeline automatically once a day and
keeps a browsable history. This is Phase 1 of a two-phase plan — Phase 1
keeps today's simple Pass/Watch/Caution screen for the buy/sell read; a
sophisticated "quant" recommendation engine is an explicitly separate,
later phase (its own design cycle), deferred so this phase stays focused on
getting the plumbing right.

The prototype's "Copy OpenAlice prompt" button (a manual clipboard bridge to
a local OpenAlice instance for deeper research) is carried over unchanged as
a stopgap until the Phase 2 quant engine exists.

## Scope decisions (from brainstorming)

- **Access**: single-user app (just the owner), gated by Firebase Auth
  (Google sign-in) restricted to one allow-listed account.
- **Feature parity**: full carryover from the prototype — ranked ticker
  digest, live index/macro proxy strip, FRED economic-indicators row, Video
  Wrap + Market Recap AI summaries, Copy OpenAlice prompt button.
- **Trigger model**: automatic daily run on a configurable schedule, plus a
  manual "Run now" override in the UI.
- **History**: full history kept in Firestore, browsable via the existing
  date-picker UI (not just "today").
- **Stack**: Firebase (Cloud Functions, Firestore, Auth, Secret Manager) for
  compute/data/auth; Netlify hosts the static frontend.

## Architecture

```
Cloud Scheduler (daily, time configured in config/settings)
        │
        ▼
Firebase Cloud Function: dailyDigestRun (2nd gen, long timeout)
   Apify → Claude (extract) → rank → Finnhub → FRED → Claude (summaries)
        │
        ▼
   Firestore: digests/{YYYY-MM-DD}

Firebase Callable Function: runNow  ──(same pipeline, auth-gated)──┘

Netlify (static SPA, Firebase JS SDK client)
   ├─ Firebase Auth: Google sign-in, allow-listed to owner's account only
   ├─ Reads digests/{date} directly from Firestore (live-updates via listener)
   └─ Calls runNow() when the user taps "Run now"

Secrets (Apify token, Anthropic key, Finnhub key, FRED key) → Firebase Secret
Manager, never sent to the browser.
```

Two deliberate changes from the prototype:

1. **The Cloudflare Worker FRED proxy is retired.** It existed only to work
   around browser CORS restrictions on FRED's API. Once FRED calls happen
   server-side inside the Cloud Function, that restriction doesn't apply.
2. **A new thin proxy function (`liveQuote`) is added** for the 60s-refresh
   index/macro ticker strip, since the Finnhub key can no longer live in the
   browser. At single-user scale this is effectively free (well inside
   Firebase's free tier).

Cloud Functions were chosen over Netlify Scheduled Functions for the daily
job specifically because the Apify step uses an async start-and-poll pattern
to avoid timeouts on long scraper runs — Firebase 2nd-gen functions support
execution times up to 60 minutes, comfortably fitting that pattern, where
Netlify's serverless functions have tighter execution-time limits.

## Components

### Firestore schema

- **`digests/{YYYY-MM-DD}`** — one document per day:
  - `status`: `"running" | "complete" | "error"`
  - `errorMessage`: string, present only when `status: "error"`
  - `rankedTickers`: array of `{ symbol, company, mentionCount, dominantSentiment, mentions: [{ view, priceLevel, recap, quote }] }`
  - `fundamentals`: map keyed by symbol → Finnhub quote/profile/analyst-consensus data (or `{ unavailable: true }` if that ticker's Finnhub calls failed)
  - `screen`: map keyed by symbol → Pass/Watch/Caution result
  - `videoWrap`: string (AI summary)
  - `marketRecap`: string (AI summary)
  - `indexSnapshot`, `macroSnapshot`: proxy quotes at run time
  - `fred`: FRED indicators snapshot
  - `skippedReelCount`: number
  - `startedAt`, `completedAt`: timestamps

- **`config/settings`** — single document:
  - `trackedHandles`: string[] (Instagram handles to scrape)
  - `scheduleTime`: string (e.g. `"07:00"`, owner's local time)
  - `topN`: number (ticker cutoff for deep analysis)

No per-user collections — this is a single-user app.

### Cloud Functions

- **`dailyDigestRun`** — Pub/Sub-triggered by Cloud Scheduler at
  `config/settings.scheduleTime`. Runs the full pipeline, writes to
  `digests/{today}`.
- **`runNow`** — callable, requires the owner's auth UID. Runs the identical
  pipeline on demand. Before starting, checks `digests/{today}.status`; if
  already `"running"`, refuses rather than starting a duplicate run (avoids
  double-billing Apify).
- **`liveQuote`** — lightweight HTTP function, proxies Finnhub quote
  requests for the 60s-refresh index/macro strip using the server-side key.
- **`lib/`** internal modules, shared by `dailyDigestRun` and `runNow`:
  `apify.ts`, `claude.ts`, `finnhub.ts`, `fred.ts`, `ranking.ts`,
  `screen.ts` (Pass/Watch/Caution formula). These are extracted from the
  logic currently inline in the prototype's HTML file.

### Frontend (Netlify, static SPA)

- Login gate — Google sign-in via Firebase Auth; any account other than the
  allow-listed owner account is rejected.
- Digest view — ranked ticker cards, Video Wrap / Market Recap, index/macro
  strip, FRED row, Copy OpenAlice prompt button, date picker for history.
  Reads via a live Firestore listener on `digests/{date}` instead of doing
  any computation client-side.
- Settings view — edit `trackedHandles`, `scheduleTime`, `topN`; writes to
  `config/settings` (owner-only, enforced by security rules).
- "Run now" button — calls `runNow`, reflects the doc's `status` live while
  `"running"`.

## Data Flow (one full day's run)

1. Cloud Scheduler fires at the configured time → publishes to Pub/Sub →
   triggers `dailyDigestRun`.
2. Function creates `digests/{today}` with `status: "running"`, reads
   `trackedHandles` and `topN` from `config/settings`.
3. Apify actor call (start + poll) scrapes reels + transcripts for the
   tracked handles, filtered to today's date.
4. Each transcript goes through Claude Haiku extraction → ticker, sentiment,
   price levels mentioned, recap, quote.
5. Mentions aggregated and ranked by frequency; top N selected.
6. Finnhub calls per top ticker: quote, fundamentals, company profile,
   analyst consensus.
7. Pass/Watch/Caution score computed per ticker (same formula as the
   prototype, now server-side).
8. Claude generates Video Wrap (from the day's takes) and Market Recap (from
   Finnhub news headlines).
9. Index/macro proxies (SPY/DIA/QQQ/IWM, VIXY/TLT/HYG/UUP) and FRED
   indicators fetched directly (no Cloudflare Worker hop).
10. Full digest written to `digests/{today}`, `status: "complete"`.
11. If the app is open, a live Firestore listener on that doc surfaces the
    digest without a manual refresh. If not, it's there next time the app
    opens.
12. While viewing, the index/macro strip polls `liveQuote` every 60s,
    independent of the daily digest doc.

`runNow` follows steps 2–10 identically, triggered by a UI tap instead of
the scheduler, with the overlap guard described above at step 2.

## Error Handling

- **Apify scrape fails or times out** → caught, `digests/{today}` set to
  `status: "error"` with `errorMessage`. Does **not** touch or fall back to
  a prior day's document — history stays intact. UI shows a clear failure
  state with a "Run now" retry.
- **Claude extraction fails on one transcript** → that reel is skipped and
  counted in `skippedReelCount`; the run continues with the rest.
- **Finnhub fails for one ticker** → that ticker still appears in
  `rankedTickers` (mention data unaffected) but its `fundamentals` entry is
  `{ unavailable: true }` instead of blocking the whole digest.
- **FRED fetch fails** → `fred` field reflects unavailability; rest of the
  digest is unaffected.
- **Overlapping runs** — `runNow` checks `status` first; refuses to start a
  duplicate run if one is already `"running"`.
- **Auth** — `runNow` and `liveQuote` verify the Firebase ID token belongs
  to the allow-listed UID; anything else is rejected. Firestore security
  rules mirror this for direct reads/writes.

## Testing

- **Unit tests** (no network): ranking/aggregation logic, the
  Pass/Watch/Caution scoring formula, digest-doc shape validation. Run in
  CI cheaply and often.
- **Firebase Emulator Suite** (Functions + Firestore + Auth): integration
  tests for pipeline wiring, with Apify/Claude/Finnhub/FRED calls stubbed
  via fixture responses — never hits paid APIs or real rate limits.
- **One real end-to-end smoke test per deploy** — trigger `runNow` for real
  against the live Firebase project after deploying, confirm the digest doc
  shape and that the Netlify frontend renders it. The only step that costs
  real API calls, so it's manual/deliberate, not part of automated CI.

## Explicitly out of scope for this phase

- The sophisticated "quant" buy/sell recommendation engine — Phase 2, its
  own design cycle.
- Multi-user support, per-user settings, or public sign-up.
- Any deeper OpenAlice integration beyond the existing copy-to-clipboard
  prompt button.
