import type { DigestDoc, Extraction, HistoricalMetrics, PeerComparison, QuantFactor, RankedTicker } from "./types.js";
import { rankMentions } from "./ranking.js";
import { screenStock } from "./screen.js";
import { scoreQuant } from "./quant.js";

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
  marketHealth: (
    indexAndMacro: { label: string; price: number; changePct: number }[],
    fred: DigestDoc["fred"],
    cfg: { apiKey: string; model: string }
  ) => Promise<string>;
  getQuote: (sym: string, key: string) => Promise<{ price: number; changePct: number } | null>;
  getFundamentals: (sym: string, key: string) => Promise<RankedTicker["fundamentals"] | null>;
  getProfile: (sym: string, key: string) => Promise<RankedTicker["profile"] | null>;
  getAnalystConsensus: (sym: string, key: string) => Promise<RankedTicker["analyst"] | null>;
  quantExplanation: (sym: string, factors: QuantFactor[], score: number, cfg: { apiKey: string; model: string }) => Promise<string>;
  getPeers: (sym: string, key: string) => Promise<string[]>;
  getHistoricalMetrics: (sym: string, key: string) => Promise<HistoricalMetrics | null>;
  tickerDeepDive: (
    sym: string,
    company: string,
    ctx: {
      price: number | null;
      fundamentals: NonNullable<RankedTicker["fundamentals"]> | null;
      profile: NonNullable<RankedTicker["profile"]> | null;
      analyst: NonNullable<RankedTicker["analyst"]> | null;
      quant: NonNullable<RankedTicker["quant"]> | null;
      historical: HistoricalMetrics | null;
      peers: PeerComparison[];
    },
    cfg: { apiKey: string; model: string }
  ) => Promise<RankedTicker["deepDive"]>;
  sleep: (ms: number) => Promise<void>;
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

async function loadIndexAndMacroQuotes(priceKey: string, deps: PipelineDeps): Promise<{ label: string; price: number; changePct: number }[]> {
  const results = await Promise.all(
    [...INDEX_PROXIES, ...MACRO_PROXIES].map(async (proxy) => {
      try {
        const q = await deps.getQuote(proxy.sym, priceKey);
        return q ? { label: proxy.label, price: q.price, changePct: q.changePct } : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter((r): r is { label: string; price: number; changePct: number } => r !== null);
}

function classifyFred(isWarning: boolean, warningLabel: string): { status: "normal" | "warning"; statusLabel: string } {
  return isWarning ? { status: "warning", statusLabel: warningLabel } : { status: "normal", statusLabel: "normal range" };
}

async function loadFred(secrets: PipelineInput["secrets"], deps: PipelineDeps): Promise<DigestDoc["fred"] | undefined> {
  const [spread, unrate, fedfunds, cpi, claims, indpro] = await Promise.allSettled([
    deps.fredLatest("T10Y2Y", secrets.fredKey),
    deps.fredLatest("UNRATE", secrets.fredKey),
    deps.fredLatest("FEDFUNDS", secrets.fredKey),
    deps.fredYoY("CPIAUCSL", secrets.fredKey),
    deps.fredWithPrior("ICSA", secrets.fredKey),
    deps.fredYoY("INDPRO", secrets.fredKey),
  ]);

  // Each indicator is independent, so one transient FRED failure only drops
  // that indicator instead of wiping the whole strip (matches the isolation
  // pattern used for price/fundamentals/profile/analyst/quant above).
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

  return results.length > 0 ? results : undefined;
}

export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<DigestDoc> {
  const startedAt = Date.now();
  const { secrets } = input;
  const claudeCfg = { apiKey: secrets.aiKey, model: secrets.model };

  let reels: ReelLike[] = [];
  let reelError: string | undefined;
  try {
    const urlList = input.trackedHandles.map((u) => u.trim().replace(/^@/, "")).filter(Boolean);
    const rawReels = await deps.runActor(secrets.actorId, secrets.apifyToken, { username: urlList, resultsLimit: 5, includeTranscript: true });
    reels = Array.isArray(rawReels) ? (rawReels as ReelLike[]) : [];
    reels = reels.filter((v) => isOnDate(getTimestamp(v), input.targetDate));
  } catch (e) {
    // A scrape failure (rate limit, quota, transient network error) only
    // means there's no reel content today — it must not prevent the
    // independent sections below (FRED, market health, market recap) from
    // still computing and being saved.
    reelError = e instanceof Error ? e.message : String(e);
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

  for (const [index, ticker] of ranked.entries()) {
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

    const quant = scoreQuant(ticker.fundamentals ?? null);
    if (quant) {
      ticker.quant = quant;
      try {
        ticker.quant.explanation = await deps.quantExplanation(ticker.sym, quant.factors, quant.score, claudeCfg);
      } catch {
        // leave explanation unset -> UI shows score/breakdown without narrative text
      }
    }

    if (ticker.fundamentals) {
      let peerSyms: string[] = [];
      try {
        peerSyms = await deps.getPeers(ticker.sym, secrets.priceKey);
      } catch {
        // leave peerSyms empty -> deep dive still generates without peer comparison
      }

      const peerResults = await Promise.all(
        peerSyms.map(async (peerSym) => {
          try {
            const pf = await deps.getFundamentals(peerSym, secrets.priceKey);
            return pf ? { sym: peerSym, fundamentals: pf } : null;
          } catch {
            return null;
          }
        })
      );
      const peers = peerResults.filter((p): p is PeerComparison => p !== null);

      let historical: HistoricalMetrics | null = null;
      try {
        historical = await deps.getHistoricalMetrics(ticker.sym, secrets.priceKey);
      } catch {
        historical = null;
      }

      try {
        ticker.deepDive = await deps.tickerDeepDive(
          ticker.sym,
          ticker.company,
          { price: ticker.price ?? null, fundamentals: ticker.fundamentals, profile: ticker.profile ?? null, analyst: ticker.analyst ?? null, quant: ticker.quant ?? null, historical, peers },
          claudeCfg
        );
      } catch {
        // leave deepDive unset -> ticker card just doesn't show the extra section
      }

      // Pace peer-fetch fan-outs between tickers (up to 6 concurrent Finnhub
      // calls just happened above) to avoid bursting past Finnhub's rate
      // limit — same lesson as the Congress-trading feature's chunked/paced
      // Finnhub calls (functions/src/lib/congress.ts:182-198). Injected via
      // deps.sleep (not a bare setTimeout) so tests can make this instant.
      if (index < ranked.length - 1) {
        await deps.sleep(500);
      }
    }
  }

  const screen: DigestDoc["screen"] = {};
  for (const ticker of ranked) {
    const result = screenStock(ticker.fundamentals ?? null, ticker.analyst ?? null);
    if (result) screen[ticker.sym] = result;
  }

  let videoWrap: string | undefined;
  if (ranked.length > 0) {
    try {
      videoWrap = await deps.videoWrap(ranked, input.dateLabel, claudeCfg);
    } catch {
      videoWrap = undefined;
    }
  }

  let marketRecap: string | undefined;
  try {
    const headlines = await deps.getGeneralNews(secrets.priceKey);
    marketRecap = await deps.marketRecap(headlines, input.dateLabel, claudeCfg);
  } catch {
    marketRecap = undefined;
  }

  const fred = await loadFred(secrets, deps);

  let marketHealth: string | undefined;
  try {
    const indexAndMacro = await loadIndexAndMacroQuotes(secrets.priceKey, deps);
    marketHealth = await deps.marketHealth(indexAndMacro, fred, claudeCfg);
  } catch {
    marketHealth = undefined;
  }

  return {
    status: "complete",
    reelError,
    dateLabel: input.dateLabel,
    rankedTickers: ranked,
    screen,
    videoWrap,
    marketRecap,
    marketHealth,
    fred,
    skippedReelCount,
    startedAt,
    completedAt: Date.now(),
  };
}
