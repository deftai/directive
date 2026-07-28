import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TASKFILE_INCLUDES_KEY_RE = /^(?<indent>[\t ]*)includes\s*:\s*(?:#.*)?$/i;
const TASKFILE_INCLUDE_VALUE_RE =
  /^[\t ]+taskfile\s*:\s*["']?\.?\/(?:\.deft\/core|deft)\/Taskfile\.ya?ml["']?\s*(?:#.*)?$/i;

export function includesBlockHasDeftTaskfile(text: string): boolean {
  let includesIndent: number | null = null;
  let inIncludes = false;
  for (const rawLine of text.split("\n")) {
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith("#")) {
      continue;
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    if (!inIncludes) {
      const match = TASKFILE_INCLUDES_KEY_RE.exec(rawLine);
      if (match !== null && indent === 0) {
        includesIndent = indent;
        inIncludes = true;
      }
      continue;
    }
    if (indent <= (includesIndent ?? 0)) {
      inIncludes = false;
      const match = TASKFILE_INCLUDES_KEY_RE.exec(rawLine);
      if (match !== null && indent === 0) {
        includesIndent = indent;
        inIncludes = true;
      }
      continue;
    }
    if (TASKFILE_INCLUDE_VALUE_RE.test(rawLine)) {
      return true;
    }
  }
  return false;
}

export function resolveConsumerTaskfile(projectRoot: string): string | null {
  for (const name of ["Taskfile.yml", "Taskfile.yaml"]) {
    const candidate = join(projectRoot, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export type TaskfileIncludeStatus = "ok" | "missing-file" | "missing-include" | "unreadable";

export function classifyTaskfileInclude(projectRoot: string): TaskfileIncludeStatus {
  const taskfile = resolveConsumerTaskfile(projectRoot);
  if (taskfile === null) {
    return "missing-file";
  }
  try {
    const text = readFileSync(taskfile, "utf8").replace(/^\uFEFF/, "");
    if (includesBlockHasDeftTaskfile(text)) {
      return "ok";
    }
    return "missing-include";
  } catch {
    return "unreadable";
  }
}

export function formatMissingIncludeSnippet(): string {
  return "  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n    optional: true\n";
}

/** Primary remediation for deep-think gates when Taskfile include is absent (#2893). */
export const GATES_SURFACE_DEFT_REMEDIATION =
  "Prefer `deft pr:watch` / `deft review-monitor:register` / `deft verify:review-monitor` " +
  "(primary npm/CLI surface; no Taskfile required).";

/**
 * Dual remediations for gates-surface readiness (#2893):
 * 1. `deft <verb>` CLI (works without Taskfile)
 * 2. Taskfile include so go-task exposes `task deft:<verb>` (not bare `task pr:watch`)
 */
export function formatGatesSurfaceDualRemediation(
  kind: "missing-file" | "missing-include",
): string {
  const includePart =
    kind === "missing-file"
      ? "Create root Taskfile.yml with the canonical deft include so go-task exposes `task deft:<verb>` " +
        "(not bare `task pr:watch`):\n" +
        "version: '3'\n\nincludes:\n" +
        formatMissingIncludeSnippet()
      : "Add the deft include to the existing Taskfile `includes:` block so go-task exposes " +
        "`task deft:<verb>` (doctor NEVER mutates an existing user-owned Taskfile):\n" +
        formatMissingIncludeSnippet();
  return `${GATES_SURFACE_DEFT_REMEDIATION}\n2. ${includePart}`;
}
