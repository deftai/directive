/**
 * Shadow observation of Shell tool decisions (#3438 follow-up).
 *
 * The dest-form gate is a guardrail with known fail-open classes (unrecognized
 * mutators, interpreters, non-literal verbs) and, before this, **nothing on the
 * allow path was recorded** — `recordAuthzAudit` returns early unless UAT is
 * active or an authz deny occurred, so a bypass left no trace at all. That made
 * every claim about "what agents actually run" speculative.
 *
 * This records every Shell decision, allow included, so the fail-open surface
 * can be MEASURED rather than argued about. It changes no verdict.
 *
 * ⊗ Not a security control. It observes; it does not enforce.
 */

import { resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import type { ProductDestForm } from "./dest-form.js";

/** `.deft/` is gitignored, so observations never reach a commit. */
export const SHELL_OBSERVATION_RELPATH = ".deft/shell-observations.jsonl";

/**
 * Commands can carry secrets (tokens on a curl line, credentials in an env
 * assignment). Observations stay local, but cap the recorded command so a
 * pathological payload cannot bloat the log.
 */
export const SHELL_OBSERVATION_COMMAND_CAP = 2000;

export interface ShellObservation {
  readonly schemaVersion: 1;
  readonly ts: string;
  readonly host: string;
  readonly toolName: string;
  /** Truncated to SHELL_OBSERVATION_COMMAND_CAP. */
  readonly command: string;
  readonly commandTruncated: boolean;
  readonly verdict: "allow" | "deny";
  readonly code: string;
  /** Recognized dest-form kinds, deduped and sorted. Empty when unrecognized. */
  readonly destKinds: readonly string[];
  /** True when at least one dest could not be resolved (fail-closed branch). */
  readonly unresolvedDest: boolean;
  /**
   * True when no dest-form was recognized at all — the fail-OPEN surface. These
   * are the records worth counting: `git reset --hard`, `mv`, `bash -c`, and
   * anything whose verb the tokenizer could not read.
   */
  readonly unrecognized: boolean;
}

export function shellObservationPath(projectRoot: string): string {
  return resolve(projectRoot, SHELL_OBSERVATION_RELPATH);
}

export function buildShellObservation(input: {
  readonly ts: string;
  readonly host: string;
  readonly toolName: string;
  readonly command: string;
  readonly verdict: "allow" | "deny";
  readonly code: string;
  readonly dests: readonly ProductDestForm[];
}): ShellObservation {
  const truncated = input.command.length > SHELL_OBSERVATION_COMMAND_CAP;
  const kinds = [...new Set(input.dests.map((dest) => dest.kind))].sort();
  return {
    schemaVersion: 1,
    ts: input.ts,
    host: input.host,
    toolName: input.toolName,
    command: truncated ? input.command.slice(0, SHELL_OBSERVATION_COMMAND_CAP) : input.command,
    commandTruncated: truncated,
    verdict: input.verdict,
    code: input.code,
    destKinds: kinds,
    unresolvedDest: input.dests.some((dest) => dest.expansion === true),
    unrecognized: input.dests.length === 0,
  };
}

/**
 * Append one observation. Never throws — an unwritable log must not change a
 * hook verdict, so failures are swallowed exactly like `recordAuthzAudit`.
 */
export function appendShellObservation(
  projectRoot: string,
  observation: ShellObservation,
): boolean {
  try {
    containedWrite({
      root: resolve(projectRoot),
      target: shellObservationPath(projectRoot),
      data: `${JSON.stringify(observation)}\n`,
      mode: "append",
    });
    return true;
  } catch {
    return false;
  }
}
