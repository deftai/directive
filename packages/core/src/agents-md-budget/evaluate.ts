import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import { resolveAgentsMdBudget } from "../policy/agents-md-budget.js";

export type OutputStream = "stdout" | "stderr" | "none";

/**
 * Layered absolute north-star for the always-on managed surface (#2372 / #2450 / #2452).
 *
 * `ABSOLUTE_MANAGED_MAX_BYTES` is the relocation north-star (<=8192 B / ~2k tok).
 * When `plan.policy.agentsMdBudget.absoluteMaxBytes` is set, growth past that seeded
 * ratchet fails closed; distance-to-north-star is always reported. Optional release-gate
 * north-star enforcement: DEFT_AGENTS_MD_BUDGET_ENFORCE_NORTH_STAR=1 (waiver:
 * DEFT_ALLOW_ABSOLUTE_BUDGET_WAIVER=1).
 *
 * DD-3 (harness-injected skill frontmatter in the meter) is deferred — this measure
 * covers the rendered managed section only.
 */
export const ABSOLUTE_MANAGED_MAX_BYTES = 8192;
export const ABSOLUTE_MANAGED_MAX_TOKENS = 2000;
/** Rough UTF-8 bytes-per-token estimate for advisory reporting (~8192 B ≈ ~2048 tok). */
export const ABSOLUTE_BYTES_PER_TOKEN_ESTIMATE = 4;

/** Byte + estimated-token measure of the managed section body. */
export interface ManagedSectionMeasure {
  readonly bytes: number;
  readonly estimatedTokens: number;
}

/** Result of verify:agents-md-budget evaluation; three-state exit contract. */
export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  /** North-star distance note (#2452); may accompany success or failure paths. */
  readonly northStarMessage?: string;
  readonly northStarStream?: OutputStream;
  /** @deprecated Use northStarMessage — retained for one release of CLI compat. */
  readonly advisoryMessage?: string;
  /** @deprecated Use northStarStream — retained for one release of CLI compat. */
  readonly advisoryStream?: OutputStream;
}

export interface EvaluateOptions {
  readonly quiet?: boolean;
}

/** Per-region line counts of an AGENTS.md file. */
export interface RegionCounts {
  readonly total: number;
  readonly managed: number;
  readonly unmanaged: number;
}

const OPEN_MARKER_PREFIX = "<!-- deft:managed-section";

/**
 * Split AGENTS.md into managed / unmanaged line counts.
 *
 * Returns `{ counts }` on success, or `{ error }` when the managed markers are
 * malformed (exactly one marker present, or close-before-open). A file with no
 * markers at all is valid: the whole file counts as unmanaged.
 */
export function countRegions(text: string): { counts: RegionCounts } | { error: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Ignore the trailing empty element produced by a final newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const total = lines.length;

  const openLine = lines.findIndex((l) => l.startsWith(OPEN_MARKER_PREFIX));
  const closeLine = lines.findIndex((l) => l.trim().startsWith(AGENTS_MANAGED_CLOSE));
  const openCount = lines.filter((l) => l.startsWith(OPEN_MARKER_PREFIX)).length;
  const closeCount = lines.filter((l) => l.trim().startsWith(AGENTS_MANAGED_CLOSE)).length;

  if (openLine === -1 && closeLine === -1) {
    return { counts: { total, managed: 0, unmanaged: total } };
  }
  // Malformed if a marker is missing, close precedes open, or either marker is
  // duplicated -- the contract promises exactly one open/close pair.
  if (
    openLine === -1 ||
    closeLine === -1 ||
    closeLine < openLine ||
    openCount > 1 ||
    closeCount > 1
  ) {
    return {
      error:
        "AGENTS.md managed-section markers are malformed " +
        `(open@${openLine === -1 ? "none" : openLine + 1}×${openCount}, ` +
        `close@${closeLine === -1 ? "none" : closeLine + 1}×${closeCount}); ` +
        "expected a single <!-- deft:managed-section ... --> ... " +
        "<!-- /deft:managed-section --> pair.",
    };
  }

  const managed = closeLine - openLine + 1;
  return { counts: { total, managed, unmanaged: total - managed } };
}

/**
 * Extract the managed-section span (open marker through close marker, inclusive).
 *
 * Returns an empty section when no markers are present — consistent with
 * `countRegions` treating markerless files as entirely unmanaged.
 */
export function extractManagedSection(text: string): { section: string } | { error: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const openLine = lines.findIndex((l) => l.startsWith(OPEN_MARKER_PREFIX));
  const closeLine = lines.findIndex((l) => l.trim().startsWith(AGENTS_MANAGED_CLOSE));
  const openCount = lines.filter((l) => l.startsWith(OPEN_MARKER_PREFIX)).length;
  const closeCount = lines.filter((l) => l.trim().startsWith(AGENTS_MANAGED_CLOSE)).length;

  if (openLine === -1 && closeLine === -1) {
    return { section: "" };
  }
  if (
    openLine === -1 ||
    closeLine === -1 ||
    closeLine < openLine ||
    openCount > 1 ||
    closeCount > 1
  ) {
    return {
      error:
        "AGENTS.md managed-section markers are malformed " +
        `(open@${openLine === -1 ? "none" : openLine + 1}×${openCount}, ` +
        `close@${closeLine === -1 ? "none" : closeLine + 1}×${closeCount}); ` +
        "expected a single <!-- deft:managed-section ... --> ... " +
        "<!-- /deft:managed-section --> pair.",
    };
  }

  return { section: lines.slice(openLine, closeLine + 1).join("\n") };
}

/** Measure UTF-8 byte length and a rough token estimate for the managed section. */
export function measureManagedSection(text: string): ManagedSectionMeasure | { error: string } {
  const extracted = extractManagedSection(text);
  if ("error" in extracted) {
    return extracted;
  }
  const bytes = Buffer.byteLength(extracted.section, "utf8");
  return {
    bytes,
    estimatedTokens: Math.ceil(bytes / ABSOLUTE_BYTES_PER_TOKEN_ESTIMATE),
  };
}

function formatNorthStarOverage(measure: ManagedSectionMeasure): string {
  const parts: string[] = [];
  const overBytes = measure.bytes - ABSOLUTE_MANAGED_MAX_BYTES;
  const overTokens = measure.estimatedTokens - ABSOLUTE_MANAGED_MAX_TOKENS;
  if (overBytes > 0) {
    parts.push(`${overBytes} bytes over`);
  }
  if (overTokens > 0) {
    parts.push(`~${overTokens} tok over`);
  }
  return parts.join(", ");
}

function formatNorthStarDistance(measure: ManagedSectionMeasure): string {
  const overBytes = measure.bytes - ABSOLUTE_MANAGED_MAX_BYTES;
  const overTokens = measure.estimatedTokens - ABSOLUTE_MANAGED_MAX_TOKENS;
  if (overBytes <= 0 && overTokens <= 0) {
    return (
      `north-star: ${measure.bytes} bytes (~${measure.estimatedTokens} tok) within ` +
      `≤${ABSOLUTE_MANAGED_MAX_BYTES} B / ~${ABSOLUTE_MANAGED_MAX_TOKENS} tok target.`
    );
  }
  return (
    `north-star: ≤${ABSOLUTE_MANAGED_MAX_BYTES} B / ~${ABSOLUTE_MANAGED_MAX_TOKENS} tok ` +
    `(current ${measure.bytes} bytes / ~${measure.estimatedTokens} tok — ` +
    `${formatNorthStarOverage(measure)}).`
  );
}

function formatAbsoluteAdvisory(measure: ManagedSectionMeasure): string {
  return (
    `⚠ verify:agents-md-budget: managed section absolute budget advisory — ` +
    `${measure.bytes} bytes (~${measure.estimatedTokens} tok) exceeds the north-star ` +
    `of ${ABSOLUTE_MANAGED_MAX_BYTES} bytes / ~${ABSOLUTE_MANAGED_MAX_TOKENS} tok ` +
    `(OVER: ${formatNorthStarOverage(measure)}). Advisory only — set ` +
    "plan.policy.agentsMdBudget.absoluteMaxBytes to enable fail-closed growth ratchet (#2452).\n" +
    "  The relative line ratchet (#645) remains fail-closed.\n" +
    "  DD-3 harness skill frontmatter is not yet included in this meter."
  );
}

function formatAbsoluteRefusal(
  measure: ManagedSectionMeasure,
  absoluteMaxBytes: number,
  projectRoot: string,
): string {
  const overBytes = measure.bytes - absoluteMaxBytes;
  return (
    `❌ verify:agents-md-budget: managed section grew past its absolute byte ratchet ` +
    `(project_root=${projectRoot}).\n` +
    `   managed section: ${measure.bytes}/${absoluteMaxBytes} bytes (OVER by ${overBytes})\n` +
    `   ${formatNorthStarDistance(measure)}\n` +
    "   AGENTS.md is a map, not a manual (#1882): push detail into a\n" +
    "   reference doc (main.md / a pack / docs/) and leave a pointer,\n" +
    "   rather than expanding AGENTS.md. See REFERENCES.md.\n" +
    "   If the growth is deliberate, raise absoluteMaxBytes in\n" +
    "   plan.policy.agentsMdBudget in PROJECT-DEFINITION (a reviewed diff). (#2452)"
  );
}

function formatNorthStarRefusal(measure: ManagedSectionMeasure, projectRoot: string): string {
  const overBytes = measure.bytes - ABSOLUTE_MANAGED_MAX_BYTES;
  return (
    `❌ verify:agents-md-budget: managed section exceeds the north-star ceiling ` +
    `(project_root=${projectRoot}, release-gate mode).\n` +
    `   managed section: ${measure.bytes}/${ABSOLUTE_MANAGED_MAX_BYTES} bytes ` +
    `(OVER by ${overBytes})\n` +
    "   Thin the managed section toward the <=8192 B / ~2k tok north-star, or set\n" +
    "   DEFT_ALLOW_ABSOLUTE_BUDGET_WAIVER=1 for a time-boxed operator waiver (#2452)."
  );
}

function enforceNorthStarEnabled(): boolean {
  return process.env.DEFT_AGENTS_MD_BUDGET_ENFORCE_NORTH_STAR === "1";
}

function northStarWaiverActive(): boolean {
  return process.env.DEFT_ALLOW_ABSOLUTE_BUDGET_WAIVER === "1";
}

function attachNorthStarNote<T extends EvaluateResult>(
  result: T,
  measure: ManagedSectionMeasure,
  options: { advisoryOnly: boolean },
): T {
  const overBytes = measure.bytes > ABSOLUTE_MANAGED_MAX_BYTES;
  const overTokens = measure.estimatedTokens > ABSOLUTE_MANAGED_MAX_TOKENS;
  if (options.advisoryOnly) {
    if (!overBytes && !overTokens) {
      return result;
    }
    return {
      ...result,
      northStarMessage: formatAbsoluteAdvisory(measure),
      northStarStream: "stderr",
      advisoryMessage: formatAbsoluteAdvisory(measure),
      advisoryStream: "stderr",
    };
  }
  const distance = formatNorthStarDistance(measure);
  return {
    ...result,
    northStarMessage: distance,
    northStarStream: "stderr",
    advisoryMessage: distance,
    advisoryStream: "stderr",
  };
}

function formatAbsoluteSummary(measure: ManagedSectionMeasure, absoluteMaxBytes: number): string {
  return `absolute ${measure.bytes}/${absoluteMaxBytes} bytes (~${measure.estimatedTokens} tok)`;
}

function formatRefusal(
  counts: RegionCounts,
  managedMax: number,
  unmanagedMax: number,
  projectRoot: string,
): string {
  const over: string[] = [];
  if (counts.managed > managedMax) {
    over.push(
      `   managed region:   ${counts.managed}/${managedMax} lines (OVER by ${counts.managed - managedMax})`,
    );
  }
  if (counts.unmanaged > unmanagedMax) {
    over.push(
      `   unmanaged region: ${counts.unmanaged}/${unmanagedMax} lines (OVER by ${counts.unmanaged - unmanagedMax})`,
    );
  }
  return (
    `❌ verify:agents-md-budget: AGENTS.md grew past its ratchet ` +
    `(project_root=${projectRoot}).\n` +
    `${over.join("\n")}\n` +
    "   AGENTS.md is a map, not a manual (#1882): push detail into a\n" +
    "   reference doc (main.md / a pack / docs/) and leave a pointer,\n" +
    "   rather than expanding AGENTS.md. See REFERENCES.md.\n" +
    "   If the growth is deliberate, raise the matching line in\n" +
    "   plan.policy.agentsMdBudget in PROJECT-DEFINITION (a reviewed diff). (#645)"
  );
}

/**
 * Pure evaluator for the AGENTS.md line-budget ratchet gate (#645).
 *
 * Counts the managed section and the unmanaged region separately (the #1309
 * propagation duplicates content across the marker) and fails when either
 * region exceeds its typed per-region budget. Ships green because the budget is
 * seeded at current size; growth past the ratchet fails.
 */
export function evaluate(projectRoot: string, options: EvaluateOptions = {}): EvaluateResult {
  const root = resolve(projectRoot);
  const quiet = options.quiet ?? false;

  const budgetResult = resolveAgentsMdBudget(root);
  if (budgetResult.source === "default-on-error") {
    return {
      code: 2,
      message: `❌ verify:agents-md-budget: PROJECT-DEFINITION malformed: ${budgetResult.error}`,
      stream: "stderr",
    };
  }

  const agentsPath = join(root, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    return {
      code: 2,
      message: `❌ verify:agents-md-budget: AGENTS.md not found at ${agentsPath}`,
      stream: "stderr",
    };
  }

  let text: string;
  try {
    text = readFileSync(agentsPath, { encoding: "utf8" });
  } catch (err: unknown) {
    return {
      code: 2,
      message: `❌ verify:agents-md-budget: AGENTS.md at ${agentsPath} cannot be read: ${String(err)}`,
      stream: "stderr",
    };
  }

  const regionResult = countRegions(text);
  if ("error" in regionResult) {
    return {
      code: 2,
      message: `❌ verify:agents-md-budget: ${regionResult.error}`,
      stream: "stderr",
    };
  }
  const counts = regionResult.counts;
  const measureResult = measureManagedSection(text);
  if ("error" in measureResult) {
    return {
      code: 2,
      message: `❌ verify:agents-md-budget: ${measureResult.error}`,
      stream: "stderr",
    };
  }
  const measure = measureResult;
  const absoluteMaxBytes = budgetResult.budget?.absoluteMaxBytes;
  const advisoryOnly = absoluteMaxBytes === undefined;

  if (budgetResult.source === "unset") {
    if (quiet) {
      return attachNorthStarNote({ code: 0, message: "", stream: "none" }, measure, {
        advisoryOnly,
      });
    }
    return attachNorthStarNote(
      {
        code: 0,
        message:
          "⚠ verify:agents-md-budget: no plan.policy.agentsMdBudget configured " +
          `(managed=${counts.managed}, unmanaged=${counts.unmanaged} lines).\n` +
          "  Seed a ratchet at current size to freeze growth (#645): set\n" +
          "  plan.policy.agentsMdBudget.{managedMaxLines,unmanagedMaxLines} in " +
          "PROJECT-DEFINITION.",
        stream: "stderr",
      },
      measure,
      { advisoryOnly },
    );
  }

  /* v8 ignore start -- defensive: source "typed" always carries a non-null budget. */
  if (budgetResult.budget === null) {
    return {
      code: 2,
      message: "❌ verify:agents-md-budget: unexpected null budget for typed source",
      stream: "stderr",
    };
  }
  /* v8 ignore stop */
  const budget = budgetResult.budget;
  const overManaged = counts.managed > budget.managedMaxLines;
  const overUnmanaged = counts.unmanaged > budget.unmanagedMaxLines;

  if (overManaged || overUnmanaged) {
    return attachNorthStarNote(
      {
        code: 1,
        message: formatRefusal(counts, budget.managedMaxLines, budget.unmanagedMaxLines, root),
        stream: "stderr",
      },
      measure,
      { advisoryOnly },
    );
  }

  if (absoluteMaxBytes !== undefined && measure.bytes > absoluteMaxBytes) {
    return attachNorthStarNote(
      {
        code: 1,
        message: formatAbsoluteRefusal(measure, absoluteMaxBytes, root),
        stream: "stderr",
      },
      measure,
      { advisoryOnly: false },
    );
  }

  const overNorthStar =
    measure.bytes > ABSOLUTE_MANAGED_MAX_BYTES ||
    measure.estimatedTokens > ABSOLUTE_MANAGED_MAX_TOKENS;
  if (enforceNorthStarEnabled() && overNorthStar && !northStarWaiverActive()) {
    return attachNorthStarNote(
      {
        code: 1,
        message: formatNorthStarRefusal(measure, root),
        stream: "stderr",
      },
      measure,
      { advisoryOnly: false },
    );
  }

  const absoluteSummary =
    absoluteMaxBytes !== undefined ? `; ${formatAbsoluteSummary(measure, absoluteMaxBytes)}` : "";

  if (quiet) {
    return attachNorthStarNote({ code: 0, message: "", stream: "none" }, measure, { advisoryOnly });
  }
  return attachNorthStarNote(
    {
      code: 0,
      message:
        `✓ verify:agents-md-budget: managed ${counts.managed}/${budget.managedMaxLines}, ` +
        `unmanaged ${counts.unmanaged}/${budget.unmanagedMaxLines} lines (within ratchet)` +
        `${absoluteSummary}.`,
      stream: "stdout",
    },
    measure,
    { advisoryOnly },
  );
}
