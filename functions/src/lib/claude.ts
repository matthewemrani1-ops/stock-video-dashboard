import type { Analyst, DeepDive, Extraction, FredIndicator, Fundamentals, HistoricalMetrics, PeerComparison, Profile, QuantFactor, QuantScore, RankedTicker } from "./types.js";

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

export async function marketHealth(
  indexAndMacro: { label: string; price: number; changePct: number }[],
  fred: FredIndicator[] | undefined,
  cfg: ClaudeConfig
): Promise<string> {
  let digest = indexAndMacro.map((d) => `${d.label}: $${d.price.toFixed(2)} (${d.changePct >= 0 ? "+" : ""}${d.changePct.toFixed(2)}% today)`).join("\n");
  if (fred && fred.length > 0) {
    // Include the already-computed statusLabel (not just the raw value and
    // explanatory note) so Claude doesn't have to infer sign/direction
    // itself — it was previously calling a positive 10Y-2Y spread "inverted".
    digest += "\n" + fred.map((d) => `${d.label}: ${d.value.toFixed(2)} — ${d.statusLabel} (${d.note})`).join("\n");
  }

  const sys = `You are explaining market health indicators on a personal dashboard for someone who is not a professional trader. Given today's readings for major indices, macro proxy ETFs (VIXY as a volatility/fear proxy, TLT as long Treasuries — rises when investors seek safety, HYG as high-yield credit — falls when credit stress rises, UUP as the dollar index), and where available: the 10Y-2Y Treasury yield spread (negative/inverted has historically preceded recessions), the unemployment rate, the Fed funds rate, CPI inflation (year-over-year, above ~3% is elevated vs. the Fed's ~2% target), initial jobless claims (a fast-moving weekly labor market signal — rising claims can signal labor weakness), and industrial production (year-over-year, negative = manufacturing contraction), write:
1. A 2-3 sentence plain-English read on what today's levels suggest about market mood and valuation (risk-on bull conditions vs. risk-off/recession-warning conditions).
2. A short "what to watch for" note: 2-3 concrete signs someone should look for in these same indicators if conditions were shifting toward a recession, versus signs of a healthy bull market.
Plain text, no headers, no markdown, 2 short paragraphs max. Be educational, not alarmist. Do not give investment advice.`;

  return (await callClaude(sys, digest, 400, cfg)).trim();
}

export async function quantExplanation(sym: string, factors: QuantFactor[], score: number, cfg: ClaudeConfig): Promise<string> {
  const digest = factors.map((f) => `${f.category}: ${f.score.toFixed(0)}/100 (${f.detail})`).join("\n");

  const sys = `You are writing a short factual explanation of a quantitative stock score for a personal dashboard. You will be given a ticker's composite quant score (0-100, made up of up to four equally-weighted factor categories: Value, Quality, Momentum, Low-Volatility) and the underlying metric values behind each factor. Write a 2-3 sentence explanation of what's driving the score, grounded STRICTLY in these numbers — do not add your own independent opinion, prediction, or buy/sell recommendation. Plain text, no headers, no markdown.`;

  return (await callClaude(sys, `${sym} — composite score ${score.toFixed(0)}/100\n${digest}`, 200, cfg)).trim();
}

export interface DeepDiveContext {
  price: number | null;
  fundamentals: Fundamentals | null;
  profile: Profile | null;
  analyst: Analyst | null;
  quant: QuantScore | null;
  historical: HistoricalMetrics | null;
  peers: PeerComparison[];
}

export async function tickerDeepDive(sym: string, company: string, ctx: DeepDiveContext, cfg: ClaudeConfig): Promise<DeepDive | undefined> {
  const lines: string[] = [`${sym} (${company || sym})${ctx.price != null ? ` — current price $${ctx.price.toFixed(2)}` : ""}`];

  if (ctx.fundamentals) {
    const f = ctx.fundamentals;
    lines.push(
      `Current fundamentals: P/E ${f.pe ?? "n/a"}, P/B ${f.pb ?? "n/a"}, ROE ${f.roe ?? "n/a"}%, net margin ${f.netMargin ?? "n/a"}%, debt/equity ${f.debtToEquity ?? "n/a"}, beta ${f.beta ?? "n/a"}, 52wk range $${f.week52Low ?? "n/a"}-$${f.week52High ?? "n/a"}`
    );
  }
  if (ctx.analyst) {
    lines.push(`Analyst consensus (${ctx.analyst.period}): ${ctx.analyst.buy} buy, ${ctx.analyst.hold} hold, ${ctx.analyst.sell} sell`);
  }
  if (ctx.quant) {
    lines.push(`Quant score: ${ctx.quant.score.toFixed(0)}/100 (${ctx.quant.verdict}) — ${ctx.quant.factors.map((fa) => `${fa.category} ${fa.score.toFixed(0)}/100`).join(", ")}`);
  }
  if (ctx.historical) {
    const trend = (label: string, points: { period: string; value: number }[]) =>
      points.length > 0 ? `${label}: ${points.map((p) => `${p.period.slice(0, 4)}=${p.value.toFixed(2)}`).join(", ")}` : null;
    const historyLines = [
      trend("Net margin (5yr)", ctx.historical.netMargin),
      trend("Gross margin (5yr)", ctx.historical.grossMargin),
      trend("ROIC (5yr)", ctx.historical.roic),
      trend("Net Debt/Equity (5yr)", ctx.historical.netDebtToEquity),
      trend("P/E (5yr)", ctx.historical.pe),
      trend("P/B (5yr)", ctx.historical.pb),
      trend("P/FCF (5yr)", ctx.historical.pfcf),
    ].filter((l): l is string => l !== null);
    if (historyLines.length > 0) lines.push("5-year history (most recent first):\n" + historyLines.join("\n"));
  }
  if (ctx.peers.length > 0) {
    lines.push("Peers:\n" + ctx.peers.map((p) => `${p.sym}: P/E ${p.fundamentals.pe ?? "n/a"}, P/B ${p.fundamentals.pb ?? "n/a"}, net margin ${p.fundamentals.netMargin ?? "n/a"}%`).join("\n"));
  }

  const sys = `You are writing a 7-section equity research teardown for a personal investing dashboard, grounded in the real data given below plus your own general knowledge of the company and industry. Return ONLY a JSON object with exactly these keys, no prose, no code fences:
{
  "businessTeardown": "2-4 sentences: how the company actually makes money, who its customers are, and what its competitive moat is (or the lack of one). Be specific, not generic.",
  "financialHealth": "2-4 sentences on the 5-year margin and ROIC trend, whether free cash flow is running above or below reported net income (compare the P/E and P/FCF multiples given — if P/FCF is meaningfully higher than P/E, free cash flow is running below net income, and vice versa), and the debt/equity trend. State whether the business is getting stronger or weaker overall.",
  "valuation": "2-4 sentences comparing the stock's CURRENT valuation multiples to its OWN 3-5 year historical average, and to the named peer companies given below. Name the peer tickers and their multiples directly.",
  "bearCase": "Exactly three distinct, credible reasons this stock could drop roughly 40% from here. No hedging, no bull-case caveats — argue only this side.",
  "catalysts": "1-3 sentences naming a SPECIFIC event or timeframe in the next 12 months that could force the market to re-rate this stock. If you genuinely can't identify one, say so plainly instead of inventing one.",
  "positionSizing": "1-2 sentences giving a portfolio-PERCENTAGE sizing guideline (never a dollar amount) such that the bear case above would cost less than roughly 2% of a portfolio if it played out.",
  "quarterlyReview": {"verdict": "Buy or Pass", "reasoning": "1-2 sentences: if you didn't already own this stock, would you buy it today at this price? Answer plainly."}
}
Ground every numeric claim in the real data provided — do not invent specific numbers not given to you. This is not financial advice; the reader understands that.`;

  let out = await callClaude(sys, lines.join("\n\n"), 1400, cfg);
  out = out.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start >= 0 && end > start) out = out.slice(start, end + 1);

  try {
    const parsed = JSON.parse(out);
    const valid =
      typeof parsed.businessTeardown === "string" &&
      typeof parsed.financialHealth === "string" &&
      typeof parsed.valuation === "string" &&
      typeof parsed.bearCase === "string" &&
      typeof parsed.catalysts === "string" &&
      typeof parsed.positionSizing === "string" &&
      parsed.quarterlyReview &&
      (parsed.quarterlyReview.verdict === "Buy" || parsed.quarterlyReview.verdict === "Pass") &&
      typeof parsed.quarterlyReview.reasoning === "string";
    return valid ? (parsed as DeepDive) : undefined;
  } catch {
    return undefined;
  }
}
