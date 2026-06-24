import { parseInitArgv, runMigrateCli } from "@deftai/directive-core/init-deposit";
import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_MIGRATE_ARGV } from "./constants.js";

/**
 * `directive migrate` (alias `deft migrate`) -- stage-2 provenance verb (#1941):
 * stamp a canonical-vendored `.deft/core` deposit as npm-managed. Thin wrapper
 * over the core orchestrator; maps the three-state result to a 0/1/2 exit code.
 */
export function runMigrate(argv: readonly string[], io: DispatchIo): number {
  const args = parseInitArgv(CANONICAL_MIGRATE_ARGV, argv);
  return runMigrateCli({
    projectDir: args.projectDir,
    jsonOut: args.jsonOut,
    writeOut: io.writeOut,
    writeErr: io.writeErr,
  });
}
