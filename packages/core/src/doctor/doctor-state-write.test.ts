import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: () => {
      throw new Error("write failed");
    },
  };
});

import { writeState } from "./doctor-state.js";

describe("doctor-state write failures", () => {
  it("writeState returns null when persistence fails", () => {
    expect(writeState(process.cwd(), { exitCode: 0, findingCount: 0, errorCount: 0 })).toBeNull();
  });
});
