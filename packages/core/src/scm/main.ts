import type { LabelClient } from "../vbrief-reconcile/types.js";
import { extractFlag, peekRepoFlag } from "./argv.js";
import { spawnScmBinary } from "./binary.js";
import { buildCommand } from "./build-command.js";
import { REST_OPT_IN_VERBS } from "./constants.js";
import { DESIGN_CRITIQUE_CHIP_VERB, runDesignCritiqueChip } from "./design-critique-chip.js";
import {
  DESIGN_CRITIQUE_STALE_READY_VERB,
  runDesignCritiqueStaleReady,
  type StaleReadyScanSeams,
} from "./design-critique-stale-ready.js";
import { ScmStubError } from "./errors.js";
import type { GhRestSeams } from "./gh-rest.js";
import { requireScmReady } from "./readiness.js";
import { runRestList, runRestView } from "./rest-dispatch.js";
import { runWorkClaim, WORK_CLAIM_VERB } from "./work-claim.js";

export interface MainOptions {
  readonly whichFn?: Parameters<typeof import("./binary.js").resolveBinary>[0];
  /** Subprocess seam threaded through the `--rest` path for test isolation. */
  readonly runGhApiFn?: GhRestSeams["runGhApiFn"];
  /**
   * Skip the #2275 readiness probe (tests that inject REST seams / binary mocks).
   * Production CLI always probes.
   */
  readonly skipReadiness?: boolean;
  /** LabelClient seam for `issue design-critique-chip` (#3642) and `issue work-claim` (#4200). */
  readonly labelClient?: LabelClient;
  /** Occupancy probe seam for `issue work-claim` (#4200). */
  readonly occupancyLive?: (projectRoot: string) => boolean;
  /** Seams for `issue design-critique-stale-ready` (#4970). */
  readonly staleReadySeams?: StaleReadyScanSeams;
}

/**
 * #2275 / #3858 fail-loud credential-class gate after argv validation,
 * before network/binary work. Parses `--repo` / `-R` from pass-through
 * extra so a non-checkout explicit repo reaches the validator.
 */
function guardScmReady(options: MainOptions, extra: readonly string[] = []): number | null {
  try {
    requireScmReady({
      whichFn: options.whichFn,
      depth: "deep",
      repo: peekRepoFlag(extra),
      skipReadiness: options.skipReadiness,
      expectedPrincipal: null,
    });
    return null;
  } catch (err: unknown) {
    if (err instanceof ScmStubError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

/**
 * CLI entry point. Returns the underlying binary's exit code (or 2 on arg error).
 * Mirrors `scripts/scm.py::main`.
 */
export function main(argv: readonly string[], options: MainOptions = {}): number {
  if (argv.length < 2) {
    process.stderr.write(
      "usage: scm.py <namespace> <verb> [pass-through args...]\n" +
        "       (v1 stub: namespace=issue, verb=list|view|close|edit|design-critique-chip|design-critique-stale-ready|work-claim)\n" +
        "       --rest opt-in is supported on issue view/list (#976)\n",
    );
    return 2;
  }

  const namespace = argv[0] ?? "";
  const verb = argv[1] ?? "";
  let extra = argv.slice(2);

  if (namespace === "issue" && verb === DESIGN_CRITIQUE_CHIP_VERB) {
    const blocked = guardScmReady(options, extra);
    if (blocked !== null) return blocked;
    const result = runDesignCritiqueChip(extra, { client: options.labelClient });
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    return result.exitCode;
  }

  if (namespace === "issue" && verb === DESIGN_CRITIQUE_STALE_READY_VERB) {
    const blocked = guardScmReady(options, extra);
    if (blocked !== null) return blocked;
    const result = runDesignCritiqueStaleReady(extra, options.staleReadySeams);
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    return result.exitCode;
  }

  if (namespace === "issue" && verb === WORK_CLAIM_VERB) {
    const blocked = guardScmReady(options, extra);
    if (blocked !== null) return blocked;
    const result = runWorkClaim(extra, {
      client: options.labelClient,
      occupancyLive: options.occupancyLive,
      cwd: process.cwd(),
    });
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    return result.exitCode;
  }

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
    // Argv-valid REST path: still fail loud when SCM is unusable (#2275 / #3858 / #3663).
    const blocked = guardScmReady(options, extra);
    if (blocked !== null) return blocked;
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
    // Build/validate argv first so unknown namespace errors surface before readiness.
    const cmd = buildCommand(namespace, verb, extra, { whichFn: options.whichFn });
    const blocked = guardScmReady(options, extra);
    if (blocked !== null) return blocked;
    const binary = cmd[0];
    if (binary === undefined) {
      throw new ScmStubError("internal error: empty command argv");
    }
    const proc = spawnScmBinary(binary, cmd.slice(1), {
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
