import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WAIT_MINUTES,
  DEFAULT_POLL_SECONDS,
  DEFAULT_STALL_THRESHOLD,
  DEFAULT_STICKY_SHA_STALL_SECONDS,
  EXIT_CLEAN,
  EXIT_NEW_P0_P1,
  EXIT_TERMINAL_ERROR,
  GREPTILE_SHA_STALL_REMEDY,
  VERDICT_CI_BLOCKED,
  VERDICT_CLEAN,
  VERDICT_CLOSED_UNMERGED,
  VERDICT_CONFIG,
  VERDICT_ERRORED,
  VERDICT_GREPTILE_SHA_STALL,
  VERDICT_MERGED,
  VERDICT_NEW_P0_P1,
  VERDICT_NO_REVIEWER_INSTALLED,
  VERDICT_PENDING,
  VERDICT_STALL,
  VERDICT_TIMEOUT,
  WATCH_HELP,
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
    // MERGED is exit 0 (finish-success with CLEAN); CLOSED_UNMERGED is exit 2 (#4288).
    for (const verdict of [
      VERDICT_ERRORED,
      VERDICT_STALL,
      VERDICT_TIMEOUT,
      VERDICT_CI_BLOCKED,
      VERDICT_CONFIG,
      VERDICT_PENDING,
      VERDICT_NO_REVIEWER_INSTALLED,
      VERDICT_GREPTILE_SHA_STALL,
      VERDICT_CLOSED_UNMERGED,
    ]) {
      expect(typeof verdict).toBe("string");
      expect(verdict.length).toBeGreaterThan(0);
    }
    expect(VERDICT_CLEAN).toBe("CLEAN");
    expect(VERDICT_NEW_P0_P1).toBe("NEW_P0_P1");
    expect(VERDICT_MERGED).toBe("MERGED");
    expect(VERDICT_CLOSED_UNMERGED).toBe("CLOSED_UNMERGED");
  });

  it("exposes the documented flag defaults", () => {
    expect(DEFAULT_MAX_WAIT_MINUTES).toBe(30);
    expect(DEFAULT_POLL_SECONDS).toBe(90);
    expect(DEFAULT_STALL_THRESHOLD).toBe(3);
    expect(DEFAULT_STICKY_SHA_STALL_SECONDS).toBe(600);
    expect(GREPTILE_SHA_STALL_REMEDY).toBe("BLOCKED: greptile-sha-stall");
  });

  it("documents MERGED / CLOSED_UNMERGED lifecycle short-circuit (#4288)", () => {
    expect(WATCH_HELP).toContain("MERGED");
    expect(WATCH_HELP).toContain("CLOSED_UNMERGED");
    expect(WATCH_HELP).toContain("PR lifecycle short-circuit (#4288)");
  });

  it("documents NO_REVIEWER_INSTALLED on the exit-2 help line (#3630)", () => {
    expect(WATCH_HELP).toContain("NO_REVIEWER_INSTALLED");
    expect(VERDICT_NO_REVIEWER_INSTALLED).toBe("NO_REVIEWER_INSTALLED");
  });

  it("documents full-stdout --json parse for wrappers (#4882 / #5015)", () => {
    expect(WATCH_HELP).toContain("pretty-printed multi-line JSON");
    expect(WATCH_HELP).toContain("parsePrWatchJsonStdout");
    expect(WATCH_HELP).toContain("#4882");
  });

  it("documents sticky tip-rot sha_match → greptile-sha-stall (#5162)", () => {
    expect(WATCH_HELP).toContain("GREPTILE_SHA_STALL");
    expect(WATCH_HELP).toContain("BLOCKED: greptile-sha-stall");
    expect(WATCH_HELP).toContain("@greptileai review");
    expect(VERDICT_GREPTILE_SHA_STALL).toBe("GREPTILE_SHA_STALL");
  });
});
