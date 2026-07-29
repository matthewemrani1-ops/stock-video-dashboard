// functions/test/index.test.ts
import { describe, it, expect, vi } from "vitest";
import { assertOwner, guardOverlap, resolveTargetDate, verifyOwnerAuth } from "../src/index.js";

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: vi.fn(async (token: string) => {
      if (token === "valid-owner-token") return { uid: "ETuFSQc87GXecZg8JEgLqpYhgkL2" };
      if (token === "valid-other-token") return { uid: "someone-else" };
      throw new Error("invalid token");
    }),
  }),
}));

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

describe("verifyOwnerAuth", () => {
  it("rejects a missing Authorization header", async () => {
    const result = await verifyOwnerAuth(undefined);
    expect(result).toEqual({ ok: false, status: 401, error: "missing or malformed Authorization header" });
  });

  it("rejects a malformed Authorization header", async () => {
    const result = await verifyOwnerAuth("NotBearer abc");
    expect(result).toEqual({ ok: false, status: 401, error: "missing or malformed Authorization header" });
  });

  it("rejects an invalid token", async () => {
    const result = await verifyOwnerAuth("Bearer garbage-token");
    expect(result).toEqual({ ok: false, status: 401, error: "invalid token" });
  });

  it("rejects a valid token belonging to a non-owner", async () => {
    const result = await verifyOwnerAuth("Bearer valid-other-token");
    expect(result).toEqual({ ok: false, status: 403, error: "not authorized" });
  });

  it("accepts a valid owner token", async () => {
    const result = await verifyOwnerAuth("Bearer valid-owner-token");
    expect(result).toEqual({ ok: true });
  });
});
