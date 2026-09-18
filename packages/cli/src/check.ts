#!/usr/bin/env node
/**
 * check.ts -- CLI wrapper for the context-aware `task check` orchestrator (#1854, #1713).
 *
 * Usage: deft-ts check [--framework-root <path>] [--project-root <path>] [--no-cache]
 *
 * Omitted --project-root defaults to cwd. Omitted --framework-root walks
 * explicit / DEFT_ROOT / source checkout / .deft/core / legacy deft/ and
 * fail-closes instead of resolveDefaultFrameworkRoot (#4722).
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchTaskCheck } from "@deftai/directive-core/check";
import { DEFT_REPO_POSITIVE_MARKERS } from "@deftai/directive-core/doctor";

export interface ParsedArgs {
  frameworkRoot?: string;
  projectRoot: string;
  noCache?: boolean;
  error?: string;
}

function isFrameworkSourceCheckoutAt(projectRoot: string): boolean {
  try {
    if (!statSync(join(projectRoot, "main.md")).isFile()) {
      return false;
    }
  } catch {
    return false;
  }
  return DEFT_REPO_POSITIVE_MARKERS.every((marker) => {
    try {
      return statSync(join(projectRoot, marker)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Resolve check's framework-root from `projectRoot` without last-resort
 * `resolveDefaultFrameworkRoot` (#4722). Returns null on miss (fail-closed).
 */
export function resolveCheckFrameworkRoot(
  projectRoot: string,
  explicitRoot?: string | null,
): string | null {
  const explicit = explicitRoot?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  const envRoot = process.env.DEFT_ROOT?.trim();
  if (envRoot) {
    return resolve(envRoot);
  }
  const root = resolve(projectRoot);
  if (isFrameworkSourceCheckoutAt(root)) {
    return root;
  }
  for (const rel of [join(".deft", "core"), "deft"] as const) {
    const candidate = join(root, rel);
    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let projectRoot = process.cwd();
  let explicitFrameworkRoot: string | undefined;
  let noCache = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--no-cache") {
      noCache = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--framework-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          error: "argument --framework-root: expected one argument",
        };
      }
      explicitFrameworkRoot = value;
      i += 1;
    } else if (arg.startsWith("--framework-root=")) {
      explicitFrameworkRoot = arg.slice("--framework-root=".length);
    } else {
      return {
        projectRoot,
        error: `unrecognized argument: ${arg}`,
      };
    }
  }

  const parsed: ParsedArgs = { projectRoot };
  if (noCache) {
    parsed.noCache = true;
  }
  const frameworkRoot = resolveCheckFrameworkRoot(projectRoot, explicitFrameworkRoot);
  if (frameworkRoot !== null) {
    parsed.frameworkRoot = frameworkRoot;
  }
  return parsed;
}

const FRAMEWORK_ROOT_MISS =
  "check: no framework-root at this project (source checkout, .deft/core, or legacy deft/). Run directive init.\n";

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`check: ${args.error}\n`);
    return 2;
  }
  if (args.frameworkRoot === undefined) {
    process.stderr.write(FRAMEWORK_ROOT_MISS);
    return 2;
  }
  return dispatchTaskCheck(args.frameworkRoot, args.projectRoot, { noCache: args.noCache });
}

/* v8 ignore start -- entry guard */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
/* v8 ignore stop */
