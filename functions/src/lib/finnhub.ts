import type { Analyst, Fundamentals, Profile } from "./types.js";

const BASE = "https://finnhub.io/api/v1";

export async function getQuote(sym: string, key: string): Promise<{ price: number; changePct: number } | null> {
  const r = await fetch(`${BASE}/quote?symbol=${sym}&token=${encodeURIComponent(key)}`);
  const q = (await r.json()) as { c?: number; dp?: number };
  if (!q || !q.c) return null;
  return { price: q.c, changePct: q.dp ?? 0 };
}

export async function getFundamentals(sym: string, key: string): Promise<Fundamentals | null> {
  const r = await fetch(`${BASE}/stock/metric?symbol=${sym}&metric=all&token=${encodeURIComponent(key)}`);
  const fd = (await r.json()) as { metric?: Record<string, number | undefined> };
  const m = fd?.metric;
  if (!m) return null;
  return {
    pe: m.peNormalizedAnnual ?? m.peTTM ?? null,
    marketCap: m.marketCapitalization ?? null,
    week52High: m["52WeekHigh"] ?? null,
    week52Low: m["52WeekLow"] ?? null,
    beta: m.beta ?? null,
    pb: m.pbAnnual ?? null,
    roe: m.roeTTM ?? null,
    netMargin: m.netProfitMarginTTM ?? null,
    debtToEquity: m["totalDebt/totalEquityAnnual"] ?? null,
    return26Week: m["26WeekPriceReturnDaily"] ?? null,
    return52Week: m["52WeekPriceReturnDaily"] ?? null,
  };
}

export async function getProfile(sym: string, key: string): Promise<Profile | null> {
  const r = await fetch(`${BASE}/stock/profile2?symbol=${sym}&token=${encodeURIComponent(key)}`);
  const pd = (await r.json()) as { name?: string; finnhubIndustry?: string; weburl?: string };
  if (!pd || !pd.name) return null;
  return { industry: pd.finnhubIndustry || null, name: pd.name || null, weburl: pd.weburl || null };
}

export async function getAnalystConsensus(sym: string, key: string): Promise<Analyst | null> {
  const r = await fetch(`${BASE}/stock/recommendation?symbol=${sym}&token=${encodeURIComponent(key)}`);
  const ad = (await r.json()) as { strongBuy?: number; buy?: number; hold?: number; sell?: number; strongSell?: number; period?: string }[];
  if (!Array.isArray(ad) || ad.length === 0) return null;
  const latest = ad[0];
  return {
    buy: (latest.strongBuy || 0) + (latest.buy || 0),
    hold: latest.hold || 0,
    sell: (latest.sell || 0) + (latest.strongSell || 0),
    period: latest.period || "",
  };
}

export async function getGeneralNews(key: string): Promise<{ headline: string; summary?: string }[]> {
  const r = await fetch(`${BASE}/news?category=general&token=${encodeURIComponent(key)}`);
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}
