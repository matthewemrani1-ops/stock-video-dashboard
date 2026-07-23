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
}

function getText(v: ReelLike): string {
  return v.transcript || v.text || "";
}

function getAuthor(v: ReelLike): string {
  return v.pageName || "Unknown account";
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
    reels = (await deps.runActor(secrets.actorId, secrets.apifyToken, { username: urlList, resultsLimit: 5, includeTranscript: true })) as ReelLike[];
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
