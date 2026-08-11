/**
 * Resolve where run-summary JSONL should go (#3282 emission matrix).
 *
 * - `DEFT_RUN_SUMMARY_PATH=<path>` → append JSONL there (explicit; warn once on write fail)
 * - `DEFT_RUN_SUMMARY_PATH=-` → stdout lines prefixed `DEFT-TLM:`
 * - unset → repo-root `.deft-run-summary.json` only when .gitignore covers it; else silent
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_RUN_SUMMARY_BASENAME,
  ENV_RUN_SUMMARY_PATH,
  type RunSummaryDestination,
} from "./types.js";

export {
  DEFAULT_RUN_SUMMARY_BASENAME,
  ENV_RUN_SUMMARY_PATH,
  RUN_SUMMARY_STDOUT_PREFIX,
  RUN_SUMMARY_WRITE_WARNING,
} from "./types.js";

/**
 * True when a .gitignore line covers the default run-summary basename.
 * Matches exact line or trailing slash variants; ignores comments.
 */
export function gitignoreCoversRunSummary(
  projectRoot: string,
  basename: string = DEFAULT_RUN_SUMMARY_BASENAME,
): boolean {
  const giPath = join(projectRoot, ".gitignore");
  if (!existsSync(giPath)) {
    return false;
  }
  let text: string;
  try {
    text = readFileSync(giPath, "utf8");
  } catch {
    return false;
  }
  const targets = new Set([basename, basename.replace(/^\.\//, "")]);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    // Strip trailing inline comments carefully (space + #).
    const bare = line.replace(/\s+#.*$/, "").trim();
    if (targets.has(bare) || targets.has(bare.replace(/^\//, ""))) {
      return true;
    }
  }
  return false;
}

export interface ResolveRunSummaryDestinationOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam for gitignore coverage. */
  readonly gitignoreCovers?: (projectRoot: string) => boolean;
}

/**
 * Resolve emission destination for the run-summary matrix (#3282).
 * Never throws — fail-open consumers treat resolution errors as silent.
 */
export function resolveRunSummaryDestination(
  projectRoot: string,
  options: ResolveRunSummaryDestinationOptions = {},
): RunSummaryDestination {
  try {
    const env = options.env ?? process.env;
    const raw = env[ENV_RUN_SUMMARY_PATH];
    if (raw !== undefined && raw.trim() === "-") {
      return { kind: "stdout" };
    }
    if (raw !== undefined && raw.trim().length > 0) {
      const trimmed = raw.trim();
      const path = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
      return {
        kind: "file",
        path,
        truncateOnSessionStart: false,
        explicit: true,
      };
    }
    // Unset: default path only with gitignore coverage.
    const covers =
      options.gitignoreCovers?.(projectRoot) ?? gitignoreCoversRunSummary(projectRoot);
    if (!covers) {
      return { kind: "silent" };
    }
    return {
      kind: "file",
      path: resolve(projectRoot, DEFAULT_RUN_SUMMARY_BASENAME),
      truncateOnSessionStart: true,
      explicit: false,
    };
  } catch {
    return { kind: "silent" };
  }
}
