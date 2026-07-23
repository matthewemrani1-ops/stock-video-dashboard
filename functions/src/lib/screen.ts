import type { Analyst, Fundamentals, ScreenCheck, ScreenResult } from "./types.js";

export function screenStock(f: Fundamentals | null, an: Analyst | null): ScreenResult | null {
  if (!f && !an) return null;
  const checks: ScreenCheck[] = [];

  if (f && f.pe != null) {
    checks.push({ label: "Valuation (P/E 0–25)", pass: f.pe > 0 && f.pe <= 25, detail: f.pe.toFixed(1) });
  }
  if (an) {
    const total = an.buy + an.hold + an.sell;
    if (total > 0) {
      checks.push({
        label: "Analyst consensus",
        pass: an.buy > an.hold + an.sell,
        detail: `${an.buy} buy / ${an.hold} hold / ${an.sell} sell`,
      });
    }
  }
  if (f && f.beta != null) {
    checks.push({ label: "Stability (beta < 2.5)", pass: f.beta < 2.5, detail: f.beta.toFixed(2) });
  }
  if (checks.length === 0) return null;

  const passed = checks.filter((c) => c.pass).length;
  let verdict: ScreenResult["verdict"];
  if (passed >= Math.ceil(checks.length * 0.66)) verdict = "Pass";
  else if (passed >= Math.ceil(checks.length * 0.33)) verdict = "Watch";
  else verdict = "Caution";

  return { verdict, checks, passed, total: checks.length };
}
