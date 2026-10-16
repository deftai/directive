/**
 * CLI router entry: `directive <namespace> <verb>` → flat dispatcher (#1670 / #11 S3).
 */

import { type DispatchIo, dispatch } from "../dispatch.js";
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

/** A6.8 / AC1.5: runtime init/update must not rewrite the pin — redirect to launcher verbs. */
export const INIT_REFUSE_MESSAGE =
  "directive init is not available on the runtime bin. Use `directive install` (launcher).";
export const UPDATE_REFUSE_MESSAGE =
  "directive update is not available on the runtime bin. Use `directive upgrade` (launcher).";

export {
  DEFERRED_TOP_LEVEL_VERBS,
  PR_VERB_MAP,
  RETIRED_TOP_LEVEL_INSTALL_VERBS,
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

  const [first] = routed.argv;
  // A68-LEGACY-UPDATE: never call legacy runInit/runUpdate (pin reconstitution / align-pin).
  if (first === "init") {
    const sink = io ?? defaultIo();
    sink.writeErr(`${INIT_REFUSE_MESSAGE}\n`);
    return 2;
  }
  if (first === "update") {
    const sink = io ?? defaultIo();
    sink.writeErr(`${UPDATE_REFUSE_MESSAGE}\n`);
    return 2;
  }

  return dispatch(routed.argv, io);
}
