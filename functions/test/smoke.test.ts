// functions/test/smoke.test.ts
import { describe, it, expect } from "vitest";
import { placeholder } from "../src/index.js";

describe("scaffolding", () => {
  it("loads the functions package", () => {
    expect(placeholder).toBe(true);
  });
});
