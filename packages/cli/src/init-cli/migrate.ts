import {
  parseInitArgv,
  runMigrateCli,
  runUntrackCoreCli,
} from "@deftai/directive-core/init-deposit";
import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_MIGRATE_ARGV, MIGRATE_UNTRACK_CORE_FLAG } from "./constants.js";
import { argvWantsHelp, printMigrateHelp } from "./help.js";

/**
 * `directive migrate` (alias `deft migrate`) -- stage-2 provenance verb (#1941):
 * stamp a canonical-vendored `.deft/core` deposit as npm-managed. Thin wrapper
 * over the core orchestrator; maps the three-state result to a 0/1/2 exit code.
 *
 * `directive migrate --untrack-core` (#2269) branches to the vendored→hybrid
 * un-commit path: `git rm --cached -r .deft/core` gated on a committed pin, plus
 * `.gitignore` reconciliation. The destructive index mutation lives ONLY there.
 */
const NO_EFFECT_CONFIRMATION_FLAGS = new Set([
  "--yes",
  "--non-interactive",
  "/yes",
  "/non-interactive",
]);

function hasUntrackCoreFlag(argv: readonly string[]): boolean {
  return argv.some(
    (arg) => arg === MIGRATE_UNTRACK_CORE_FLAG || arg === `/${MIGRATE_UNTRACK_CORE_FLAG.slice(2)}`,
  );
}

export function runMigrate(argv: readonly string[], io: DispatchIo): number {
  if (argvWantsHelp(argv)) {
    printMigrateHelp(io);
    return 0;
  }
  const args = parseInitArgv(CANONICAL_MIGRATE_ARGV, argv);

  // `migrate --untrack-core` selects the destructive un-track subcommand;
  // bare `migrate` keeps the provenance-stamp behavior below.
  if (hasUntrackCoreFlag(argv)) {
    return runUntrackCoreCli({
      projectDir: args.projectDir,
      jsonOut: args.jsonOut,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
    });
  }

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
