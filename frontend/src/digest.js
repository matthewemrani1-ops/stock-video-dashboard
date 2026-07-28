import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { db, functions, auth, FUNCTIONS_BASE_URL } from "./firebase-init.js";

const INDEX_PROXIES = [
  { sym: "SPY", label: "S&P 500" },
  { sym: "DIA", label: "Dow Jones" },
  { sym: "QQQ", label: "Nasdaq 100" },
  { sym: "IWM", label: "Russell 2000" },
];
const MACRO_PROXIES = [
  { sym: "VIXY", label: "Volatility (VIX proxy)" },
  { sym: "TLT", label: "20Y+ Treasuries" },
  { sym: "HYG", label: "High-Yield Credit" },
  { sym: "UUP", label: "US Dollar Index" },
];

function esc(s) {
  return (s || "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}
function viewChip(v) {
  const cls = { buy: "buy", sell: "sell", hold: "hold" }[v] || "count";
  const label = { buy: "Buy", sell: "Sell", hold: "Hold" }[v] || "Mention";
  return `<span class="chip ${cls}">${label}</span>`;
}

function formatFredValue(cd) {
  if (cd.unit === "count-k") {
    return `${Math.round(cd.value / 1000)}K`;
  }
  const sign = cd.unit === "percent-signed" && cd.value >= 0 ? "+" : "";
  return `${sign}${cd.value.toFixed(1)}%`;
}

function renderScreenBlock(screenResult) {
  if (!screenResult) return "";
  return `
    <div class="screen-row">
      <span class="ak">Basic screen — ${screenResult.passed}/${screenResult.total} checks passed</span>
      <div class="screen-checks">
        ${screenResult.checks.map((c) => `<span class="scheck ${c.pass ? "pass" : "fail"}">${c.pass ? "✓" : "✗"} ${esc(c.label)} <span class="scheck-detail">(${esc(c.detail)})</span></span>`).join("")}
      </div>
    </div>`;
}

function renderQuantBlock(quant) {
  if (!quant) return "";
  return `
    <div class="quant-row">
      <span class="ak">Quant score — ${quant.score.toFixed(0)}/100 (${esc(quant.verdict)})</span>
      <div class="quant-factors">
        ${quant.factors.map((f) => `<span class="qfactor">${esc(f.category)}: ${f.score.toFixed(0)}/100 <span class="qfactor-detail">(${esc(f.detail)})</span></span>`).join("")}
      </div>
      ${quant.explanation ? `<div class="quant-explain">${esc(quant.explanation)}</div>` : ""}
      <div class="quant-note">Equal-weighted across available factors — not a backtested model. Not financial advice.</div>
    </div>`;
}

function renderDigest(docData) {
  const results = document.getElementById("results");
  const lastRun = document.getElementById("lastRun");

  if (docData.status === "error") {
    results.innerHTML = `<div class="note"><b>Today's run failed.</b><br>${esc(docData.errorMessage || "unknown error")}</div>`;
    return;
  }
  if (docData.status === "running") {
    results.innerHTML = `<div class="note">Run in progress…</div>`;
    return;
  }

  const ranked = docData.rankedTickers || [];
  const total = ranked.reduce((a, b) => a + b.count, 0);
  let html = `<div class="section-label"><h2>Most discussed — ${esc(docData.dateLabel)}</h2><span>${ranked.length} stocks · ${total} mentions</span></div>`;

  ranked.forEach((s, i) => {
    const counts = {};
    s.takes.forEach((t) => (counts[t.view] = (counts[t.view] || 0) + 1));
    const dom = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "mention";
    const takesHtml = s.takes
      .map(
        (t) => `
      <div class="take">
        <div class="take-top">
          <span class="who">${esc(t.who)}</span>
          ${viewChip(t.view)}
          ${t.buy || t.sell ? `<span class="lvl">${t.buy ? `buy <b>${esc(t.buy)}</b>` : ""}${t.buy && t.sell ? " · " : ""}${t.sell ? `sell <b>${esc(t.sell)}</b>` : ""}</span>` : ""}
        </div>
        ${t.recap ? `<div class="recap">${esc(t.recap)}</div>` : ""}
        ${t.quote ? `<div class="quote">"${esc(t.quote)}"</div>` : ""}
      </div>`
      )
      .join("");

    const f = s.fundamentals;
    const p = s.profile;
    const an = s.analyst;
    const screenResult = docData.screen?.[s.sym];
    const screenChip = screenResult ? `<span class="chip screen-${screenResult.verdict.toLowerCase()}">${screenResult.verdict}</span>` : "";
    const quantChip = s.quant ? `<span class="chip quant-${s.quant.verdict.toLowerCase()}">Quant ${esc(s.quant.verdict)}</span>` : "";
    const fundHtml = f
      ? `
      <div class="fund-row">
        ${f.pe != null ? `<div class="fund"><span class="fk">P/E</span><span class="fv">${f.pe.toFixed(1)}</span></div>` : ""}
        ${f.marketCap != null ? `<div class="fund"><span class="fk">Mkt Cap</span><span class="fv">$${(f.marketCap / 1000).toFixed(1)}B</span></div>` : ""}
        ${f.week52Low != null && f.week52High != null ? `<div class="fund"><span class="fk">52wk Range</span><span class="fv">$${f.week52Low.toFixed(0)}–$${f.week52High.toFixed(0)}</span></div>` : ""}
        ${f.beta != null ? `<div class="fund"><span class="fk">Beta</span><span class="fv">${f.beta.toFixed(2)}</span></div>` : ""}
        ${p && p.industry ? `<div class="fund"><span class="fk">Industry</span><span class="fv">${esc(p.industry)}</span></div>` : ""}
      </div>`
      : `<div class="fund-unavailable">Fundamentals unavailable</div>`;
    const analystHtml = an
      ? `
      <div class="analyst-row">
        <span class="ak">Wall St. analysts (${esc(an.period)})</span>
        <span class="ac buy">${an.buy} buy</span>
        <span class="ac hold">${an.hold} hold</span>
        <span class="ac sell">${an.sell} sell</span>
      </div>`
      : "";

    html += `
      <div class="card ${i === 0 ? "featured" : ""}" id="c${i}">
        <div class="card-head" onclick="document.getElementById('c${i}').classList.toggle('open')">
          <div class="rank">${i + 1}</div>
          <div class="tick"><div class="sym">${esc(s.sym)}</div><div class="co">${esc(s.company || "")}</div></div>
          <div class="headmid"><span class="chip count">${s.count} video${s.count > 1 ? "s" : ""}</span>${viewChip(dom)}${screenChip}${quantChip}</div>
          <div class="price"><div class="p">${s.price ? "$" + s.price.toFixed(2) : "—"}</div><div class="l">${s.price ? "current" : "no price"}</div></div>
          <div class="chev">▾</div>
        </div>
        <div class="card-body"><div class="inner">${renderScreenBlock(screenResult)}${renderQuantBlock(s.quant)}${fundHtml}${analystHtml}${takesHtml}</div></div>
      </div>`;
  });
  results.innerHTML = html;
  if (ranked[0]) document.getElementById("c0").classList.add("open");

  if (docData.videoWrap) {
    document.getElementById("dailySummary").innerHTML = `<div class="ds-head">Video Wrap — ${esc(docData.dateLabel)}</div><div class="ds-body"><p>${esc(docData.videoWrap).replace(/\n\n/g, "</p><p>")}</p></div>`;
  }
  if (docData.marketRecap) {
    document.getElementById("newsSummary").innerHTML = `<div class="ds-head">Market Recap (news) — ${esc(docData.dateLabel)}</div><div class="ds-body"><p>${esc(docData.marketRecap).replace(/\n\n/g, "</p><p>")}</p></div>`;
  }
  if (docData.fred) {
    document.getElementById("fredStrip").innerHTML = docData.fred
      .map((cd) => `<div class="idx-card"><div class="in">${esc(cd.label)}</div><div class="ip">${formatFredValue(cd)}</div><div class="if ${cd.status}">${esc(cd.statusLabel)}</div></div>`)
      .join("");
  }
  if (docData.marketHealth) {
    document.getElementById("macroSummary").innerHTML = `<div class="ds-head">Market Health — what to watch for</div><div class="ds-body"><p>${esc(docData.marketHealth).replace(/\n\n/g, "</p><p>")}</p></div>`;
  }

  const now = new Date();
  lastRun.textContent = now.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function watchDate(dateKey) {
  return onSnapshot(doc(db, "digests", dateKey), (snap) => {
    if (snap.exists()) renderDigest(snap.data());
    else document.getElementById("results").innerHTML = `<div class="note"><b>No digest for ${esc(dateKey)}.</b></div>`;
  });
}

async function loadStrip(list, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) return; // not signed in yet (login gate hasn't resolved) — skip this cycle
  const cards = await Promise.all(
    list.map(async (idx) => {
      try {
        const r = await fetch(`${FUNCTIONS_BASE_URL}/liveQuote?sym=${idx.sym}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const q = await r.json();
        if (q.price == null) return "";
        const up = q.changePct >= 0;
        return `<div class="idx-card">
          <div class="in">${esc(idx.label)}<span class="tick">${esc(idx.sym)}</span></div>
          <div class="ip">$${q.price.toFixed(2)}</div>
          <div class="ic ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(q.changePct).toFixed(2)}%</div>
        </div>`;
      } catch {
        return "";
      }
    })
  );
  el.innerHTML = cards.join("");
}

export function startLiveStrips() {
  const load = () => {
    loadStrip(INDEX_PROXIES, "indicesStrip");
    loadStrip(MACRO_PROXIES, "macroStrip");
  };
  load();
  setInterval(load, 60000);
}

export async function runNow() {
  const runBtn = document.getElementById("runBtn");
  runBtn.disabled = true;
  try {
    const dateKey = document.getElementById("reviewDate").value || undefined;
    const call = httpsCallable(functions, "runNow");
    await call({ dateKey });
  } catch (e) {
    document.getElementById("results").innerHTML = `<div class="note"><b>Couldn't start a run.</b><br>${esc(e.message)}</div>`;
  } finally {
    runBtn.disabled = false;
  }
}
