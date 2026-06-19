import { spawnSync } from "node:child_process";
import { extractFlag } from "./argv.js";
import { buildCommand } from "./build-command.js";
import { REST_OPT_IN_VERBS } from "./constants.js";
import { ScmStubError } from "./errors.js";
import type { GhRestSeams } from "./gh-rest.js";
import { runRestList, runRestView } from "./rest-dispatch.js";

export interface MainOptions {
  readonly whichFn?: Parameters<typeof import("./binary.js").resolveBinary>[0];
  /** Subprocess seam threaded through the `--rest` path for test isolation. */
  readonly runGhApiFn?: GhRestSeams["runGhApiFn"];
}

/**
 * CLI entry point. Returns the underlying binary's exit code (or 2 on arg error).
 * Mirrors `scripts/scm.py::main`.
 */
export function main(argv: readonly string[], options: MainOptions = {}): number {
  if (argv.length < 2) {
    process.stderr.write(
      "usage: scm.py <namespace> <verb> [pass-through args...]\n" +
        "       (v1 stub: namespace=issue, verb=list|view|close|edit)\n" +
        "       --rest opt-in is supported on issue view/list (#976)\n",
    );
    return 2;
  }

  const namespace = argv[0] ?? "";
  const verb = argv[1] ?? "";
  let extra = argv.slice(2);
  const [restMode, afterRest] = extractFlag(extra, "--rest");
  extra = afterRest;

  if (restMode) {
    if (
      namespace !== "issue" ||
      !REST_OPT_IN_VERBS.includes(verb as (typeof REST_OPT_IN_VERBS)[number])
    ) {
      process.stderr.write(
        "error: --rest is only supported on 'issue {view|list}'; " +
          `got 'scm.py ${namespace} ${verb}'. Mutations (close, edit) ` +
          "still forward to gh in the v1 stub; #881 owns the full " +
          "REST migration.\n",
      );
      return 2;
    }
    const seams: GhRestSeams = {
      whichFn: options.whichFn,
      runGhApiFn: options.runGhApiFn,
    };
    const result = verb === "view" ? runRestView(extra, seams) : runRestList(extra, seams);
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    return result.exitCode;
  }

  try {
    const cmd = buildCommand(namespace, verb, extra, { whichFn: options.whichFn });
    const binary = cmd[0];
    if (binary === undefined) {
      throw new ScmStubError("internal error: empty command argv");
    }
    const proc = spawnSync(binary, cmd.slice(1), {
      stdio: "inherit",
      env: process.env,
    });
    return proc.status ?? 1;
  } catch (err: unknown) {
    if (err instanceof ScmStubError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
