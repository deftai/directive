import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyStrictCoverageCheckResumePreset } from "../policy/coverage-check-resume-presets.js";
import {
  COVERAGE_CHECK_RESUME_NUDGE_WHAT,
  COVERAGE_CHECK_RESUME_NUDGE_WHY,
  formatCoverageCheckResumeNudge,
  isCoverageCheckResumeNudgeEligible,
  maybeFormatCoverageCheckResumeNudge,
} from "./coverage-check-resume-nudge.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(plan?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-ccr-nudge-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], ...plan },
    }),
    "utf8",
  );
  return root;
}

describe("coverage-check-resume session nudge (#3189)", () => {
  it("eligible when unset and interactive", () => {
    const root = makeRepo({ policy: {} });
    expect(
      isCoverageCheckResumeNudgeEligible({
        projectRoot: root,
        env: {},
        stdinIsTTY: true,
      }),
    ).toBe(true);
    const text = maybeFormatCoverageCheckResumeNudge({
      projectRoot: root,
      env: {},
      stdinIsTTY: true,
    });
    expect(text).toContain(COVERAGE_CHECK_RESUME_NUDGE_WHY.slice(0, 30));
    expect(text).toContain("Strict");
    expect(text).toContain("Hatch-aware");
    expect(text).toContain("Later");
    expect(text).toContain("Discuss");
    expect(text).toContain("Back");
    expect(text).toContain("coverage-check-resume-preset");
    expect(text).toContain("coverage-check-resume-later");
    expect(text).toContain("coverage-check-resume-dismiss");
    expect(formatCoverageCheckResumeNudge()).toContain(
      COVERAGE_CHECK_RESUME_NUDGE_WHAT.slice(0, 20),
    );
  });

  it("silent in headless / CI (fail-open, never blocks)", () => {
    const root = makeRepo({ policy: {} });
    expect(
      isCoverageCheckResumeNudgeEligible({
        projectRoot: root,
        env: { CI: "true" },
        stdinIsTTY: false,
      }),
    ).toBe(false);
    expect(
      maybeFormatCoverageCheckResumeNudge({
        projectRoot: root,
        env: { CI: "true" },
        stdinIsTTY: false,
      }),
    ).toBe("");
    expect(
      maybeFormatCoverageCheckResumeNudge({
        projectRoot: root,
        env: { DEFT_HEADLESS: "1" },
        stdinIsTTY: true,
      }),
    ).toBe("");
  });

  it("silent when decided (Strict stops nag)", () => {
    const root = makeRepo({ policy: {} });
    applyStrictCoverageCheckResumePreset(root);
    expect(
      isCoverageCheckResumeNudgeEligible({
        projectRoot: root,
        env: {},
        stdinIsTTY: true,
      }),
    ).toBe(false);
    expect(
      maybeFormatCoverageCheckResumeNudge({
        projectRoot: root,
        env: {},
        stdinIsTTY: true,
      }),
    ).toBe("");
  });

  it("nudge copy states CI must not trust laptop stamp", () => {
    const body = formatCoverageCheckResumeNudge();
    expect(body.toLowerCase()).toContain("ci must not trust");
  });
});
