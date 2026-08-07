import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveCheckResume } from "./check-resume.js";
import {
  applyHatchAwareCoverageCheckResumePreset,
  applyLaterCoverageCheckResumeSkip,
  applyStrictCoverageCheckResumePreset,
  dismissCoverageCheckResume,
  formatCoverageCheckResumeBundleStatus,
  isCoverageCheckResumeUndecided,
} from "./coverage-check-resume-presets.js";
import { resolveCoverageDebt } from "./coverage-debt.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(plan?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-ccr-preset-"));
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

describe("coverage-check-resume presets co-located (#3189)", () => {
  it("Strict and Hatch-aware decide and stop undecided", () => {
    const strictRoot = makeRepo({ policy: {} });
    expect(isCoverageCheckResumeUndecided(strictRoot)).toBe(true);
    const strict = applyStrictCoverageCheckResumePreset(strictRoot, {
      actor: "test",
      note: "unit",
    });
    expect(strict.exitCode).toBe(0);
    expect(strict.preset).toBe("strict");
    expect(isCoverageCheckResumeUndecided(strictRoot)).toBe(false);
    expect(formatCoverageCheckResumeBundleStatus(strictRoot)).toContain("coverageDebt");

    const hatchRoot = makeRepo({ policy: {} });
    const hatch = applyHatchAwareCoverageCheckResumePreset(hatchRoot);
    expect(hatch.exitCode).toBe(0);
    expect(resolveCoverageDebt(hatchRoot).mode).toBe("hatch");
    expect(resolveCheckResume(hatchRoot).localStamp).toBe("on");
  });

  it("Later and empty dismiss leave or refuse correctly", () => {
    const root = makeRepo({ policy: {} });
    const later = applyLaterCoverageCheckResumeSkip();
    expect(later.preset).toBe("later");
    expect(later.changed).toBe(false);
    expect(isCoverageCheckResumeUndecided(root)).toBe(true);

    expect(dismissCoverageCheckResume(root, "").exitCode).toBe(1);
    const dismissed = dismissCoverageCheckResume(root, "  hold  ");
    expect(dismissed.exitCode).toBe(0);
    expect(dismissed.preset).toBe("dismiss");
    expect(resolveCoverageDebt(root).dismissReason).toBe("hold");
  });

  it("preset writes fail closed when PROJECT-DEFINITION is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ccr-preset-missing-"));
    temps.push(root);
    const strict = applyStrictCoverageCheckResumePreset(root);
    expect(strict.exitCode).toBe(2);
    const hatch = applyHatchAwareCoverageCheckResumePreset(root);
    expect(hatch.exitCode).toBe(2);
    const dismiss = dismissCoverageCheckResume(root, "x");
    expect(dismiss.exitCode).toBe(2);
  });
});
