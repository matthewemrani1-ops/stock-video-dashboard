import type { Extraction, RankedTicker } from "./types.js";

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
