/**
 * Bundled presets for coverageDebt + checkResume (#3189).
 *
 * One project decision (not five micro-toggles in v1).
 * Later does not write decided; Strict / Hatch-aware / dismiss-with-reason do.
 */

import {
  formatCheckResumeStatusLine,
  resolveCheckResume,
  type WriteCheckResumeResult,
  writeCheckResume,
} from "./check-resume.js";
import {
  formatCoverageDebtStatusLine,
  resolveCoverageDebt,
  type WriteCoverageDebtResult,
  writeCoverageDebt,
} from "./coverage-debt.js";
import { policyColonInvocation } from "./policy-invocation.js";

export const COVERAGE_CHECK_RESUME_PRESETS = ["strict", "hatch-aware"] as const;
export type CoverageCheckResumePreset = (typeof COVERAGE_CHECK_RESUME_PRESETS)[number];

export interface ApplyCoverageCheckResumePresetOptions {
  readonly actor?: string;
  readonly note?: string;
}

export interface ApplyCoverageCheckResumePresetResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly changed: boolean;
  readonly preset: CoverageCheckResumePreset | "dismiss" | "later";
}

/** True when either policy is still unset (coupled v1 nag). */
export function isCoverageCheckResumeUndecided(projectRoot: string): boolean {
  const debt = resolveCoverageDebt(projectRoot);
  const resume = resolveCheckResume(projectRoot);
  return debt.status === "unset" || resume.status === "unset";
}

/**
 * Apply Strict: coverageDebt.mode=off, checkResume.localStamp=off, both decided.
 * Recommended for most apps.
 */
export function applyStrictCoverageCheckResumePreset(
  projectRoot: string,
  options: ApplyCoverageCheckResumePresetOptions = {},
): ApplyCoverageCheckResumePresetResult {
  const actor = options.actor ?? policyColonInvocation("coverage-check-resume-preset", " strict");
  const note = options.note ?? "preset=strict";
  const debt = writeCoverageDebt(projectRoot, {
    mode: "off",
    autoFile: false,
    actor,
    note,
  });
  if (debt.exitCode !== 0) {
    return { exitCode: debt.exitCode, stdout: debt.stdout, changed: false, preset: "strict" };
  }
  const resume = writeCheckResume(projectRoot, {
    localStamp: "off",
    actor,
    note,
  });
  return mergeWriteResults(projectRoot, "strict", debt, resume);
}

/**
 * Apply Hatch-aware: coverageDebt.mode=hatch autoFile=false; localStamp=on for DX.
 * CI still never trusts local stamps.
 */
export function applyHatchAwareCoverageCheckResumePreset(
  projectRoot: string,
  options: ApplyCoverageCheckResumePresetOptions = {},
): ApplyCoverageCheckResumePresetResult {
  const actor =
    options.actor ?? policyColonInvocation("coverage-check-resume-preset", " hatch-aware");
  const note = options.note ?? "preset=hatch-aware";
  const debt = writeCoverageDebt(projectRoot, {
    mode: "hatch",
    autoFile: false,
    actor,
    note,
  });
  if (debt.exitCode !== 0) {
    return {
      exitCode: debt.exitCode,
      stdout: debt.stdout,
      changed: false,
      preset: "hatch-aware",
    };
  }
  const resume = writeCheckResume(projectRoot, {
    localStamp: "on",
    actor,
    note,
  });
  return mergeWriteResults(projectRoot, "hatch-aware", debt, resume);
}

/**
 * Dismiss-with-reason: marks both decided as fail-closed (mode off / localStamp off)
 * and records the reason for policy:show / doctor visibility. Stops the session nag.
 */
export function dismissCoverageCheckResume(
  projectRoot: string,
  reason: string,
  options: ApplyCoverageCheckResumePresetOptions = {},
): ApplyCoverageCheckResumePresetResult {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return {
      exitCode: 1,
      stdout:
        "\u274c dismiss-with-reason requires a non-empty reason " +
        "(Later without a reason does not decide; re-nag next ritual).\n",
      changed: false,
      preset: "dismiss",
    };
  }
  const actor = options.actor ?? policyColonInvocation("coverage-check-resume-dismiss");
  const note = options.note ?? `dismiss=${trimmed}`;
  const debt = writeCoverageDebt(projectRoot, {
    mode: "off",
    autoFile: false,
    dismissReason: trimmed,
    actor,
    note,
  });
  if (debt.exitCode !== 0) {
    return { exitCode: debt.exitCode, stdout: debt.stdout, changed: false, preset: "dismiss" };
  }
  const resume = writeCheckResume(projectRoot, {
    localStamp: "off",
    dismissReason: trimmed,
    actor,
    note,
  });
  return mergeWriteResults(projectRoot, "dismiss", debt, resume);
}

/**
 * Later: does NOT write status=decided. Caller skips for this session;
 * next session-start ritual nags again.
 */
export function applyLaterCoverageCheckResumeSkip(): ApplyCoverageCheckResumePresetResult {
  return {
    exitCode: 0,
    stdout:
      "[deft policy] coverageDebt/checkResume: Later -- not decided. " +
      "Fail-closed defaults remain (mode off, localStamp off, CI never trusts local stamps). " +
      "Next interactive session-start ritual will remind you.\n",
    changed: false,
    preset: "later",
  };
}

function mergeWriteResults(
  projectRoot: string,
  preset: CoverageCheckResumePreset | "dismiss",
  debt: WriteCoverageDebtResult,
  resume: WriteCheckResumeResult,
): ApplyCoverageCheckResumePresetResult {
  const ok = resume.exitCode === 0;
  const summary = ok ? `${formatCoverageCheckResumeBundleStatus(projectRoot)}\n` : "";
  return {
    exitCode: resume.exitCode,
    stdout: `${debt.stdout}${resume.stdout}${summary}`,
    changed: debt.changed || resume.changed,
    preset,
  };
}

export function formatCoverageCheckResumeBundleStatus(projectRoot: string): string {
  return (
    `${formatCoverageDebtStatusLine(resolveCoverageDebt(projectRoot))}\n` +
    `${formatCheckResumeStatusLine(resolveCheckResume(projectRoot))}`
  );
}
