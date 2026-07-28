import type { Fundamentals, QuantFactor, QuantScore } from "./types.js";

// Linear interpolation between a "good" value (scores 100) and a "bad" value
// (scores 0), clamped to [0, 100]. Works for both "lower is better" metrics
// (pass good < bad, e.g. P/E) and "higher is better" metrics (pass good > bad, e.g. ROE).
function linearScore(value: number, good: number, bad: number): number {
  const t = (value - bad) / (good - bad);
  const rawScore = Math.max(0, Math.min(100, t * 100));
  // Round to 2 decimal places to avoid floating-point precision issues
  return Math.round(rawScore * 100) / 100;
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function computeValueFactor(f: Fundamentals): QuantFactor | null {
  const scores: number[] = [];
  const details: string[] = [];
  if (f.pe != null && f.pe > 0) {
    scores.push(linearScore(f.pe, 10, 40));
    details.push(`P/E ${f.pe.toFixed(1)}`);
  }
  if (f.pb != null && f.pb > 0) {
    scores.push(linearScore(f.pb, 1, 8));
    details.push(`P/B ${f.pb.toFixed(1)}`);
  }
  if (scores.length === 0) return null;
  return { category: "Value", score: avg(scores), detail: details.join(", ") };
}

export function computeQualityFactor(f: Fundamentals): QuantFactor | null {
  const scores: number[] = [];
  const details: string[] = [];
  if (f.roe != null) {
    scores.push(linearScore(f.roe, 25, 0));
    details.push(`ROE ${f.roe.toFixed(1)}%`);
  }
  if (f.netMargin != null) {
    scores.push(linearScore(f.netMargin, 20, 0));
    details.push(`Net margin ${f.netMargin.toFixed(1)}%`);
  }
  if (f.debtToEquity != null) {
    scores.push(linearScore(f.debtToEquity, 0.3, 2.5));
    details.push(`D/E ${f.debtToEquity.toFixed(2)}`);
  }
  if (scores.length === 0) return null;
  return { category: "Quality", score: avg(scores), detail: details.join(", ") };
}

export function computeMomentumFactor(f: Fundamentals): QuantFactor | null {
  const scores: number[] = [];
  const details: string[] = [];
  if (f.return26Week != null) {
    scores.push(linearScore(f.return26Week, 30, -20));
    details.push(`26wk ${f.return26Week >= 0 ? "+" : ""}${f.return26Week.toFixed(1)}%`);
  }
  if (f.return52Week != null) {
    scores.push(linearScore(f.return52Week, 30, -20));
    details.push(`52wk ${f.return52Week >= 0 ? "+" : ""}${f.return52Week.toFixed(1)}%`);
  }
  if (scores.length === 0) return null;
  return { category: "Momentum", score: avg(scores), detail: details.join(", ") };
}

export function computeLowVolFactor(f: Fundamentals): QuantFactor | null {
  if (f.beta == null) return null;
  return { category: "Low-Volatility", score: linearScore(f.beta, 0.8, 2.0), detail: `Beta ${f.beta.toFixed(2)}` };
}

export function scoreQuant(f: Fundamentals | null): QuantScore | null {
  if (!f) return null;
  const factors = [computeValueFactor(f), computeQualityFactor(f), computeMomentumFactor(f), computeLowVolFactor(f)].filter(
    (x): x is QuantFactor => x !== null
  );
  if (factors.length === 0) return null;

  const score = avg(factors.map((x) => x.score));
  let verdict: QuantScore["verdict"];
  if (score >= 75) verdict = "Strong";
  else if (score >= 40) verdict = "Mixed";
  else verdict = "Weak";

  return { score, verdict, factors };
}
