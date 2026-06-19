import { resolveBinary } from "./binary.js";
import { ALLOWED_ISSUE_VERBS, ALLOWED_NAMESPACES } from "./constants.js";
import { ScmStubError } from "./errors.js";
import { pyRepr, pyTuple } from "./py-format.js";

export interface BuildCommandOptions {
  readonly binary?: string;
  readonly whichFn?: Parameters<typeof resolveBinary>[0];
}

/**
 * Construct the underlying `[binary, namespace, verb, *extra]` argv.
 * Mirrors `scripts/scm.py::build_command`.
 */
export function buildCommand(
  namespace: string,
  verb: string,
  extra: readonly string[],
  options: BuildCommandOptions = {},
): string[] {
  if (!ALLOWED_NAMESPACES.includes(namespace as (typeof ALLOWED_NAMESPACES)[number])) {
    throw new ScmStubError(
      `unknown scm namespace ${pyRepr(namespace)}; expected one of ` +
        `${pyTuple(ALLOWED_NAMESPACES)}. The full scm:* namespace lives at #881.`,
    );
  }
  if (
    namespace === "issue" &&
    !ALLOWED_ISSUE_VERBS.includes(verb as (typeof ALLOWED_ISSUE_VERBS)[number])
  ) {
    throw new ScmStubError(
      `unknown scm:issue verb ${pyRepr(verb)}; expected one of ` +
        `${pyTuple(ALLOWED_ISSUE_VERBS)}. The v1 stub only exposes these four; ` +
        "additional scm:issue:* commands belong on #881.",
    );
  }
  const resolved = options.binary ?? resolveBinary(options.whichFn ?? undefined);
  return [resolved, namespace, verb, ...extra];
}
