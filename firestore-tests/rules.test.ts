import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";

const OWNER_UID = "owner-test-uid";
let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "signal-rules-test",
    firestore: { rules: readFileSync("../firestore.rules", "utf8") },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe("digests/{date}", () => {
  it("owner can read", async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(db.doc("digests/2026-07-23").get());
  });

  it("stranger cannot read", async () => {
    const db = testEnv.authenticatedContext("someone-else").firestore();
    await assertFails(db.doc("digests/2026-07-23").get());
  });

  it("unauthenticated cannot read", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.doc("digests/2026-07-23").get());
  });

  it("stranger cannot write", async () => {
    const db = testEnv.authenticatedContext("someone-else").firestore();
    await assertFails(db.doc("digests/2026-07-23").set({ status: "running" }));
  });
});

describe("config/settings", () => {
  it("owner can read and write", async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(db.doc("config/settings").set({ trackedHandles: ["a"] }));
    await assertSucceeds(db.doc("config/settings").get());
  });

  it("stranger cannot write", async () => {
    const db = testEnv.authenticatedContext("someone-else").firestore();
    await assertFails(db.doc("config/settings").set({ trackedHandles: ["a"] }));
  });
});
