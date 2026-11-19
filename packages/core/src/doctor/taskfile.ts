import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_PACKAGE_PATH_PREFIX } from "../install-health/constants.js";

const TASKFILE_INCLUDES_KEY_RE = /^(?<indent>[\t ]*)includes\s*:\s*(?:#.*)?$/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** The include setup writes: the installed runtime's Taskfile (#5967 item 1). */
const TASKFILE_INCLUDE_VALUE_RE = new RegExp(
  `^[\\t ]+taskfile\\s*:\\s*["']?\\.?\\/${escapeRegExp(RUNTIME_PACKAGE_PATH_PREFIX)}Taskfile\\.ya?ml["']?\\s*(?:#.*)?$`,
  "i",
);

/** Old-layout include: `.deft/core` (deleted by upgrade) or the older `deft/` folder. */
const LEGACY_TASKFILE_INCLUDE_VALUE_RE =
  /^[\t ]+taskfile\s*:\s*["']?\.?\/(?:\.deft\/core|deft)\/Taskfile\.ya?ml["']?\s*(?:#.*)?$/i;

/** The runtime include line, as setup writes it. */
export const RUNTIME_TASKFILE_INCLUDE_LINE = `taskfile: ./${RUNTIME_PACKAGE_PATH_PREFIX}Taskfile.yml`;

/** True when the root `includes:` block includes the installed runtime Taskfile. */
export function includesBlockHasDeftTaskfile(text: string): boolean {
  return includesBlockHasValue(text, TASKFILE_INCLUDE_VALUE_RE);
}

/** True when the root `includes:` block still points at an old-layout Taskfile. */
export function includesBlockHasLegacyDeftTaskfile(text: string): boolean {
  return includesBlockHasValue(text, LEGACY_TASKFILE_INCLUDE_VALUE_RE);
}

function includesBlockHasValue(text: string, valueRe: RegExp): boolean {
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
    if (valueRe.test(rawLine)) {
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

export type TaskfileIncludeStatus =
  | "ok"
  | "missing-file"
  | "missing-include"
  | "legacy-include"
  | "unreadable";

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
    if (includesBlockHasLegacyDeftTaskfile(text)) {
      return "legacy-include";
    }
    return "missing-include";
  } catch {
    return "unreadable";
  }
}

export function formatMissingIncludeSnippet(): string {
  return `  deft:\n    ${RUNTIME_TASKFILE_INCLUDE_LINE}\n    optional: true\n`;
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
