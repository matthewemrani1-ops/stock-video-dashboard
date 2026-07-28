import type { Extraction, QuantFactor, RankedTicker } from "./types.js";

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
  fred: { label: string; value: number; note: string }[] | undefined,
  cfg: ClaudeConfig
): Promise<string> {
  let digest = indexAndMacro.map((d) => `${d.label}: $${d.price.toFixed(2)} (${d.changePct >= 0 ? "+" : ""}${d.changePct.toFixed(2)}% today)`).join("\n");
  if (fred && fred.length > 0) {
    digest += "\n" + fred.map((d) => `${d.label}: ${d.value.toFixed(2)} (${d.note})`).join("\n");
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
