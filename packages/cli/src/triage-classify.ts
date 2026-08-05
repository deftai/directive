#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  /** Apply batch size (rate-limit awareness). */
  batchSize: number | null;
  /** Delay ms between apply batches. */
  delayMs: number | null;
  /** Max samples in human digest. */
  sampleLimit: number | null;
  error?: string;
}

function parsePositiveInt(raw: string, flag: string): { value?: number; error?: string } {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim() || n < 0) {
    return { error: `argument ${flag}: expected a non-negative integer` };
  }
  return { value: n };
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
      const parsedInt = parsePositiveInt(value, "--batch-size");
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.batchSize = parsedInt.value ?? null;
      i += 1;
    } else if (arg?.startsWith("--batch-size=")) {
      const parsedInt = parsePositiveInt(arg.slice("--batch-size=".length), "--batch-size");
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.batchSize = parsedInt.value ?? null;
    } else if (arg === "--delay-ms") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --delay-ms: expected one argument" };
      }
      const parsedInt = parsePositiveInt(value, "--delay-ms");
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.delayMs = parsedInt.value ?? null;
      i += 1;
    } else if (arg?.startsWith("--delay-ms=")) {
      const parsedInt = parsePositiveInt(arg.slice("--delay-ms=".length), "--delay-ms");
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.delayMs = parsedInt.value ?? null;
    } else if (arg === "--sample-limit") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --sample-limit: expected one argument" };
      }
      const parsedInt = parsePositiveInt(value, "--sample-limit");
      if (parsedInt.error !== undefined) {
        return { ...parsed, error: parsedInt.error };
      }
      parsed.sampleLimit = parsedInt.value ?? null;
      i += 1;
    } else if (arg?.startsWith("--sample-limit=")) {
      const parsedInt = parsePositiveInt(arg.slice("--sample-limit=".length), "--sample-limit");
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
      parsed.batchSize !== null ||
      parsed.delayMs !== null ||
      parsed.sampleLimit !== null) &&
    !parsed.doMirror
  ) {
    return {
      ...parsed,
      error:
        "--include-closed / --batch-size / --delay-ms / --sample-limit require --mirror (#3125)",
    };
  }
  return parsed;
}

export interface RunOptions {
  /** Injected LabelClient for tests (apply path). */
  readonly labelClient?: LabelClient;
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
    const mirrorOpts: LabelMirrorOptions = {
      dryRun: !args.apply,
      repo: args.repo,
      allowCrossRepo: args.allowCrossRepo,
      includeClosed: args.includeClosed,
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
