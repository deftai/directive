/**
 * Changelog entry mode (#6314 / #6286 item 3).
 *
 * `plan.policy.changelog.mode`:
 * - `inline` (default): entries are lines under `CHANGELOG.md` `[Unreleased]`.
 * - `either`: cutover; a change adds a line or a `changelog.d/` fragment.
 * - `fragments`: a change adds a `changelog.d/<issue>-<slug>.md` fragment.
 *
 * This slice only records and reports the mode. The gate and release read it
 * in a later slice. Missing or malformed values read as `inline`, today's
 * behaviour; a malformed value is reported with `source=default-on-error`.
 *
 * Inspect: `deft policy:show --field=plan.policy.changelog.mode`.
 * Set: `deft policy:set-changelog-mode -- --mode inline|either|fragments --confirm`.
 */

import { withProjectDefinitionMutation } from "../vbrief-build/project-definition-mutation.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import { appendAuditLog, loadProjectDefinition } from "./resolve.js";

/** Canonical registered policy field name. */
export const FIELD_CHANGELOG_MODE = "plan.policy.changelog.mode";

/** Short aliases for `policy:show --field=...`. */
export const FIELD_CHANGELOG_MODE_CLI_ALIASES = ["changelog.mode", "changelogMode"] as const;

export const CHANGELOG_MODES = ["inline", "either", "fragments"] as const;
export type ChangelogMode = (typeof CHANGELOG_MODES)[number];

export const DEFAULT_CHANGELOG_MODE: ChangelogMode = "inline";

export type ChangelogModeSource = "typed" | "default" | "default-on-error";

export interface ChangelogModeResolved {
  readonly mode: ChangelogMode;
  readonly source: ChangelogModeSource;
  readonly error: string | null;
}

export interface ChangelogModePolicyField {
  readonly name: typeof FIELD_CHANGELOG_MODE;
  readonly current: ChangelogMode;
  readonly default: ChangelogMode;
  readonly source: string;
}

export function isChangelogMode(value: unknown): value is ChangelogMode {
  return typeof value === "string" && (CHANGELOG_MODES as readonly string[]).includes(value);
}

export function isChangelogModeFieldName(name: string): boolean {
  return (
    name === FIELD_CHANGELOG_MODE ||
    (FIELD_CHANGELOG_MODE_CLI_ALIASES as readonly string[]).includes(name)
  );
}

function fallback(source: ChangelogModeSource, error: string | null = null): ChangelogModeResolved {
  return { mode: DEFAULT_CHANGELOG_MODE, source, error };
}

/** Resolve from an already-loaded plan object. */
export function resolveChangelogModeFromPlan(plan: unknown): ChangelogModeResolved {
  const policyBlock = readPlanPolicy(plan);
  if (policyBlock === undefined) return fallback("default");
  if (typeof policyBlock !== "object" || policyBlock === null || Array.isArray(policyBlock)) {
    return fallback("default-on-error", "plan.policy must be an object");
  }
  const changelog = (policyBlock as Record<string, unknown>).changelog;
  if (changelog === undefined || changelog === null) return fallback("default");
  if (typeof changelog !== "object" || Array.isArray(changelog)) {
    return fallback("default-on-error", "plan.policy.changelog must be an object");
  }
  const raw = (changelog as Record<string, unknown>).mode;
  if (raw === undefined || raw === null) return fallback("default");
  if (isChangelogMode(raw)) return { mode: raw, source: "typed", error: null };
  const shown = typeof raw === "string" ? JSON.stringify(raw) : typeof raw;
  return fallback(
    "default-on-error",
    `${FIELD_CHANGELOG_MODE} must be one of ${CHANGELOG_MODES.join("|")}; got ${shown}`,
  );
}

/** Resolve `plan.policy.changelog.mode` for a project root. */
export function resolveChangelogMode(projectRoot: string): ChangelogModeResolved {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    if (err?.includes("PROJECT-DEFINITION not found")) return fallback("default");
    return fallback("default-on-error", err ?? "PROJECT-DEFINITION unreadable");
  }
  return resolveChangelogModeFromPlan(data.plan);
}

export function formatChangelogModeStatusLine(resolved: ChangelogModeResolved): string {
  return `[deft policy] changelog.mode=${resolved.mode} (source=${resolved.source}).`;
}

/** Inspector row for `policy:show --field=plan.policy.changelog.mode`. */
export function inspectChangelogMode(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): ChangelogModePolicyField {
  const resolved =
    data === null
      ? projectRoot !== undefined
        ? resolveChangelogMode(projectRoot)
        : fallback("default")
      : resolveChangelogModeFromPlan(data.plan);
  return {
    name: FIELD_CHANGELOG_MODE,
    current: resolved.mode,
    default: DEFAULT_CHANGELOG_MODE,
    source: resolved.source,
  };
}

export interface SetChangelogModeOptions {
  readonly mode: string;
  readonly confirm?: boolean;
  readonly actor?: string;
  readonly note?: string;
}

export interface SetChangelogModeResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly changed: boolean;
}

function asObjectSlot(
  holder: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> | string {
  const existing = holder[key];
  if (existing === undefined || existing === null) {
    const created: Record<string, unknown> = {};
    holder[key] = created;
    return created;
  }
  if (typeof existing !== "object" || Array.isArray(existing)) {
    return `${label} is not an object`;
  }
  return existing as Record<string, unknown>;
}

/**
 * Typed write path under the PROJECT-DEFINITION mutation lock.
 * Requires --confirm. Accepts only inline|either|fragments. No-op when unchanged.
 */
export function setChangelogMode(
  projectRoot: string,
  options: SetChangelogModeOptions,
): SetChangelogModeResult {
  if (!isChangelogMode(options.mode)) {
    return {
      exitCode: 2,
      stdout: `✗ ${FIELD_CHANGELOG_MODE} must be one of ${CHANGELOG_MODES.join("|")}\n`,
      changed: false,
    };
  }
  const mode = options.mode;
  if (options.confirm !== true) {
    return {
      exitCode: 1,
      stdout:
        "changelog.mode changes where a change records its changelog entry " +
        "(inline line, changelog.d/ fragment, or either).\n" +
        "  Re-run with --confirm to apply.\n" +
        `  Inspect: ${policyColonInvocation("show", ` --field=${FIELD_CHANGELOG_MODE}`)}\n`,
      changed: false,
    };
  }
  try {
    const mutationResult = withProjectDefinitionMutation(projectRoot, (mutation) => {
      const data = mutation.load();
      const plan = asObjectSlot(
        data as Record<string, unknown>,
        "plan",
        "PROJECT-DEFINITION 'plan'",
      );
      if (typeof plan === "string") return { changed: false, error: plan };
      const legacyKeyMigrated = migrateLegacyPolicyKey(plan);
      const policyBlock = asObjectSlot(plan, PLAN_POLICY_KEY, "plan.policy");
      if (typeof policyBlock === "string") return { changed: false, error: policyBlock };
      const changelog = asObjectSlot(policyBlock, "changelog", "plan.policy.changelog");
      if (typeof changelog === "string") return { changed: false, error: changelog };
      const previous = changelog.mode;
      const changedFlag = previous !== mode || legacyKeyMigrated;
      changelog.mode = mode;
      if (changedFlag) mutation.persist(data);
      const parts = [
        `actor=${options.actor ?? policyColonInvocation("set-changelog-mode")}`,
        `changelog.mode=${mode}`,
        `previous=${JSON.stringify(previous ?? null)}`,
      ];
      const note = options.note ?? "";
      if (note) parts.push(`note=${note.replace(/[\r\n]/g, " ")}`);
      appendAuditLog(projectRoot, parts.join(" "), changedFlag);
      return { changed: changedFlag, error: null as string | null };
    });
    if (mutationResult.error !== null && mutationResult.error !== undefined) {
      return { exitCode: 2, stdout: `✗ Config error: ${mutationResult.error}\n`, changed: false };
    }
    const changed = mutationResult.changed;
    const lines = [
      `✓ ${FIELD_CHANGELOG_MODE} updated.`,
      changed ? "  audit: meta/policy-changes.log updated." : "  (no-op; value already matched)",
      formatChangelogModeStatusLine(resolveChangelogMode(projectRoot)),
    ];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, changed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("PROJECT-DEFINITION not found")) {
      return { exitCode: 2, stdout: `✗ ${message}\n`, changed: false };
    }
    return { exitCode: 2, stdout: `✗ Config error: ${message}\n`, changed: false };
  }
}
