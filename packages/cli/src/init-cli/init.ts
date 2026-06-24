import { parseInitArgv, runInitDepositCli } from "@deftai/directive-core/init-deposit";
import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_INIT_ARGV } from "./constants.js";

export function runInit(argv: readonly string[], io: DispatchIo): Promise<number> {
  const args = parseInitArgv(CANONICAL_INIT_ARGV, argv);
  return runInitDepositCli({
    ...args,
    writeOut: io.writeOut,
    writeErr: io.writeErr,
  });
}
