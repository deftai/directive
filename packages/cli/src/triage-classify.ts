#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ResolveAuthenticatedLogin,
  resolveAuthorFilter,
} from "@deftai/directive-core/dist/triage/author-filter.js";
import {
  type LabelMirrorOptions,
  labelMirrorOutcomeToJson,
  listProject,
  mirrorLabels,
  renderLabelMirrorReport,
  validateProject,
} from "@deftai/directive-core/dist/triage/classify/index.js";
import type { LabelClient } from "@deftai/directive-core/dist/vbrief-reconcile/types.js";

export interface ParsedArgs {
  projectRoot: string;
  doList: boolean;
  doValidate: boolean;
  doMirror: boolean;
  apply: boolean;
  json: boolean;
  repo: string | null;
  allowCrossRepo: boolean;
  /** Opt-in: include closed issues (default open-only, #3125). */
  includeClosed: boolean;
  /** Raw --author value (LOGIN, @me, comma allow-list); null = no filter (#3129). */
  author: string | null;
  /** Apply batch size (rate-limit awareness). */
  batchSize: number | null;
  /** Delay ms between apply batches. */
  delayMs: number | null;
  /** Max samples in human digest. */
  sampleLimit: number | null;
  error?: string;
}

function parseNonNegInt(raw: string, flag: string): { value?: number; error?: string } {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim() || n < 0) {
    return { error: `argument ${flag}: expected a non-negative integer` };
  }
  return { value: n };
}

/** Batch size must be >= 1 (0 would silently fall back in core). */
function parseBatchSize(raw: string): { value?: number; error?: string } {
  const parsed = parseNonNegInt(raw, "--batch-size");
  if (parsed.error !== undefined) {
    return parsed;
  }
  if ((parsed.value ?? 0) < 1) {
    return {
      error: "argument --batch-size: expected an integer >= 1 (omit flag for default 10)",
    };
  }
  return parsed;
}

/** Parse triage-classify CLI args (#1129 + #1423 Wave 1/2 mirror flags). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    doList: false,
    doValidate: false,
    doMirror: false,
    apply: false,
    json: false,
    repo: null,
    allowCrossRepo: false,
    includeClosed: false,
    author: null,
    batchSize: null,
    delayMs: null,
    sampleLimit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      parsed.doList = true;
    } else if (arg === "--validate") {
      parsed.doValidate = true;
    } else if (arg === "--mirror") {
      parsed.doMirror = true;
    } else if (arg === "--apply") {
      parsed.apply = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--allow-cross-repo") {
      parsed.allowCrossRepo = true;
    } else if (arg === "--include-closed") {
      parsed.includeClosed = true;
    } else if (arg === "--author-mine") {
      parsed.author = "@me";
    } else if (arg === "--author") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --author: expected one argument" };
      }
      // Reject adjacent flags (e.g. `--author --apply`) so they are not
      // swallowed as logins (#3129 Greptile P1 adjacent-option).
      if (value.startsWith("-")) {
        return {
          ...parsed,
          error: `argument --author: expected a login (or @me), got flag token '${value}'`,
        };
      }
      parsed.author = value;
      i += 1;
    } else if (arg?.startsWith("--author=")) {
      const value = arg.slice("--author=".length);
      if (value.startsWith("-") && value.length > 1) {
        return {
          ...parsed,
          error: `argument --author: expected a login (or @me), got flag token '${value}'`,
        };
      }
      parsed.author = value;
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --repo: expected one argument" };
      }
      parsed.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg === "--batch-size") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --batch-size: expected one argument" };
      }
      const parsedInt = parseBatchSize(value);
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.batchSize = parsedInt.value ?? null;
      i += 1;
    } else if (arg?.startsWith("--batch-size=")) {
      const parsedInt = parseBatchSize(arg.slice("--batch-size=".length));
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.batchSize = parsedInt.value ?? null;
    } else if (arg === "--delay-ms") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --delay-ms: expected one argument" };
      }
      const parsedInt = parseNonNegInt(value, "--delay-ms");
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.delayMs = parsedInt.value ?? null;
      i += 1;
    } else if (arg?.startsWith("--delay-ms=")) {
      const parsedInt = parseNonNegInt(arg.slice("--delay-ms=".length), "--delay-ms");
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.delayMs = parsedInt.value ?? null;
    } else if (arg === "--sample-limit") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --sample-limit: expected one argument" };
      }
      const parsedInt = parseNonNegInt(value, "--sample-limit");
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.sampleLimit = parsedInt.value ?? null;
      i += 1;
    } else if (arg?.startsWith("--sample-limit=")) {
      const parsedInt = parseNonNegInt(arg.slice("--sample-limit=".length), "--sample-limit");
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.sampleLimit = parsedInt.value ?? null;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--help" || arg === "-h") {
      return parsed;
    } else if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    }
  }
  if (parsed.apply && !parsed.doMirror) {
    return {
      ...parsed,
      error: "--apply requires --mirror (Tier-1 label mirror / bootstrap mass-triage, #1423)",
    };
  }
  if (
    (parsed.includeClosed ||
      parsed.author !== null ||
      parsed.batchSize !== null ||
      parsed.delayMs !== null ||
      parsed.sampleLimit !== null) &&
    !parsed.doMirror
  ) {
    return {
      ...parsed,
      error:
        "--include-closed / --author / --batch-size / --delay-ms / --sample-limit require --mirror (#3125 / #3129)",
    };
  }
  return parsed;
}

export interface RunOptions {
  /** Injected LabelClient for tests (apply path). */
  readonly labelClient?: LabelClient;
  /** Override `@me` resolution for hermetic tests (#3129). */
  readonly resolveAuthenticatedLogin?: ResolveAuthenticatedLogin;
}

/** Run the CLI and return the process exit code. */
export function run(argv: string[], options: RunOptions = {}): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`ERR: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  try {
    const st = statSync(projectRoot);
    if (!st.isDirectory()) {
      process.stderr.write(
        `ERR: --project-root ${projectRoot} does not exist or is not a directory.\n`,
      );
      return 2;
    }
  } catch {
    process.stderr.write(
      `ERR: --project-root ${projectRoot} does not exist or is not a directory.\n`,
    );
    return 2;
  }

  if (args.doValidate) {
    const result = validateProject(projectRoot);
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    return result.code;
  }

  if (args.doMirror) {
    let authorFilter: LabelMirrorOptions["authorFilter"] = null;
    // Flag present (including empty `--author=`) must resolve or fail closed —
    // never silent no-op that would plan/apply the full open cache (#3129 Greptile P1).
    if (args.author !== null) {
      const resolved = resolveAuthorFilter(args.author, options.resolveAuthenticatedLogin);
      if (resolved.error !== undefined || resolved.filter === undefined) {
        process.stderr.write(
          `ERR: ${resolved.error ?? "argument --author: expected a non-empty login (or @me)"}\n`,
        );
        return 2;
      }
      authorFilter = resolved.filter;
    }
    const mirrorOpts: LabelMirrorOptions = {
      dryRun: !args.apply,
      repo: args.repo,
      allowCrossRepo: args.allowCrossRepo,
      includeClosed: args.includeClosed,
      ...(authorFilter !== null && authorFilter !== undefined ? { authorFilter } : {}),
      ...(args.batchSize !== null ? { batchSize: args.batchSize } : {}),
      ...(args.delayMs !== null ? { delayMs: args.delayMs } : {}),
      ...(args.sampleLimit !== null ? { sampleLimit: args.sampleLimit } : {}),
      ...(options.labelClient !== undefined ? { client: options.labelClient } : {}),
    };
    const [code, outcome] = mirrorLabels(projectRoot, mirrorOpts);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(labelMirrorOutcomeToJson(outcome), null, 2)}\n`);
    } else {
      process.stdout.write(renderLabelMirrorReport(outcome));
    }
    return code;
  }

  // Default / --list: print effective rules
  process.stdout.write(listProject(projectRoot));
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
