// functions/test/index.test.ts
import { describe, it, expect } from "vitest";
import { assertOwner, guardOverlap } from "../src/index.js";

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
