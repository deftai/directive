import {
  type HeadlessManifestSeams,
  type InitDispatchSeams,
  parseInitArgv,
  runInitDispatchCli,
  runInitHeadlessCli,
} from "@deftai/directive-core/init-deposit";
import type { DispatchIo } from "../dispatch.js";
import {
  CANONICAL_INIT_ARGV,
  INIT_DRY_RUN_FLAGS,
  INIT_HEADLESS_FLAGS,
  INIT_OUTPUT_FLAGS,
} from "./constants.js";

/** True when the user argv asked for a classify-only dispatch plan (`--dry-run`/`--plan`). */
export function isInitDryRun(argv: readonly string[]): boolean {
  const flags = INIT_DRY_RUN_FLAGS as readonly string[];
  return argv.some((arg) => flags.includes(arg));
}

/** True when the user argv asked for headless manifest-emit mode (`--headless`). */
export function isInitHeadless(argv: readonly string[]): boolean {
  const flags = INIT_HEADLESS_FLAGS as readonly string[];
  return argv.some((arg) => flags.includes(arg));
}

/**
 * Resolve the `--output=<path>` / `--output <path>` target for headless mode.
 * Returns null when no output flag is present (manifest goes to stdout).
 */
export function parseInitOutputPath(argv: readonly string[]): string | null {
  const flags = INIT_OUTPUT_FLAGS as readonly string[];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    for (const flag of flags) {
      if (arg === flag) {
        const next = argv[i + 1];
        // A next token that is itself a flag (leading `-`) is NOT a path — treat
        // `--output --headless` as a missing value rather than writing a file
        // literally named `--headless`. Absolute POSIX paths (`/foo`) are kept.
        if (next === undefined || next.length === 0 || next.startsWith("-")) return null;
        return next;
      }
      const prefix = `${flag}=`;
      if (arg.startsWith(prefix)) {
        const value = arg.slice(prefix.length);
        return value.length > 0 ? value : null;
      }
    }
  }
  return null;
}

/**
 * `directive init` — the universal adoption dispatcher (#2265). Classifies the
 * directory via the shared keystone plan() fact-set and dispatches to
 * scaffold / brownfield-install / delegate-to-update / route-to-migrate.
 *
 * When `--headless` is present (#2268), init short-circuits the executing
 * dispatch and instead serialises the merged `plan()` schema into a
 * `{ version, files }` manifest with ALL execution side effects suppressed
 * (no prompts, no git, no hook install, no writes outside `--output`).
 *
 * The optional `seams` argument is test-only injection for the dispatch path;
 * `headlessSeams` injects the content-resolution seam for the headless path.
 */
export function runInit(
  argv: readonly string[],
  io: DispatchIo,
  seams?: InitDispatchSeams,
  headlessSeams?: HeadlessManifestSeams,
): Promise<number> {
  if (isInitHeadless(argv)) {
    return runInitHeadlessCli({
      outputPath: parseInitOutputPath(argv),
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams: headlessSeams,
    });
  }
  const args = parseInitArgv(CANONICAL_INIT_ARGV, argv);
  return runInitDispatchCli({
    projectDir: args.projectDir,
    jsonOut: args.jsonOut,
    nonInteractive: args.nonInteractive,
    dryRun: isInitDryRun(argv),
    writeOut: io.writeOut,
    writeErr: io.writeErr,
    seams,
  });
}
