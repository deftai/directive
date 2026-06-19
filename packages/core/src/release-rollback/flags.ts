import { DEFAULT_BASE_BRANCH } from "../release/constants.js";
import { ROLLBACK_HELP } from "./constants.js";
import type { RollbackFlags } from "./types.js";

function isFlagToken(value: string): boolean {
  if (!value.startsWith("-")) {
    return false;
  }
  if (value.startsWith("--")) {
    return true;
  }
  // Single-dash letter flags (e.g. -h), not negative numbers (e.g. -1).
  return /^-[a-zA-Z]/.test(value);
}

export function parseRollbackFlags(args: readonly string[]): RollbackFlags {
  let help = false;
  let dryRun = false;
  let allowDataLoss = false;
  let forceStrict0 = false;
  let allowLowDownloads = 0;
  let repo: string | null = null;
  let baseBranch = DEFAULT_BASE_BRANCH;
  let projectRoot: string | null = null;
  let version: string | null = null;
  const unknown: string[] = [];
  let parseError: string | null = null;

  const takeValue = (flag: string, i: number): string | null => {
    if (i + 1 >= args.length) {
      unknown.push(`${flag} (missing value)`);
      return null;
    }
    return args[i + 1] ?? null;
  };

  let i = 0;
  while (i < args.length) {
    const token = args[i] ?? "";
    if (token === "-h" || token === "--help") {
      help = true;
    } else if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--allow-data-loss") {
      allowDataLoss = true;
    } else if (token === "--force-strict-0") {
      forceStrict0 = true;
    } else if (token === "--repo") {
      repo = takeValue(token, i);
      if (repo !== null) i += 1;
    } else if (token.startsWith("--repo=")) {
      repo = token.slice("--repo=".length) || null;
      if (!repo) unknown.push("--repo= (empty value)");
    } else if (token === "--base-branch") {
      const v = takeValue(token, i);
      if (v !== null) {
        baseBranch = v;
        i += 1;
      }
    } else if (token.startsWith("--base-branch=")) {
      const v = token.slice("--base-branch=".length);
      if (v) baseBranch = v;
      else unknown.push("--base-branch= (empty value)");
    } else if (token === "--project-root") {
      projectRoot = takeValue(token, i);
      if (projectRoot !== null) i += 1;
    } else if (token.startsWith("--project-root=")) {
      projectRoot = token.slice("--project-root=".length) || null;
      if (!projectRoot) unknown.push("--project-root= (empty value)");
    } else if (token === "--allow-low-downloads") {
      if (i + 1 >= args.length) {
        parseError = "argument --allow-low-downloads: expected one argument";
      } else {
        const v = args[i + 1] ?? "";
        if (isFlagToken(v)) {
          parseError = "argument --allow-low-downloads: expected one argument";
        } else {
          const parsed = Number.parseInt(v, 10);
          allowLowDownloads = Number.isNaN(parsed) ? 0 : parsed;
          i += 1;
        }
      }
    } else if (token.startsWith("--allow-low-downloads=")) {
      const v = token.slice("--allow-low-downloads=".length);
      const parsed = Number.parseInt(v, 10);
      allowLowDownloads = Number.isNaN(parsed) ? 0 : parsed;
    } else if (token.startsWith("-")) {
      unknown.push(token);
    } else if (version === null) {
      version = token;
    } else {
      unknown.push(token);
    }
    i += 1;
    // argparse aborts on the first parse error and never reaches later tokens;
    // match that so a swallowed value (e.g. `--allow-low-downloads --dry-run`)
    // cannot leak the following flag into a parsed field.
    if (parseError !== null) {
      break;
    }
  }

  return {
    help,
    version,
    repo,
    baseBranch,
    projectRoot,
    dryRun,
    allowLowDownloads,
    allowDataLoss,
    forceStrict0,
    unknown,
    parseError,
  };
}

export function formatRollbackHelp(): string {
  return ROLLBACK_HELP;
}
