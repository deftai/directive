/**
 * Bundled presets for coverageDebt + checkResume (#3189).
 *
 * One project decision (not five micro-toggles in v1).
 * Later does not write decided; Strict / Hatch-aware / dismiss-with-reason do.
 *
 * Both fields are written in a single PROJECT-DEFINITION mutation lock so a
 * partial decision (coverageDebt decided, checkResume still unset) cannot
 * persist after a mid-write failure.
 */

import { readFileSync } from "node:fs";
import {
  atomicWriteProjectDefinition,
  projectDefinitionMutationLock,
} from "../vbrief-build/project-definition-io.js";
import {
  CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1,
  type CheckResumeConfig,
  type CheckResumeLocalStamp,
  formatCheckResumeStatusLine,
  resolveCheckResume,
  resolveCheckResumeFromTypedBlock,
} from "./check-resume.js";
import {
  type CoverageDebtConfig,
  type CoverageDebtMode,
  DEFAULT_COVERAGE_DEBT_AUTO_FILE,
  formatCoverageDebtStatusLine,
  resolveCoverageDebt,
  resolveCoverageDebtFromTypedBlock,
} from "./coverage-debt.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import { appendAuditLog, projectDefinitionPath } from "./resolve.js";

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

interface BundleWriteInput {
  readonly mode: CoverageDebtMode;
  readonly autoFile?: boolean;
  readonly localStamp: CheckResumeLocalStamp;
  readonly dismissReason?: string | null;
  readonly actor: string;
  readonly note: string;
  readonly preset: CoverageCheckResumePreset | "dismiss";
}

/**
 * Atomically write both coverageDebt and checkResume under one mutation lock.
 */
function writeCoverageCheckResumeBundle(
  projectRoot: string,
  input: BundleWriteInput,
): ApplyCoverageCheckResumePresetResult {
  const path = projectDefinitionPath(projectRoot);
  try {
    const { changed } = projectDefinitionMutationLock(projectRoot, () => {
      const parsed: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`PROJECT-DEFINITION at ${path} top-level value is not a JSON object`);
      }
      const data = parsed as Record<string, unknown>;
      if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
        if (data.plan === undefined) {
          data.plan = {};
        } else {
          throw new Error("PROJECT-DEFINITION 'plan' is not an object");
        }
      }
      const plan = data.plan as Record<string, unknown>;
      migrateLegacyPolicyKey(plan);
      const existingPolicy = plan[PLAN_POLICY_KEY];
      if (
        typeof existingPolicy !== "object" ||
        existingPolicy === null ||
        Array.isArray(existingPolicy)
      ) {
        if (existingPolicy === undefined) {
          plan[PLAN_POLICY_KEY] = {};
        } else {
          throw new Error("plan.policy is not an object");
        }
      }
      const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
      const previousDebt = policyBlock.coverageDebt;
      const previousResume = policyBlock.checkResume;
      const autoFile =
        input.mode === "hatch" ? (input.autoFile ?? DEFAULT_COVERAGE_DEBT_AUTO_FILE) : false;
      const dismissReason =
        typeof input.dismissReason === "string" && input.dismissReason.trim().length > 0
          ? input.dismissReason.trim()
          : null;
      const nextDebt: CoverageDebtConfig = {
        status: "decided",
        mode: input.mode,
        autoFile,
        dismissReason,
      };
      const nextResume: CheckResumeConfig = {
        status: "decided",
        localStamp: input.localStamp,
        ciTrustsLocalStamp: CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1,
        dismissReason,
      };
      const prevDebt = resolveCoverageDebtFromTypedBlock(previousDebt);
      const prevResume = resolveCheckResumeFromTypedBlock(previousResume);
      const changedFlag =
        prevDebt.status !== nextDebt.status ||
        prevDebt.mode !== nextDebt.mode ||
        prevDebt.autoFile !== nextDebt.autoFile ||
        prevDebt.dismissReason !== nextDebt.dismissReason ||
        prevResume.status !== nextResume.status ||
        prevResume.localStamp !== nextResume.localStamp ||
        prevResume.dismissReason !== nextResume.dismissReason;
      // Single write of both keys — no partial decide on mid-failure.
      policyBlock.coverageDebt = nextDebt;
      policyBlock.checkResume = nextResume;
      if (changedFlag) {
        atomicWriteProjectDefinition(path, data);
      }
      const note = input.note.replace(/\n/g, " ").replace(/\r/g, " ");
      appendAuditLog(
        projectRoot,
        [
          `actor=${input.actor}`,
          `preset=${input.preset}`,
          "coverageDebt.status=decided",
          `mode=${nextDebt.mode}`,
          `autoFile=${String(nextDebt.autoFile)}`,
          "checkResume.status=decided",
          `localStamp=${nextResume.localStamp}`,
          "ciTrustsLocalStamp=false",
          `dismissReason=${JSON.stringify(dismissReason)}`,
          `previousDebt=${JSON.stringify(previousDebt ?? null)}`,
          `previousResume=${JSON.stringify(previousResume ?? null)}`,
          note ? `note=${note}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      return { changed: changedFlag };
    });

    const summary = formatCoverageCheckResumeBundleStatus(projectRoot);
    const lines = [
      `\u2713 coverageDebt+checkResume decided via preset=${input.preset} (atomic write).`,
      changed
        ? "  audit: meta/policy-changes.log updated."
        : "  no-op: value already matched (audit entry still appended for trail).",
      summary,
    ];
    return {
      exitCode: 0,
      stdout: `${lines.join("\n")}\n`,
      changed,
      preset: input.preset,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("PROJECT-DEFINITION not found") ||
      message.includes("ENOENT") ||
      message.includes("no such file")
    ) {
      return {
        exitCode: 2,
        stdout: `\u274c PROJECT-DEFINITION not found under ${projectRoot}\n`,
        changed: false,
        preset: input.preset,
      };
    }
    return {
      exitCode: 2,
      stdout: `\u274c Config error: ${message}\n`,
      changed: false,
      preset: input.preset,
    };
  }
}

/**
 * Apply Strict: coverageDebt.mode=off, checkResume.localStamp=off, both decided.
 * Recommended for most apps.
 */
export function applyStrictCoverageCheckResumePreset(
  projectRoot: string,
  options: ApplyCoverageCheckResumePresetOptions = {},
): ApplyCoverageCheckResumePresetResult {
  return writeCoverageCheckResumeBundle(projectRoot, {
    mode: "off",
    autoFile: false,
    localStamp: "off",
    actor: options.actor ?? policyColonInvocation("coverage-check-resume-preset", " strict"),
    note: options.note ?? "preset=strict",
    preset: "strict",
  });
}

/**
 * Apply Hatch-aware: coverageDebt.mode=hatch autoFile=false; localStamp=on for DX.
 * CI still never trusts local stamps.
 */
export function applyHatchAwareCoverageCheckResumePreset(
  projectRoot: string,
  options: ApplyCoverageCheckResumePresetOptions = {},
): ApplyCoverageCheckResumePresetResult {
  return writeCoverageCheckResumeBundle(projectRoot, {
    mode: "hatch",
    autoFile: false,
    localStamp: "on",
    actor: options.actor ?? policyColonInvocation("coverage-check-resume-preset", " hatch-aware"),
    note: options.note ?? "preset=hatch-aware",
    preset: "hatch-aware",
  });
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
  return writeCoverageCheckResumeBundle(projectRoot, {
    mode: "off",
    autoFile: false,
    localStamp: "off",
    dismissReason: trimmed,
    actor: options.actor ?? policyColonInvocation("coverage-check-resume-dismiss"),
    note: options.note ?? `dismiss=${trimmed}`,
    preset: "dismiss",
  });
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

export function formatCoverageCheckResumeBundleStatus(projectRoot: string): string {
  return (
    `${formatCoverageDebtStatusLine(resolveCoverageDebt(projectRoot))}\n` +
    `${formatCheckResumeStatusLine(resolveCheckResume(projectRoot))}`
  );
}
