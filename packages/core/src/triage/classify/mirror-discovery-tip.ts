/**
 * Operator discovery tip for SCM label mirror (#3124).
 *
 * Throttled existence + get-the-most-out-of-it disclosure for cold session /
 * triage welcome / doctor. Hides after operator ack or first successful dry-run.
 * Does not fire on session re-arm (welcome skipped).
 *
 * Never auto-apply; never auto-accept into proposed/.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { containedWrite } from "../../fs/contained-write.js";
import { resolveTriageCachePath } from "../cache-path.js";

/** State file basename under xbrief/.triage-cache/. */
export const MIRROR_DISCOVERY_STATE_FILE = "scm-label-mirror-discovery-state.json";

/** Display/back-compat relative path. */
export const MIRROR_DISCOVERY_STATE_RELATIVE_PATH = join(
  "xbrief",
  ".triage-cache",
  MIRROR_DISCOVERY_STATE_FILE,
);

export interface MirrorDiscoveryState {
  /** ISO timestamp when the tip was last emitted. */
  readonly shownAt?: string;
  /** ISO timestamp when the operator acked (tip stays hidden). */
  readonly ackedAt?: string;
  /** ISO timestamp of first successful --mirror dry-run (tip stays hidden). */
  readonly successfulDryRunAt?: string;
}

export interface MirrorDiscoveryTipOptions {
  readonly now?: Date;
  readonly readState?: (path: string) => string | null;
  readonly writeState?: (path: string, content: string) => void;
  /** When false, evaluate eligibility without persisting shownAt. Default true. */
  readonly recordShown?: boolean;
}

function resolveStatePath(projectRoot: string): string {
  return resolveTriageCachePath(projectRoot, MIRROR_DISCOVERY_STATE_FILE);
}

function defaultReadState(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultWriteState(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Direct contained write (no tmp/rename) — tip state is advisory and small.
  const base = basename(path);
  containedWrite({
    root: resolve(dir),
    target: base,
    data: content,
    mode: "replace",
  });
}

export function parseMirrorDiscoveryState(text: string | null): MirrorDiscoveryState {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        ...(typeof obj.shownAt === "string" ? { shownAt: obj.shownAt } : {}),
        ...(typeof obj.ackedAt === "string" ? { ackedAt: obj.ackedAt } : {}),
        ...(typeof obj.successfulDryRunAt === "string"
          ? { successfulDryRunAt: obj.successfulDryRunAt }
          : {}),
      };
    }
  } catch {
    // Corrupt advisory state never blocks ceremony.
  }
  return {};
}

export function readMirrorDiscoveryState(
  projectRoot: string,
  options: Pick<MirrorDiscoveryTipOptions, "readState"> = {},
): MirrorDiscoveryState {
  const path = resolveStatePath(projectRoot);
  const read = options.readState ?? defaultReadState;
  return parseMirrorDiscoveryState(read(path));
}

function writeMirrorDiscoveryState(
  projectRoot: string,
  state: MirrorDiscoveryState,
  options: Pick<MirrorDiscoveryTipOptions, "writeState"> = {},
): void {
  const path = resolveStatePath(projectRoot);
  const write = options.writeState ?? defaultWriteState;
  write(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** True when tip should still surface (not acked and no successful dry-run yet). */
export function isMirrorDiscoveryTipDue(
  projectRoot: string,
  options: Pick<MirrorDiscoveryTipOptions, "readState"> = {},
): boolean {
  const state = readMirrorDiscoveryState(projectRoot, options);
  if (state.ackedAt !== undefined && state.ackedAt.length > 0) return false;
  if (state.successfulDryRunAt !== undefined && state.successfulDryRunAt.length > 0) {
    return false;
  }
  return true;
}

/**
 * Recommended full five-chip machine map for consumers (#3124 / #2611).
 * Names only — do not invent vocabulary; labels must exist on GitHub.
 */
export const MIRROR_DISCOVERY_RECOMMENDED_ACTION_LABELS = {
  defer: ["triage:deferred"],
  archive: ["triage:archived"],
  accept: ["triage:lifecycle-linked"],
  escalate: ["triage:needs-human"],
} as const;

/** Dry-run command shown in the tip (open-only default). */
export const MIRROR_DISCOVERY_DRY_RUN_COMMAND = "deft triage:classify -- --mirror";

/** Operator ack command that dismisses the tip without a dry-run (#3124 Greptile). */
export const MIRROR_DISCOVERY_ACK_COMMAND = "deft triage:classify -- --ack-discovery";

/** Policy inspect command. */
export const MIRROR_DISCOVERY_POLICY_SHOW_COMMAND =
  "deft policy:show --field=plan.policy.triageLabelMirror";

/**
 * Agent-facing anti-swallow rule embedded in tip output (#3124).
 * When this tip fires, agents MUST restate existence + get-the-most in the
 * user-visible message (not only absorb ceremony output).
 */
export const MIRROR_DISCOVERY_ANTI_SWALLOW_RULE =
  "! Agent anti-swallow (#3124): when this tip fires, restate existence + get-the-most " +
  "in the **user-visible** message (not ceremony dump alone): feature is default-on; " +
  "dry-run first; defaults only stamp **triaged** on matches (control stamp, not disposition); " +
  "board usability is greatly decreased without **actionLabels** (full five-chip map); " +
  "more matches need **triageAutoClassify**; never auto-accept into proposed/; " +
  "where policy lives + policy:show; labels must exist on GitHub; " +
  "applying triaged before actionLabels skips re-enrichment on re-run; " +
  "point at consumer kit #2611 — do not invent label vocabulary.";

/**
 * Full operator-facing tip body (existence + get-the-most).
 * Kept short enough for ceremony but complete enough for PROJECT-DEFINITION edits.
 */
export function formatMirrorDiscoveryTipBody(): string {
  const mapJson = JSON.stringify(
    {
      enabled: true,
      idempotencyLabel: "triaged",
      alwaysLabels: ["triaged"],
      actionLabels: MIRROR_DISCOVERY_RECOMMENDED_ACTION_LABELS,
    },
    null,
    2,
  );
  return [
    "[deft triage] SCM label mirror discovery (#3124 / #1423):",
    "  Feature exists and is **default-on** (plan.policy.triageLabelMirror resolves even when absent).",
    `  Dry-run first (open-only default; --include-closed opt-in): \`${MIRROR_DISCOVERY_DRY_RUN_COMMAND}\``,
    "  `--apply` writes labels in batches; **never** auto-accepts into proposed/ (triage:accept is separate).",
    "  Defaults only stamp **`triaged`** on **matches** — a machine control stamp (idempotency), not a disposition board.",
    "  **Board usability is greatly decreased without `actionLabels`** — every match looks like a single triaged chip.",
    "  Recommend full five-chip map (create these labels on GitHub first, or apply fails closed):",
    "    defer→triage:deferred, archive→triage:archived, accept→triage:lifecycle-linked,",
    "    escalate→triage:needs-human (+ always triaged).",
    "  Chip setup (all five) is separate from rule aggressiveness — start rules minimal; escalate carefully.",
    "  More matches → configure `plan.policy.triageAutoClassify` in PROJECT-DEFINITION",
    '    (xbrief/PROJECT-DEFINITION.xbrief.json → plan["x-directive/policy"] / docs: plan.policy.*).',
    `  Inspect: \`${MIRROR_DISCOVERY_POLICY_SHOW_COMMAND}\` (and triageAutoClassify).`,
    "  Labels must **exist on GitHub** (policy JSON alone is insufficient).",
    "  Warn: applying triaged **before** actionLabels stamps issues that re-run then skips",
    "    (use --mirror --re-enrich later for additive chips; #3197).",
    "  Recommended consumer labels + PD sketch: consumer kit **#2611**",
    "    (content/docs/consumer-issue-label-kit.md) — do not invent new triage:* vocabulary.",
    "  Depth: commands.md § triage:classify --mirror; tip hides after first successful dry-run",
    `    or operator ack: \`${MIRROR_DISCOVERY_ACK_COMMAND}\` (not every session re-arm).`,
    "  Recommended PD sketch:",
    ...mapJson.split("\n").map((line) => `    ${line}`),
    MIRROR_DISCOVERY_ANTI_SWALLOW_RULE,
  ].join("\n");
}

export function formatMirrorDiscoveryTip(): string {
  return `${formatMirrorDiscoveryTipBody()}\n`;
}

/**
 * Emit tip when due; record shownAt. Returns empty string when throttled.
 * Fail-open on write errors (ceremony must not hard-block).
 */
export function maybeFormatMirrorDiscoveryTip(
  projectRoot: string,
  options: MirrorDiscoveryTipOptions = {},
): string {
  if (!isMirrorDiscoveryTipDue(projectRoot, options)) {
    return "";
  }
  if (options.recordShown !== false) {
    try {
      const now = options.now ?? new Date();
      const prior = readMirrorDiscoveryState(projectRoot, options);
      writeMirrorDiscoveryState(
        projectRoot,
        {
          ...prior,
          shownAt: now.toISOString(),
        },
        options,
      );
    } catch {
      // Advisory tip state must never block welcome / session start.
    }
  }
  return formatMirrorDiscoveryTip();
}

/** Persist operator ack so the tip no longer surfaces. */
export function recordMirrorDiscoveryAcked(
  projectRoot: string,
  options: MirrorDiscoveryTipOptions = {},
): void {
  const now = options.now ?? new Date();
  const prior = readMirrorDiscoveryState(projectRoot, options);
  writeMirrorDiscoveryState(
    projectRoot,
    {
      ...prior,
      ackedAt: now.toISOString(),
    },
    options,
  );
}

/**
 * Persist first successful --mirror dry-run so the tip no longer surfaces.
 * Idempotent: keeps the earliest successfulDryRunAt.
 */
export function recordMirrorDiscoverySuccessfulDryRun(
  projectRoot: string,
  options: MirrorDiscoveryTipOptions = {},
): void {
  const prior = readMirrorDiscoveryState(projectRoot, options);
  if (prior.successfulDryRunAt !== undefined && prior.successfulDryRunAt.length > 0) {
    return;
  }
  const now = options.now ?? new Date();
  writeMirrorDiscoveryState(
    projectRoot,
    {
      ...prior,
      successfulDryRunAt: now.toISOString(),
    },
    options,
  );
}

/** State path helper for tests / docs. */
export function resolveMirrorDiscoveryStatePath(projectRoot: string): string {
  return resolveStatePath(projectRoot);
}

/** Whether a state file currently exists (tests / diagnostics). */
export function mirrorDiscoveryStateExists(projectRoot: string): boolean {
  return existsSync(resolveStatePath(projectRoot));
}

// ---------------------------------------------------------------------------
// Dry-run digest upgrade cues (#3124 SHOULD)
// ---------------------------------------------------------------------------

export interface MirrorDiscoveryDigestCueInput {
  readonly planned: number;
  readonly applied: number;
  readonly skipped_no_match: number;
  readonly skipped_already_triaged: number;
  readonly skipped_closed: number;
  readonly actionLabelsEmpty: boolean;
  readonly dry_run: boolean;
}

/** Footer when planned rows exist but actionLabels is empty. */
export const MIRROR_DISCOVERY_EMPTY_ACTION_LABELS_HINT =
  "Hint (#3124): planned matches will only gain alwaysLabels (triaged) — " +
  "set plan.policy.triageLabelMirror.actionLabels to map defer/archive/accept/escalate " +
  "to extra SCM chips (full five recommended; see consumer kit #2611). " +
  "Board usability is greatly decreased without actionLabels.";

/** Footer when open no_match dominates under universal rules. */
export const MIRROR_DISCOVERY_NO_MATCH_DOMINATION_HINT =
  "Hint (#3124): few open matches under current rules (no_match dominates) — " +
  "add plan.policy.triageAutoClassify in PROJECT-DEFINITION to classify more of the backlog.";

/**
 * Build optional digest footer lines for consumer upgrade cues.
 * Empty when neither condition holds.
 */
export function formatMirrorDiscoveryDigestCues(
  input: MirrorDiscoveryDigestCueInput,
): readonly string[] {
  const lines: string[] = [];
  const writeTotal = input.planned + input.applied;
  if (writeTotal > 0 && input.actionLabelsEmpty) {
    lines.push(MIRROR_DISCOVERY_EMPTY_ACTION_LABELS_HINT);
  }
  // Open-ish population: exclude closed_skipped from domination base.
  const openish = writeTotal + input.skipped_no_match + Math.max(0, input.skipped_already_triaged);
  if (
    input.skipped_no_match > 0 &&
    openish > 0 &&
    input.skipped_no_match >= writeTotal &&
    input.skipped_no_match * 2 >= openish
  ) {
    lines.push(MIRROR_DISCOVERY_NO_MATCH_DOMINATION_HINT);
  }
  return lines;
}
