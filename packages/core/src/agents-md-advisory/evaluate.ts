import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { countRegions, type RegionCounts } from "../agents-md-budget/evaluate.js";
import {
  type AgentsMdAdvisorySource,
  resolveAgentsMdAdvisory,
} from "../policy/agents-md-advisory.js";

export type OutputStream = "stdout" | "stderr" | "none";

/**
 * Result of the consumer AGENTS.md advisory evaluation (#2155).
 *
 * `code` is 0 in the DEFAULT advisory posture no matter what -- the advisory
 * MUST NEVER fail-close a consumer build. Non-zero codes are only ever produced
 * in the explicit `--enforce` opt-in posture (1 = over the hard cap the
 * consumer asked for; 2 = a config problem that blocks an enforced check).
 */
export interface AdvisoryEvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  /** True when the unmanaged region exceeds the soft budget. */
  readonly over: boolean;
  /** Region counts, or null when AGENTS.md was missing / unreadable / malformed. */
  readonly counts: RegionCounts | null;
  /** The resolved soft budget the unmanaged region was compared against. */
  readonly softMaxLines: number;
  /** Provenance of the soft budget (typed / default / default-on-error). */
  readonly source: AgentsMdAdvisorySource;
}

export interface AdvisoryEvaluateOptions {
  /**
   * Opt-in hard-cap posture (#1419 enforce tier). When true, an over-budget
   * unmanaged region exits 1 and a config problem exits 2. Default (false) is
   * the advisory posture that always exits 0.
   */
  readonly enforce?: boolean;
  /** Suppress the within-budget "OK" line (used by aggregate callers). */
  readonly quiet?: boolean;
}

const GUIDANCE_LINE =
  "  AGENTS.md is a map, not a manual (#1882): push project detail into a\n" +
  "  reference doc and leave a pointer, rather than growing AGENTS.md. See\n" +
  "  content/docs/good-agents-md.md.";

function overMessage(
  counts: RegionCounts,
  softMax: number,
  enforce: boolean,
  fieldName: string,
): string {
  const over = counts.unmanaged - softMax;
  if (enforce) {
    return (
      `❌ agents-md-advisory: AGENTS.md unmanaged (project-authored) region is ` +
      `${counts.unmanaged} lines, over the enforced cap of ${softMax} (OVER by ${over}).\n` +
      `${GUIDANCE_LINE}\n` +
      `  Raise ${fieldName} in PROJECT-DEFINITION to accept the growth.`
    );
  }
  return (
    `⚠ agents-md-advisory: AGENTS.md unmanaged (project-authored) region is ` +
    `${counts.unmanaged} lines, over the soft budget of ${softMax} (OVER by ${over}). ` +
    "This is advisory only -- your build is NOT affected.\n" +
    `${GUIDANCE_LINE}\n` +
    `  This is your knob: raise ${fieldName} in PROJECT-DEFINITION to accept the\n` +
    "  growth and silence this note."
  );
}

const FIELD_NAME = "plan.policy.agentsMdAdvisory.unmanagedSoftMaxLines";

/**
 * Evaluate the consumer AGENTS.md against its soft, unmanaged-focused budget.
 *
 * Reuses the #645 region counter (`countRegions`) so the framework-owned
 * managed section is EXCLUDED from the comparison -- only the consumer-authored
 * unmanaged region is measured. In the default advisory posture the result code
 * is always 0; `--enforce` promotes over-budget / config problems to non-zero.
 */
export function evaluate(
  projectRoot: string,
  options: AdvisoryEvaluateOptions = {},
): AdvisoryEvaluateResult {
  const root = resolve(projectRoot);
  const enforce = options.enforce ?? false;
  const quiet = options.quiet ?? false;

  const advisory = resolveAgentsMdAdvisory(root);
  const softMax = advisory.config.unmanagedSoftMaxLines;

  const agentsPath = join(root, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    const message = `agents-md-advisory: no AGENTS.md found at ${agentsPath}`;
    return {
      code: enforce ? 2 : 0,
      message: enforce ? `❌ ${message}` : quiet ? "" : `${message} (advisory; skipped).`,
      stream: enforce ? "stderr" : quiet ? "none" : "stdout",
      over: false,
      counts: null,
      softMaxLines: softMax,
      source: advisory.source,
    };
  }

  let text: string;
  try {
    text = readFileSync(agentsPath, { encoding: "utf8" });
  } catch (err: unknown) {
    const message = `agents-md-advisory: AGENTS.md at ${agentsPath} cannot be read: ${String(err)}`;
    return {
      code: enforce ? 2 : 0,
      message: enforce ? `❌ ${message}` : quiet ? "" : `${message} (advisory; skipped).`,
      stream: enforce ? "stderr" : quiet ? "none" : "stdout",
      over: false,
      counts: null,
      softMaxLines: softMax,
      source: advisory.source,
    };
  }

  const regionResult = countRegions(text);
  if ("error" in regionResult) {
    const message = `agents-md-advisory: ${regionResult.error}`;
    return {
      code: enforce ? 2 : 0,
      message: enforce ? `❌ ${message}` : quiet ? "" : `${message} (advisory; skipped).`,
      stream: enforce ? "stderr" : quiet ? "none" : "stdout",
      over: false,
      counts: null,
      softMaxLines: softMax,
      source: advisory.source,
    };
  }

  const counts = regionResult.counts;
  const over = counts.unmanaged > softMax;

  if (!over) {
    if (quiet) {
      return {
        code: 0,
        message: "",
        stream: "none",
        over: false,
        counts,
        softMaxLines: softMax,
        source: advisory.source,
      };
    }
    return {
      code: 0,
      message:
        `✓ agents-md-advisory: AGENTS.md unmanaged region ${counts.unmanaged}/${softMax} lines ` +
        `within soft budget (managed ${counts.managed} excluded; advisory).`,
      stream: "stdout",
      over: false,
      counts,
      softMaxLines: softMax,
      source: advisory.source,
    };
  }

  return {
    code: enforce ? 1 : 0,
    message: overMessage(counts, softMax, enforce, FIELD_NAME),
    stream: "stderr",
    over: true,
    counts,
    softMaxLines: softMax,
    source: advisory.source,
  };
}
