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

const OWNER_UID = "owner-test-uid"; // replaced with the real Firebase Auth UID in Task 10

const apifyToken = defineSecret("APIFY_TOKEN");
const anthropicKey = defineSecret("ANTHROPIC_KEY");
const finnhubKey = defineSecret("FINNHUB_KEY");
const fredKey = defineSecret("FRED_KEY");

export function assertOwner(auth: { uid: string } | undefined): void {
  if (!auth || auth.uid !== OWNER_UID) {
    throw new HttpsError("permission-denied", "permission-denied: not authorized");
  }
}

export function guardOverlap(existing: { status: string } | undefined): void {
  if (existing?.status === "running") {
    throw new HttpsError("already-exists", "already-exists: a run is already in progress for today");
  }
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

async function executeDigestRun(): Promise<void> {
  const db = getFirestore();
  const today = new Date();
  const dateKey = today.toISOString().slice(0, 10);
  const dateLabel = today.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
        targetDate: today,
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
  await executeDigestRun();
  return { ok: true };
});

export const liveQuote = onRequest({ secrets: [finnhubKey] }, async (request, response) => {
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
