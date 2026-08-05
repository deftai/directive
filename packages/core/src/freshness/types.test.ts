import { describe, expect, it } from "vitest";
import {
  FRESHNESS_SCHEMA_VERSION,
  FRESHNESS_STATES,
  FRESHNESS_SURFACES,
  HARD_SURFACES,
  SOFT_SURFACES,
} from "./types.js";

describe("freshness types (#3117)", () => {
  it("exposes schema version and state enum", () => {
    expect(FRESHNESS_SCHEMA_VERSION).toBe(1);
    expect(FRESHNESS_STATES).toContain("current");
    expect(FRESHNESS_STATES).toContain("stale_soft");
    expect(FRESHNESS_STATES).toContain("stale_hard");
    expect(FRESHNESS_STATES).toContain("unbound");
  });

  it("partitions hard and soft surfaces", () => {
    expect(HARD_SURFACES).toEqual(
      expect.arrayContaining(["payload", "version", "templates", "skills"]),
    );
    expect(SOFT_SURFACES).toContain("docs");
    for (const s of [...HARD_SURFACES, ...SOFT_SURFACES]) {
      expect(FRESHNESS_SURFACES).toContain(s);
    }
  });
});
