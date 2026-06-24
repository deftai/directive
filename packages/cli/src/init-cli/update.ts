import { parseUpdateArgv, runRefreshDepositCli } from "@deftai/directive-core/init-deposit";
import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_UPDATE_ARGV } from "./constants.js";

export function runUpdate(argv: readonly string[], io: DispatchIo): Promise<number> {
  const args = parseUpdateArgv(CANONICAL_UPDATE_ARGV, argv);
  return runRefreshDepositCli({
    ...args,
    writeOut: io.writeOut,
    writeErr: io.writeErr,
  });
}
