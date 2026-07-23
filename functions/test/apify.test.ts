import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runActor } from "../src/lib/apify.js";

describe("runActor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts the run, polls until SUCCEEDED, and returns dataset items", async () => {
    const fetchMock = vi
      .fn()
      // start run
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "run1", defaultDatasetId: "ds1", status: "RUNNING" } }) })
      // first poll: still running
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "run1", defaultDatasetId: "ds1", status: "RUNNING" } }) })
      // second poll: succeeded
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "run1", defaultDatasetId: "ds1", status: "SUCCEEDED" } }) })
      // dataset items
      .mockResolvedValueOnce({ ok: true, json: async () => [{ text: "hello" }] });
    vi.stubGlobal("fetch", fetchMock);

    const ticks: string[] = [];
    const resultPromise = runActor("apify/instagram-reel-scraper", "tok", { username: ["a"] }, (status) => ticks.push(status));

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result).toEqual([{ text: "hello" }]);
    expect(ticks).toEqual(["RUNNING", "SUCCEEDED"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws when the start request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: { message: "bad token" } }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runActor("actor", "bad-tok", {})).rejects.toThrow("bad token");
  });

  it("throws when the run status is not SUCCEEDED", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "run1", defaultDatasetId: "ds1", status: "FAILED" } }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runActor("actor", "tok", {})).rejects.toThrow("run FAILED");
  });
});
