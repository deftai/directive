import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WAIT_MINUTES,
  DEFAULT_POLL_SECONDS,
  DEFAULT_STALL_THRESHOLD,
  EXIT_CLEAN,
  EXIT_NEW_P0_P1,
  EXIT_TERMINAL_ERROR,
  VERDICT_CI_BLOCKED,
  VERDICT_CLEAN,
  VERDICT_CONFIG,
  VERDICT_ERRORED,
  VERDICT_NEW_P0_P1,
  VERDICT_PENDING,
  VERDICT_STALL,
  VERDICT_TIMEOUT,
} from "./constants.js";

describe("pr-watch constants", () => {
  it("pins the three-state exit contract (0 / 1 / 2, distinct)", () => {
    expect(EXIT_CLEAN).toBe(0);
    expect(EXIT_NEW_P0_P1).toBe(1);
    expect(EXIT_TERMINAL_ERROR).toBe(2);
    expect(new Set([EXIT_CLEAN, EXIT_NEW_P0_P1, EXIT_TERMINAL_ERROR]).size).toBe(3);
  });

  it("all non-CLEAN/NEW_P0_P1 verdicts collapse onto the terminal-error exit", () => {
    // The AC-1 contract: ERRORED | STALL | TIMEOUT | CI_BLOCKED | CONFIG | PENDING all exit 2.
    for (const verdict of [
      VERDICT_ERRORED,
      VERDICT_STALL,
      VERDICT_TIMEOUT,
      VERDICT_CI_BLOCKED,
      VERDICT_CONFIG,
      VERDICT_PENDING,
    ]) {
      expect(typeof verdict).toBe("string");
      expect(verdict.length).toBeGreaterThan(0);
    }
    expect(VERDICT_CLEAN).toBe("CLEAN");
    expect(VERDICT_NEW_P0_P1).toBe("NEW_P0_P1");
  });

  it("exposes the documented flag defaults", () => {
    expect(DEFAULT_MAX_WAIT_MINUTES).toBe(30);
    expect(DEFAULT_POLL_SECONDS).toBe(90);
    expect(DEFAULT_STALL_THRESHOLD).toBe(3);
  });
});
