import { describe, it, expect, vi, afterEach } from "vitest";
import { fredLatest, fredYoY, fredWithPrior } from "../src/lib/fred.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fredLatest", () => {
  it("returns the most recent non-missing observation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ observations: [{ value: ".", date: "2026-07-22" }, { value: "4.31", date: "2026-07-21" }] }),
      })
    );
    expect(await fredLatest("FEDFUNDS", "key")).toEqual({ value: 4.31, date: "2026-07-21" });
  });

  it("hits the FRED API directly with sort_order=desc, not the Cloudflare Worker", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ observations: [{ value: "1", date: "2026-07-21" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    await fredLatest("FEDFUNDS", "key");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("api.stlouisfed.org");
    expect(url).toContain("sort_order=desc");
    expect(url).not.toContain("fred-proxy");
  });
});

describe("fredYoY", () => {
  it("computes year-over-year percent change from the latest and year-ago values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          observations: [
            { value: "110", date: "2026-07-01" },
            { value: "100", date: "2025-07-01" },
          ],
        }),
      })
    );
    const result = await fredYoY("CPIAUCSL", "key");
    expect(result.value).toBeCloseTo(10, 5);
  });
});

describe("fredWithPrior", () => {
  it("returns the latest value alongside the prior observation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ observations: [{ value: "220000", date: "2026-07-19" }, { value: "215000", date: "2026-07-12" }] }) })
    );
    expect(await fredWithPrior("ICSA", "key")).toEqual({ value: 220000, prior: 215000, date: "2026-07-19" });
  });
});
