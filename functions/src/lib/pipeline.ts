import type { DigestDoc, Extraction, QuantFactor, RankedTicker } from "./types.js";
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

    const quant = scoreQuant(ticker.fundamentals ?? null);
    if (quant) {
      ticker.quant = quant;
      try {
        ticker.quant.explanation = await deps.quantExplanation(ticker.sym, quant.factors, quant.score, claudeCfg);
      } catch {
        // leave explanation unset -> UI shows score/breakdown without narrative text
      }
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

  let marketHealth: string | undefined;
  try {
    const indexAndMacro = await loadIndexAndMacroQuotes(secrets.priceKey, deps);
    marketHealth = await deps.marketHealth(indexAndMacro, fred, claudeCfg);
  } catch {
    marketHealth = undefined;
  }

  return {
    status: "complete",
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
