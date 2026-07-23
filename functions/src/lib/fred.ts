interface FredObservation {
  value: number;
  date: string;
}

function fredUrl(seriesId: string, apiKey: string, start: string, end: string): string {
  return `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&observation_start=${start}&observation_end=${end}`;
}

interface RawObservation {
  value: string;
  date: string;
}

async function fetchObservations(seriesId: string, apiKey: string, start: string, end: string): Promise<RawObservation[]> {
  const r = await fetch(fredUrl(seriesId, apiKey, start, end));
  if (!r.ok) throw new Error("FRED " + r.status);
  const d = (await r.json()) as { observations?: RawObservation[] };
  return d.observations || [];
}

export async function fredLatest(seriesId: string, apiKey: string): Promise<FredObservation> {
  const end = new Date().toISOString().slice(0, 10);
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 1);
  const start = startDate.toISOString().slice(0, 10);

  const obs = await fetchObservations(seriesId, apiKey, start, end);
  for (const o of obs) {
    if (o.value !== "." && o.value != null) return { value: parseFloat(o.value), date: o.date };
  }
  throw new Error("no data");
}

export async function fredYoY(seriesId: string, apiKey: string): Promise<FredObservation> {
  const end = new Date().toISOString().slice(0, 10);
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 2);
  const start = startDate.toISOString().slice(0, 10);

  const obs = (await fetchObservations(seriesId, apiKey, start, end)).filter((o) => o.value !== "." && o.value != null);
  if (obs.length === 0) throw new Error("no data");
  const latest = obs[0];
  const latestDate = new Date(latest.date);
  const targetDate = new Date(latestDate);
  targetDate.setFullYear(targetDate.getFullYear() - 1);
  let prior: RawObservation | null = null;
  for (const o of obs) {
    if (new Date(o.date) <= targetDate) {
      prior = o;
      break;
    }
  }
  if (!prior) throw new Error("no year-ago data");
  const yoy = ((parseFloat(latest.value) - parseFloat(prior.value)) / parseFloat(prior.value)) * 100;
  return { value: yoy, date: latest.date };
}

export async function fredWithPrior(seriesId: string, apiKey: string): Promise<{ value: number; prior: number; date: string }> {
  const end = new Date().toISOString().slice(0, 10);
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - 3);
  const start = startDate.toISOString().slice(0, 10);

  const obs = (await fetchObservations(seriesId, apiKey, start, end)).filter((o) => o.value !== "." && o.value != null);
  if (obs.length < 2) throw new Error("no data");
  return { value: parseFloat(obs[0].value), prior: parseFloat(obs[1].value), date: obs[0].date };
}
