/**
 * skill-external-fetch-gate.ts -- deterministic gate for fetch-then-execute skill prose (#1936 / #1532).
 *
 * Production entry for scanSkillsForExternalFetchViolations: wired into
 * `task verify:skill-external-fetch-gate` and `check:framework-source`.
 *
 * Exit codes (three-state):
 *   0 -- clean: every shipped skill with external-fetch language has Security context mitigation.
 *   1 -- drift: one or more skills pair fetch/follow-through with execute/install without mitigation.
 *   2 -- config error: skills directory missing or unreadable.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { listSkillMdEntriesFromRoot } from "../content-contracts/skills/helpers.js";
import { scanSkillsForExternalFetchViolations } from "../content-contracts/skills/skill-external-fetch-gate.js";

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_CONFIG_ERROR = 2;

export interface SkillExternalFetchGateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
}

function resolveSkillsRoot(projectRoot: string): string | null {
  const root = resolve(projectRoot);
  const underContent = join(root, "content", "skills");
  if (existsSync(underContent)) {
    return underContent;
  }
  const flat = join(root, "skills");
  if (existsSync(flat)) {
    return flat;
  }
  return null;
}

/**
 * Evaluate the skill external-fetch gate for a framework-source or consumer tree.
 */
export function evaluateSkillExternalFetchGate(projectRoot: string): SkillExternalFetchGateResult {
  const root = resolve(projectRoot);
  const skillsRoot = resolveSkillsRoot(root);
  if (skillsRoot === null) {
    return {
      code: EXIT_CONFIG_ERROR,
      message: `skill external-fetch gate: skills directory not found under ${root}`,
      stream: "stderr",
    };
  }

  let entries: ReadonlyArray<{ path: string; text: string }>;
  try {
    entries = listSkillMdEntriesFromRoot(root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      code: EXIT_CONFIG_ERROR,
      message: `skill external-fetch gate: failed to read skills under ${skillsRoot}: ${msg}`,
      stream: "stderr",
    };
  }

  const violations = scanSkillsForExternalFetchViolations(entries);
  if (violations.length > 0) {
    const lines = [
      `FAIL: skill external-fetch gate detected ${violations.length} violation(s):`,
      ...violations.map((v) => `  - ${v.skillPath}: ${v.detail}`),
    ];
    return { code: EXIT_DRIFT, message: lines.join("\n"), stream: "stderr" };
  }

  return {
    code: EXIT_OK,
    message: `OK: skill external-fetch gate clean -- ${entries.length} skill(s) scanned (root=${root}).`,
    stream: "stdout",
  };
}
