import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_INIT_ARGV } from "./constants.js";
import { runDeftInstall } from "./run-deft-install.js";

export function runInit(argv: readonly string[], io: DispatchIo): number {
  return runDeftInstall({
    verb: "init",
    canonicalArgv: CANONICAL_INIT_ARGV,
    userArgv: argv,
    io,
  });
}
