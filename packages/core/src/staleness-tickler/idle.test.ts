import { describe, expect, it } from "vitest";
import { DEFAULT_STALENESS_TICKLER_POLICY } from "../policy/staleness-tickler.js";
import { isSafeIdlePoint, shouldSkipTicklerEntirely } from "./idle.js";

describe("staleness tickler idle gates (#2488)", () => {
  const idleEnv: NodeJS.ProcessEnv = { DEFT_SESSION_RITUAL_SKIP: "" };

  it("suppresses on dirty tree", () => {
    const result = isSafeIdlePoint("root", DEFAULT_STALENESS_TICKLER_POLICY, {
      env: idleEnv,
      readPorcelain: () => " M file.txt\n",
      countInFlight: () => 0,
      insideDeftRepo: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dirty-tree");
  });

  it("suppresses when a story is in flight", () => {
    const result = isSafeIdlePoint("root", DEFAULT_STALENESS_TICKLER_POLICY, {
      env: idleEnv,
      readPorcelain: () => "",
      countInFlight: () => 1,
      insideDeftRepo: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("story-in-flight");
  });

  it("passes when clean and idle", () => {
    const result = isSafeIdlePoint("root", DEFAULT_STALENESS_TICKLER_POLICY, {
      env: idleEnv,
      readPorcelain: () => "",
      countInFlight: () => 0,
      insideDeftRepo: () => false,
    });
    expect(result.ok).toBe(true);
  });

  it("skips entirely when ritual skip is set", () => {
    expect(shouldSkipTicklerEntirely({ DEFT_SESSION_RITUAL_SKIP: "1" })).toBe(true);
  });
});
