#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { emitJson, evaluate, PREFLIGHT_USAGE_HINT } from "@deftai/directive-core/preflight";
import { scanWorkClaimForBriefPath } from "@deftai/directive-core/scm";

interface ParsedArgs {
  vbriefPath: string | null;
  emitJson: boolean;
  help?: boolean;
  error?: string;
}

const HELP_TEXT = `usage: xbrief:preflight [--vbrief-path PATH | PATH] [--json] [--help]

Implementation-intent gate (#810): exits 0 only when the xBRIEF is in
xbrief/active/ (or legacy vbrief/active/) AND plan.status == 'running'.

Examples:
  deft xbrief:preflight -- xbrief/active/<story>.xbrief.json
  deft xbrief:preflight --vbrief-path xbrief/active/<story>.xbrief.json
`;

const PATH_FLAG_NAMES = ["--vbrief-path", "--brief-path", "--xbrief-path"] as const;

function assignPathFlag(parsed: ParsedArgs, value: string | undefined): ParsedArgs | null {
  if (value === undefined || value.length === 0) {
    return { ...parsed, error: "argument --vbrief-path: expected one argument" };
  }
  if (parsed.vbriefPath !== null) {
    return { ...parsed, error: "multiple path arguments are not allowed" };
  }
  return { ...parsed, vbriefPath: value };
}

/** Parse vbrief-preflight / xbrief:preflight CLI args (#810 / #2449). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    vbriefPath: null,
    emitJson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      parsed.emitJson = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ...parsed, help: true };
    }
    if (PATH_FLAG_NAMES.includes(arg as (typeof PATH_FLAG_NAMES)[number])) {
      // Task wrappers bake `--vbrief-path {{.CLI_ARGS}}`, so
      // `task xbrief:preflight -- --help` arrives as `--vbrief-path --help`.
      const nextToken = argv[i + 1];
      if (nextToken === "--help" || nextToken === "-h") {
        return { ...parsed, help: true };
      }
      if (nextToken !== undefined && nextToken.startsWith("-")) {
        return {
          ...parsed,
          error: "argument --vbrief-path: expected one argument",
        };
      }
      const next = assignPathFlag(parsed, nextToken);
      if (next?.error !== undefined) return next;
      parsed.vbriefPath = next?.vbriefPath ?? null;
      i += 1;
      continue;
    }
    let matchedEqualsForm = false;
    for (const flag of PATH_FLAG_NAMES) {
      if (arg?.startsWith(`${flag}=`)) {
        const next = assignPathFlag(parsed, arg.slice(flag.length + 1));
        if (next?.error !== undefined) return next;
        parsed.vbriefPath = next?.vbriefPath ?? null;
        matchedEqualsForm = true;
        break;
      }
    }
    if (matchedEqualsForm) continue;
    if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
    const next = assignPathFlag(parsed, arg);
    if (next?.error !== undefined) return next;
    parsed.vbriefPath = next?.vbriefPath ?? null;
  }
  if (parsed.vbriefPath === null) {
    return {
      ...parsed,
      error: `the following arguments are required: --vbrief-path (or positional path). ${PREFLIGHT_USAGE_HINT}`,
    };
  }
  return parsed;
}

/** Run the gate and return the process exit code (parse errors -> 2). */
export function run(
  argv: string[],
  scan: (briefPath: string) => readonly string[] = scanWorkClaimForBriefPath,
): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`preflight_implementation: ${args.error}\n`);
    return 2;
  }
  const vbriefPath = args.vbriefPath as string;
  const result = evaluate(vbriefPath);
  const scanLines = result.exitCode === 0 ? [...scan(vbriefPath)] : [];

  if (args.emitJson) {
    const message =
      scanLines.length > 0 ? `${result.message}\n${scanLines.join("\n")}` : result.message;
    process.stdout.write(`${emitJson(vbriefPath, result.exitCode, message)}\n`);
  } else if (result.exitCode === 0) {
    process.stdout.write(`${result.message}\n`);
    for (const line of scanLines) {
      process.stdout.write(`${line}\n`);
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
