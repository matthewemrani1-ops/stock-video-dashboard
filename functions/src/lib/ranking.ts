import type { Extraction, RankedTicker, Take } from "./types.js";

export function rankMentions(extractions: (Extraction & { who: string })[]): RankedTicker[] {
  const mentions: Record<string, { company: string; takes: Take[] }> = {};

  for (const it of extractions) {
    const sym = (it.ticker || "").toUpperCase().replace(/[^A-Z.]/g, "");
    if (!sym) continue;
    if (!mentions[sym]) mentions[sym] = { company: it.company || "", takes: [] };
    if (!mentions[sym].company && it.company) mentions[sym].company = it.company;
    mentions[sym].takes.push({
      who: it.who,
      view: it.view || "mention",
      buy: it.buyLevel || "",
      sell: it.sellLevel || "",
      recap: it.recap || "",
      quote: it.quote || "",
    });
  }

  return Object.entries(mentions)
    .map(([sym, d]) => ({ sym, ...d, count: d.takes.length }))
    .sort((a, b) => b.count - a.count);
}
