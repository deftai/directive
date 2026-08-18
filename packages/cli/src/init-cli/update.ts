import { parseUpdateArgv, runRefreshDepositCli } from "@deftai/directive-core/init-deposit";
import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_UPDATE_ARGV, UPDATE_DRY_RUN_FLAGS } from "./constants.js";
import { argvWantsHelp, printUpdateHelp } from "./help.js";

/** True when the user argv asked for a plan-only dry-run (`--dry-run`/`--plan`). */
export function isUpdateDryRun(argv: readonly string[]): boolean {
  const flags = UPDATE_DRY_RUN_FLAGS as readonly string[];
  return argv.some((arg) => flags.includes(arg));
}

export function runUpdate(argv: readonly string[], io: DispatchIo): Promise<number> {
  if (argvWantsHelp(argv)) {
    printUpdateHelp(io);
    return Promise.resolve(0);
  }
  const args = parseUpdateArgv(CANONICAL_UPDATE_ARGV, argv);
  return runRefreshDepositCli({
    ...args,
    dryRun: isUpdateDryRun(argv),
    writeOut: io.writeOut,
    writeErr: io.writeErr,
  });
}
