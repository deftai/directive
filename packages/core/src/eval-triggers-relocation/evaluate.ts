import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { runTriggerEval } from "../eval/triggers.js";
import { matchAny } from "../orchestration/pathspec.js";

export type OutputStream = "stdout" | "stderr" | "none";

/** Glob patterns that classify a change as skill-routing / trigger eval relevant (#1586). */
export const TRIGGER_ROUTING_PATH_PATTERNS = [
  "AGENTS.md",
  "REFERENCES.md",
  "evals/trigger-cases.jsonl",
  "content/templates/agents-entry.md",
  "packages/core/src/eval/triggers.ts",
] as const;

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly skipped?: boolean;
}

export interface EvaluateOptions {
  readonly projectRoot?: string;
  readonly baseRef?: string;
  readonly staged?: boolean;
  readonly paths?: readonly string[];
  readonly quiet?: boolean;
}

/** True when *path* matches a trigger-routing home. */
export function isTriggerRoutingPath(path: string): boolean {
  return matchAny(TRIGGER_ROUTING_PATH_PATTERNS, path);
}

/** Classify a path list for trigger-routing coverage. */
export function classifyTriggerRoutingPaths(paths: readonly string[]): {
  readonly isTriggerRouting: boolean;
  readonly matchedPaths: readonly string[];
} {
  const matchedPaths = paths.filter(isTriggerRoutingPath);
  return { isTriggerRouting: matchedPaths.length > 0, matchedPaths };
}

function gitNameOnlyDiff(projectRoot: string, args: string[]): string[] | { error: string } {
  try {
    const stdout = execFileSync("git", ["-C", projectRoot, "diff", "--name-only", ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err: unknown) {
    return { error: String(err) };
  }
}

/** Collect changed paths from git (base ref or staged index). */
export function collectChangedPaths(
  projectRoot: string,
  options: { baseRef?: string; staged?: boolean },
): string[] | { error: string } {
  if (options.staged) {
    return gitNameOnlyDiff(projectRoot, ["--cached"]);
  }
  if (options.baseRef !== undefined && options.baseRef.length > 0) {
    return gitNameOnlyDiff(projectRoot, [options.baseRef, "HEAD"]);
  }
  return [];
}

function formatSkipMessage(): string {
  return (
    "✓ verify:eval-triggers-relocation: no trigger-routing paths in diff " +
    `(checked ${TRIGGER_ROUTING_PATH_PATTERNS.length} patterns).`
  );
}

function formatPassMessage(matchedPaths: readonly string[], summary: string): string {
  return (
    `✓ verify:eval-triggers-relocation: eval:triggers OK ` +
    `(routing paths: ${matchedPaths.join(", ")}; ${summary}).`
  );
}

/**
 * Conditional gate: run eval:triggers when AGENTS.md / REFERENCES.md / trigger
 * cases change (#1586). Skips (exit 0) when the diff does not touch routing homes.
 */
export function evaluate(options: EvaluateOptions = {}): EvaluateResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const quiet = options.quiet ?? false;

  let paths: string[];
  if (options.paths !== undefined) {
    paths = [...options.paths];
  } else if (options.baseRef !== undefined || options.staged) {
    const collected = collectChangedPaths(projectRoot, {
      baseRef: options.baseRef,
      staged: options.staged,
    });
    if ("error" in collected) {
      return {
        code: 2,
        message:
          "❌ verify:eval-triggers-relocation: could not read git diff " +
          `(project_root=${projectRoot}): ${collected.error}`,
        stream: "stderr",
      };
    }
    paths = collected;
  } else {
    return { code: 0, message: "", stream: "none", skipped: true };
  }

  const { isTriggerRouting, matchedPaths } = classifyTriggerRoutingPaths(paths);
  if (!isTriggerRouting) {
    if (quiet) {
      return { code: 0, message: "", stream: "none", skipped: true };
    }
    return {
      code: 0,
      message: formatSkipMessage(),
      stream: "stdout",
      skipped: true,
    };
  }

  const evalResult = runTriggerEval({ projectRoot });
  if (evalResult.code !== 0) {
    return {
      code: evalResult.code,
      message:
        `❌ verify:eval-triggers-relocation: eval:triggers failed on trigger-routing PR (#1586).\n` +
        `   Matched routing paths: ${matchedPaths.join(", ")}\n` +
        `   ${evalResult.message.replace(/\n/g, "\n   ")}`,
      stream: "stderr",
    };
  }

  if (quiet) {
    return { code: 0, message: "", stream: "none" };
  }
  return {
    code: 0,
    message: formatPassMessage(matchedPaths, evalResult.message),
    stream: "stdout",
  };
}
