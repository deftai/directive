import { resolve } from "node:path";
import { countVbriefWip, resolveWipCap } from "../policy/wip.js";

export type OutputStream = "stdout" | "stderr" | "none";

/** Result of verify:wip-cap evaluation; mirrors the Python three-state exit contract. */
export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
}

export interface EvaluateOptions {
  readonly allowOverCap?: boolean;
  readonly quiet?: boolean;
}

function formatRefusal(count: number, cap: number, projectRoot: string): string {
  return (
    `❌ verify:wip-cap: ${count}/${cap} in pending/+active/ ` +
    `(over cap; project_root=${projectRoot}).\n` +
    "   Drain the WIP set before merging:\n" +
    "     task scope:demote <existing>                       # return one to proposed/\n" +
    "     task scope:demote --batch --older-than-days 30     # bulk relief\n" +
    "   Or open a follow-up PR with --force-merge intent (audit-logged).\n" +
    "   (#1124 / D4 of #1119; see plan.policy.wipCap in " +
    "vbrief/PROJECT-DEFINITION.vbrief.json.)"
  );
}

/**
 * Pure evaluator for the WIP-cap re-validation gate (#1124 / D4 of #1119).
 * Faithful to `scripts/preflight_wip_cap.py`.
 */
export function evaluate(projectRoot: string, options: EvaluateOptions = {}): EvaluateResult {
  const root = resolve(projectRoot);
  const allowOverCap = options.allowOverCap ?? false;
  const quiet = options.quiet ?? false;

  const capResult = resolveWipCap(root);
  if (capResult.source === "default-on-error" && capResult.error !== null) {
    return {
      code: 2,
      message: `❌ verify:wip-cap: PROJECT-DEFINITION malformed: ${capResult.error}`,
      stream: "stderr",
    };
  }

  const cap = capResult.cap;
  const count = countVbriefWip(root);

  if (count < cap) {
    if (quiet) {
      return { code: 0, message: "", stream: "none" };
    }
    return {
      code: 0,
      message:
        `✓ verify:wip-cap: ${count}/${cap} in pending/+active/ ` +
        `(within cap; source=${capResult.source}).`,
      stream: "stdout",
    };
  }

  if (allowOverCap) {
    if (quiet) {
      return { code: 0, message: "", stream: "none" };
    }
    return {
      code: 0,
      message:
        `⚠ verify:wip-cap: ${count}/${cap} in pending/+active/ ` +
        "is OVER cap, but --allow-over-cap was passed (framework " +
        "landing-day grace; consumers MUST NOT use this flag).\n" +
        "  Drain via task scope:demote / task scope:demote --batch " +
        "--older-than-days 30 (#1119 umbrella v3).",
      stream: "stderr",
    };
  }

  return {
    code: 1,
    message: formatRefusal(count, cap, root),
    stream: "stderr",
  };
}
