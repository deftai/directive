import { activate } from "./activate.js";

export interface ParsedArgs {
  readonly vbriefPath: string | null;
  readonly error?: string;
}

/** Parse vbrief-activate CLI args, mirroring the Python argparse surface (#810). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    return { vbriefPath: null, error: "the following arguments are required: vbrief_path" };
  }
  if (argv.length > 1) {
    return { vbriefPath: null, error: `unrecognized arguments: ${argv.slice(1).join(" ")}` };
  }
  return { vbriefPath: argv[0] ?? null };
}

export interface RunOptions {
  readonly now?: Date;
}

/** Run the activator and return the process exit code (parse errors -> 2). */
export function run(argv: readonly string[], options: RunOptions = {}): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`vbrief_activate.py: ${args.error}\n`);
    return 2;
  }
  const vbriefPath = args.vbriefPath as string;
  const result = activate(vbriefPath, options);

  if (result.exitCode === 0) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

/** CLI entry alias for task wiring. */
export function cmdVbriefActivate(argv: readonly string[], options: RunOptions = {}): number {
  return run(argv, options);
}
