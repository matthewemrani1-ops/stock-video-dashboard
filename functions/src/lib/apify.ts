interface ApifyRunData {
  id: string;
  defaultDatasetId: string;
  status: string;
}

export async function runActor(
  actorId: string,
  token: string,
  input: object,
  onTick?: (status: string, sec: number) => void
): Promise<unknown[]> {
  const startRes = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!startRes.ok) {
    let msg = String(startRes.status);
    try {
      const errBody = await startRes.json();
      msg += " — " + (errBody?.error?.message || JSON.stringify(errBody));
    } catch {
      // ignore body parse failure, keep status-only message
    }
    throw new Error(msg);
  }
  const run = ((await startRes.json()) as { data: ApifyRunData }).data;
  const runId = run.id;
  let datasetId = run.defaultDatasetId;
  let status = run.status;
  const started = Date.now();
  const MAX = 25 * 60 * 1000;
  const terminal = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"];

  while (!terminal.includes(status)) {
    if (Date.now() - started > MAX) throw new Error("still running after 25 min — try fewer videos");
    await new Promise((r) => setTimeout(r, 5000));
    const pr = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    if (pr.ok) {
      const pd = ((await pr.json()) as { data: ApifyRunData }).data;
      status = pd.status;
      datasetId = pd.defaultDatasetId || datasetId;
    }
    if (onTick) onTick(status, Math.round((Date.now() - started) / 1000));
  }
  if (status !== "SUCCEEDED") throw new Error("run " + status);

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&format=json&clean=true`);
  if (!itemsRes.ok) throw new Error("couldn't read results (" + itemsRes.status + ")");
  const data = await itemsRes.json();
  return Array.isArray(data) ? data : [];
}
