/**
 * Project coverageMode posture (#5791 Prefer-A Recut-2 Bound).
 *
 * initial|disabled authorize an honest non-zero coverage_headroom skip when no
 * Istanbul report is present. full keeps today's measured path. missing/null
 * reads as initial; malformed does not (fail-closed to full).
 *
 * Public graduation path (do not hand-edit PROJECT-DEFINITION for mode changes):
 * - setCoverageMode re-exported from packages/core policy barrel + packages/core/src/index.ts;
 *   package export ./policy.
 * - CLI: deft policy:set-coverage-mode -- --mode full|disabled|initial --confirm.
 * Damaged/unreadable PROJECT-DEFINITION resolves to full (never initial) — see resolveCoverageMode.
 */

import { withProjectDefinitionMutation } from "../vbrief-build/project-definition-mutation.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import { appendAuditLog, loadProjectDefinition, projectDefinitionPath } from "./resolve.js";

/** Canonical registered policy field name. */
export const FIELD_COVERAGE_MODE = "plan.policy.coverageMode";

/** Short alias for `policy:show --field=coverageMode`. */
export const FIELD_COVERAGE_MODE_CLI_ALIAS = "coverageMode";

export const COVERAGE_MODES = ["initial", "disabled", "full"] as const;
export type CoverageMode = (typeof COVERAGE_MODES)[number];

/** Consumer / install default when the key is missing or null. */
export const DEFAULT_COVERAGE_MODE: CoverageMode = "initial";

/** Directive self-host enforcement posture. */
export const SELF_HOST_COVERAGE_MODE: CoverageMode = "full";

/** Install/setup seed value for new PROJECT-DEFINITION policy blocks. */
export const INSTALL_SEED_COVERAGE_MODE: CoverageMode = "initial";

export type CoverageModeSource = "typed" | "default" | "default-on-error";

export interface CoverageModeResolved {
  readonly mode: CoverageMode;
  readonly source: CoverageModeSource;
  readonly error: string | null;
}

export interface CoverageModePolicyField {
  readonly name: typeof FIELD_COVERAGE_MODE;
  readonly current: CoverageMode;
  readonly default: CoverageMode;
  readonly source: string;
}

/** Standing reminder when mode-skip fires under initial (#5791 P3). */
export const COVERAGE_MODE_INITIAL_REMINDER =
  "coverageMode is initial — choose full (measure Istanbul) or disabled (stand down); " +
  "extension-coverable paths in the reviewed diff may strengthen this reminder";

function defaultResolved(
  source: CoverageModeSource,
  error: string | null = null,
  mode: CoverageMode = DEFAULT_COVERAGE_MODE,
): CoverageModeResolved {
  return { mode, source, error };
}

export function isCoverageMode(value: unknown): value is CoverageMode {
  return typeof value === "string" && (COVERAGE_MODES as readonly string[]).includes(value);
}

/** Modes that authorize the exit-5 posture skip when no report is present. */
export function isCoverageModeSkipAuthorized(mode: CoverageMode): boolean {
  return mode === "initial" || mode === "disabled";
}

/**
 * Resolve a raw policy value.
 * missing/null → initial; malformed → full (never initial).
 */
export function resolveCoverageModeFromValue(raw: unknown): CoverageModeResolved {
  if (raw === undefined || raw === null) {
    return defaultResolved("default");
  }
  if (isCoverageMode(raw)) {
    return { mode: raw, source: "typed", error: null };
  }
  const shown = typeof raw === "string" ? JSON.stringify(raw) : typeof raw;
  return defaultResolved(
    "default-on-error",
    FIELD_COVERAGE_MODE + " must be one of " + COVERAGE_MODES.join("|") + "; got " + shown,
    "full",
  );
}

/** Resolve plan.policy.coverageMode via readPlanPolicy (#5791). */
export function resolveCoverageMode(projectRoot: string): CoverageModeResolved {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    // Absent file → initial. Invalid JSON / read errors → full (never initial).
    if (err?.includes("PROJECT-DEFINITION not found")) {
      return defaultResolved("default");
    }
    return defaultResolved("default-on-error", err ?? "PROJECT-DEFINITION unreadable", "full");
  }
  return resolveCoverageModeFromPlan(data.plan);
}

/** Resolve from an already-loaded plan object (namespaced-first). */
export function resolveCoverageModeFromPlan(plan: unknown): CoverageModeResolved {
  const policyBlock = readPlanPolicy(plan);
  // Absent policy block → install default (initial). Damaged block → full (never initial).
  if (policyBlock === undefined) {
    return defaultResolved("default");
  }
  if (typeof policyBlock !== "object" || policyBlock === null || Array.isArray(policyBlock)) {
    return defaultResolved("default-on-error", "x-directive/policy must be an object", "full");
  }
  if (!("coverageMode" in (policyBlock as Record<string, unknown>))) {
    return defaultResolved("default");
  }
  return resolveCoverageModeFromValue((policyBlock as Record<string, unknown>).coverageMode);
}

/**
 * Seed helper: write initial only when the key is absent.
 * Repair / re-render must call {@link preserveExplicitCoverageMode} instead.
 */
export function seedCoverageModeIntoPolicyBlock(policyBlock: Record<string, unknown>): {
  readonly wrote: boolean;
  readonly mode: CoverageMode;
} {
  if ("coverageMode" in policyBlock && isCoverageMode(policyBlock.coverageMode)) {
    return { wrote: false, mode: policyBlock.coverageMode };
  }
  if (!("coverageMode" in policyBlock) || policyBlock.coverageMode === null) {
    policyBlock.coverageMode = INSTALL_SEED_COVERAGE_MODE;
    return { wrote: true, mode: INSTALL_SEED_COVERAGE_MODE };
  }
  return { wrote: false, mode: "full" };
}

/**
 * Repair helper: keep an explicit typed mode; do not overwrite with seed.
 * Malformed values are left for resolveCoverageModeFromValue to fail closed.
 */
export function preserveExplicitCoverageMode(
  policyBlock: Record<string, unknown>,
): CoverageMode | null {
  const existing = policyBlock.coverageMode;
  return isCoverageMode(existing) ? existing : null;
}

export function formatCoverageModeStatusLine(policy: CoverageModeResolved): string {
  return "[deft policy] coverageMode=" + policy.mode + " (source=" + policy.source + ").";
}

function fieldFromResolved(resolved: CoverageModeResolved): CoverageModePolicyField {
  return {
    name: FIELD_COVERAGE_MODE,
    current: resolved.mode,
    default: DEFAULT_COVERAGE_MODE,
    source: resolved.source,
  };
}

/** Inspector row for policy:show --field=coverageMode. */
export function inspectCoverageMode(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): CoverageModePolicyField {
  if (data === null) {
    // Match resolveCoverageMode enforcement: unreadable/missing file paths through projectRoot.
    if (projectRoot !== undefined) {
      return fieldFromResolved(resolveCoverageMode(projectRoot));
    }
    return fieldFromResolved(defaultResolved("default"));
  }
  const resolved = resolveCoverageModeFromPlan(data.plan);
  if (resolved.source === "default" && projectRoot !== undefined) {
    return fieldFromResolved(resolveCoverageMode(projectRoot));
  }
  return fieldFromResolved(resolved);
}

export interface SetCoverageModeOptions {
  readonly mode: CoverageMode;
  readonly confirm?: boolean;
  readonly actor?: string;
  readonly note?: string;
}

export interface SetCoverageModeResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly changed: boolean;
}

/**
 * Typed graduation write path under the PROJECT-DEFINITION mutation lock.
 * Requires --confirm. No-op when the value already matches.
 */
export function setCoverageMode(
  projectRoot: string,
  options: SetCoverageModeOptions,
): SetCoverageModeResult {
  if (options.confirm !== true) {
    return {
      exitCode: 1,
      stdout:
        "coverageMode changes whether pre-PR coverage_headroom demands Istanbul.\n" +
        "  Re-run with --confirm to apply.\n" +
        "  Inspect: " +
        policyColonInvocation("show", " --field=coverageMode") +
        "\n",
      changed: false,
    };
  }
  if (!isCoverageMode(options.mode)) {
    return {
      exitCode: 2,
      stdout: "✗ " + FIELD_COVERAGE_MODE + " must be one of " + COVERAGE_MODES.join("|") + "\n",
      changed: false,
    };
  }

  void projectDefinitionPath(projectRoot);
  try {
    const mutationResult = withProjectDefinitionMutation(projectRoot, (mutation) => {
      const data = mutation.load();
      if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
        if (data.plan === undefined) {
          data.plan = {};
        } else {
          return {
            changed: false,
            error: "PROJECT-DEFINITION 'plan' is not an object",
          };
        }
      }
      const plan = data.plan as Record<string, unknown>;
      const legacyKeyMigrated = migrateLegacyPolicyKey(plan);
      const existingPolicy = plan[PLAN_POLICY_KEY];
      if (
        typeof existingPolicy !== "object" ||
        existingPolicy === null ||
        Array.isArray(existingPolicy)
      ) {
        if (existingPolicy === undefined) {
          plan[PLAN_POLICY_KEY] = {};
        } else {
          return { changed: false, error: "plan.policy is not an object" };
        }
      }
      const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
      const previous = policyBlock.coverageMode;
      const changedFlag = previous !== options.mode || legacyKeyMigrated;
      policyBlock.coverageMode = options.mode;
      if (changedFlag) {
        mutation.persist(data);
      }
      const actor = options.actor ?? policyColonInvocation("set-coverage-mode");
      const note = options.note ?? "";
      const parts = [
        "actor=" + actor,
        "coverageMode=" + options.mode,
        "previous=" + JSON.stringify(previous ?? null),
      ];
      if (note) {
        parts.push("note=" + note.replace(/\n/g, " ").replace(/\r/g, " "));
      }
      appendAuditLog(projectRoot, parts.join(" "), changedFlag);
      return { changed: changedFlag, error: null as string | null };
    });

    if (mutationResult.error !== null && mutationResult.error !== undefined) {
      return {
        exitCode: 2,
        stdout: "✗ Config error: " + mutationResult.error + "\n",
        changed: false,
      };
    }
    const changed = mutationResult.changed;

    const resolved = resolveCoverageMode(projectRoot);
    const lines = [
      "✓ " + FIELD_COVERAGE_MODE + " updated.",
      changed ? "  audit: meta/policy-changes.log updated." : "  (no-op; value already matched)",
      formatCoverageModeStatusLine(resolved),
    ];
    return { exitCode: 0, stdout: lines.join("\n") + "\n", changed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("PROJECT-DEFINITION not found")) {
      return { exitCode: 2, stdout: "✗ " + message + "\n", changed: false };
    }
    return { exitCode: 2, stdout: "✗ Config error: " + message + "\n", changed: false };
  }
}
