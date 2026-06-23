import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_UPDATE_ARGV } from "./constants.js";
import { runDeftInstall } from "./run-deft-install.js";

export function runUpdate(argv: readonly string[], io: DispatchIo): number {
  return runDeftInstall({
    verb: "update",
    canonicalArgv: CANONICAL_UPDATE_ARGV,
    userArgv: argv,
    io,
  });
}
