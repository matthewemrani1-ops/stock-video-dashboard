export interface Extraction {
  ticker: string;
  company: string;
  view: "buy" | "sell" | "hold" | "mention";
  buyLevel: string;
  sellLevel: string;
  recap: string;
  quote: string;
}

export interface Take {
  who: string;
  view: "buy" | "sell" | "hold" | "mention";
  buy: string;
  sell: string;
  recap: string;
  quote: string;
}

export interface Fundamentals {
  pe: number | null;
  marketCap: number | null;
  week52High: number | null;
  week52Low: number | null;
  beta: number | null;
  pb: number | null;
  roe: number | null;
  netMargin: number | null;
  debtToEquity: number | null;
  return26Week: number | null;
  return52Week: number | null;
}

export interface QuantFactor {
  category: "Value" | "Quality" | "Momentum" | "Low-Volatility";
  score: number;
  detail: string;
}

export interface QuantScore {
  score: number;
  verdict: "Strong" | "Mixed" | "Weak";
  factors: QuantFactor[];
  explanation?: string;
}

export interface Profile {
  industry: string | null;
  name: string | null;
  weburl: string | null;
}

export interface Analyst {
  buy: number;
  hold: number;
  sell: number;
  period: string;
}

export interface RankedTicker {
  sym: string;
  company: string;
  takes: Take[];
  count: number;
  price?: number;
  fundamentals?: Fundamentals;
  profile?: Profile;
  analyst?: Analyst;
  quant?: QuantScore;
}

export interface ScreenCheck {
  label: string;
  pass: boolean;
  detail: string;
}

export interface ScreenResult {
  verdict: "Pass" | "Watch" | "Caution";
  checks: ScreenCheck[];
  passed: number;
  total: number;
}

export interface DigestDoc {
  status: "running" | "complete" | "error";
  errorMessage?: string;
  dateLabel: string;
  rankedTickers: RankedTicker[];
  screen: Record<string, ScreenResult>;
  videoWrap?: string;
  marketRecap?: string;
  marketHealth?: string;
  fred?: { label: string; value: number; note: string }[];
  skippedReelCount: number;
  startedAt: number;
  completedAt?: number;
}
