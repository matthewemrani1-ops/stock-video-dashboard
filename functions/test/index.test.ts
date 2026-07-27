// functions/test/index.test.ts
import { describe, it, expect } from "vitest";
import { assertOwner, guardOverlap, resolveTargetDate } from "../src/index.js";

const OWNER_UID = "ETuFSQc87GXecZg8JEgLqpYhgkL2";

describe("assertOwner", () => {
  it("passes for the owner UID", () => {
    expect(() => assertOwner({ uid: OWNER_UID })).not.toThrow();
  });

  it("throws for any other UID", () => {
    expect(() => assertOwner({ uid: "someone-else" })).toThrow("permission-denied");
  });

  it("throws when there's no auth context", () => {
    expect(() => assertOwner(undefined)).toThrow("permission-denied");
  });
});

describe("guardOverlap", () => {
  it("does nothing when there's no existing doc", () => {
    expect(() => guardOverlap(undefined)).not.toThrow();
  });

  it("does nothing when the existing doc is complete", () => {
    expect(() => guardOverlap({ status: "complete" })).not.toThrow();
  });

  it("throws when a run is already in progress", () => {
    expect(() => guardOverlap({ status: "running" })).toThrow("already-exists");
  });
});

describe("resolveTargetDate", () => {
  it("defaults to today when no dateKey is given", () => {
    const { targetDate, dateKey } = resolveTargetDate(undefined);
    const todayKey = new Date().toISOString().slice(0, 10);
    expect(dateKey).toBe(todayKey);
    expect(targetDate.toISOString().slice(0, 10)).toBe(todayKey);
  });

  it("resolves a valid YYYY-MM-DD dateKey to noon local time on that date", () => {
    const { targetDate, dateKey } = resolveTargetDate("2026-07-26");
    expect(dateKey).toBe("2026-07-26");
    expect(targetDate.getFullYear()).toBe(2026);
    expect(targetDate.getMonth()).toBe(6); // 0-indexed: July
    expect(targetDate.getDate()).toBe(26);
    expect(targetDate.getHours()).toBe(12);
  });

  it("throws invalid-argument for a malformed dateKey", () => {
    expect(() => resolveTargetDate("not-a-date")).toThrow("invalid-argument");
    expect(() => resolveTargetDate("07/26/2026")).toThrow("invalid-argument");
  });
});
