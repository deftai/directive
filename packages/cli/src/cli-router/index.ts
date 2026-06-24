/**
 * CLI router entry: `directive <namespace> <verb>` → flat dispatcher (#1670 / #11 S3).
 */

import { type DispatchIo, dispatch } from "../dispatch.js";
import { runInit } from "../init-cli/init.js";
import { runMigrate } from "../init-cli/migrate.js";
import { runUpdate } from "../init-cli/update.js";
import { routeArgv } from "./route-argv.js";

function defaultIo(): DispatchIo {
  return {
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
  };
}

export {
  DEFERRED_TOP_LEVEL_VERBS,
  PR_VERB_MAP,
  type RoutedArgv,
  type RouteKind,
  routeArgv,
  SCOPE_LIFECYCLE_VERBS,
  STUBBED_TOP_LEVEL_VERBS,
  SUBCOMMAND_ROUTES,
  TOP_LEVEL_UX_VERBS,
  taskKeyToDispatchArgv,
  VERIFY_VERB_MAP,
} from "./route-argv.js";

/** Route user argv then dispatch to the existing engine handlers. */
export async function routeAndDispatch(argv: readonly string[], io?: DispatchIo): Promise<number> {
  const routed = routeArgv(argv);
  if (routed.kind === "stub") {
    const message = routed.stubMessage ?? "directive: command not available";
    const sink = io ?? defaultIo();
    sink.writeErr(`${message}\n`);
    return 2;
  }

  const [first, ...rest] = routed.argv;
  if (first === "init") {
    return runInit(rest, io ?? defaultIo());
  }
  if (first === "update") {
    return runUpdate(rest, io ?? defaultIo());
  }
  if (first === "migrate") {
    return runMigrate(rest, io ?? defaultIo());
  }

  return dispatch(routed.argv, io);
}
