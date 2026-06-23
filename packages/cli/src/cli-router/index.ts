/**
 * CLI router entry: `directive <namespace> <verb>` → flat dispatcher (#1670 / #11 S3).
 */

import { type DispatchIo, dispatch } from "../dispatch.js";
import { routeArgv } from "./route-argv.js";

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
    if (io !== undefined) {
      io.writeErr(`${message}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 2;
  }
  return dispatch(routed.argv, io);
}
