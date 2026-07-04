import {
  type InitDispatchSeams,
  parseInitArgv,
  runInitDispatchCli,
} from "@deftai/directive-core/init-deposit";
import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_INIT_ARGV, INIT_DRY_RUN_FLAGS } from "./constants.js";

/** True when the user argv asked for a classify-only dispatch plan (`--dry-run`/`--plan`). */
export function isInitDryRun(argv: readonly string[]): boolean {
  const flags = INIT_DRY_RUN_FLAGS as readonly string[];
  return argv.some((arg) => flags.includes(arg));
}

/**
 * `directive init` — the universal adoption dispatcher (#2265). Classifies the
 * directory via the shared keystone plan() fact-set and dispatches to
 * scaffold / brownfield-install / delegate-to-update / route-to-migrate. The
 * optional `seams` argument is test-only injection; the router calls the
 * two-argument form so real runs classify against the real filesystem.
 */
export function runInit(
  argv: readonly string[],
  io: DispatchIo,
  seams?: InitDispatchSeams,
): Promise<number> {
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
