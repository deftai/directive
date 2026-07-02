import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import { resolveAgentsMdBudget } from "../policy/agents-md-budget.js";

export type OutputStream = "stdout" | "stderr" | "none";

/** Result of verify:agents-md-budget evaluation; three-state exit contract. */
export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
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

  if (budgetResult.source === "unset") {
    if (quiet) {
      return { code: 0, message: "", stream: "none" };
    }
    return {
      code: 0,
      message:
        "⚠ verify:agents-md-budget: no plan.policy.agentsMdBudget configured " +
        `(managed=${counts.managed}, unmanaged=${counts.unmanaged} lines).\n` +
        "  Seed a ratchet at current size to freeze growth (#645): set\n" +
        "  plan.policy.agentsMdBudget.{managedMaxLines,unmanagedMaxLines} in " +
        "PROJECT-DEFINITION.",
      stream: "stderr",
    };
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

  if (!overManaged && !overUnmanaged) {
    if (quiet) {
      return { code: 0, message: "", stream: "none" };
    }
    return {
      code: 0,
      message:
        `✓ verify:agents-md-budget: managed ${counts.managed}/${budget.managedMaxLines}, ` +
        `unmanaged ${counts.unmanaged}/${budget.unmanagedMaxLines} lines (within ratchet).`,
      stream: "stdout",
    };
  }

  return {
    code: 1,
    message: formatRefusal(counts, budget.managedMaxLines, budget.unmanagedMaxLines, root),
    stream: "stderr",
  };
}
