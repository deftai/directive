import { parseInitArgv, runMigrateCli } from "@deftai/directive-core/init-deposit";
import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_MIGRATE_ARGV } from "./constants.js";

/**
 * `directive migrate` (alias `deft migrate`) -- stage-2 provenance verb (#1941):
 * stamp a canonical-vendored `.deft/core` deposit as npm-managed. Thin wrapper
 * over the core orchestrator; maps the three-state result to a 0/1/2 exit code.
 */
const NO_EFFECT_CONFIRMATION_FLAGS = new Set([
  "--yes",
  "--non-interactive",
  "/yes",
  "/non-interactive",
]);

export function runMigrate(argv: readonly string[], io: DispatchIo): number {
  const args = parseInitArgv(CANONICAL_MIGRATE_ARGV, argv);
  // `migrate` reuses `parseInitArgv`, which understands the init/update headless
  // confirmation flags. migrate has no interactive prompts, so acknowledge the
  // flag rather than silently swallowing it (a natural reflex from init/update).
  if (argv.some((arg) => NO_EFFECT_CONFIRMATION_FLAGS.has(arg))) {
    io.writeErr(
      "directive migrate: --yes/--non-interactive has no effect (migrate runs non-interactively and never prompts).\n",
    );
  }
  return runMigrateCli({
    projectDir: args.projectDir,
    jsonOut: args.jsonOut,
    writeOut: io.writeOut,
    writeErr: io.writeErr,
  });
}
