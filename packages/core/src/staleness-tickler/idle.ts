import { runningInsideDeftRepo } from "../doctor/paths.js";
import { gitPorcelain } from "../story-ready/git.js";
import { countFilesystemInFlight } from "../triage/summary/index.js";
import type { StalenessTicklerPolicy } from "./types.js";

export interface IdleGateOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly readPorcelain?: (projectRoot: string) => string | null;
  readonly countInFlight?: (projectRoot: string) => number;
  readonly insideDeftRepo?: (projectRoot: string) => boolean;
}

export interface IdleGateResult {
  readonly ok: boolean;
  readonly reason?: string;
}

function ritualSkipActive(env: NodeJS.ProcessEnv): boolean {
  return env.DEFT_SESSION_RITUAL_SKIP === "1";
}

/** True when every #2488 idle gate passes for an interactive tickler prompt. */
export function isSafeIdlePoint(
  projectRoot: string,
  policy: StalenessTicklerPolicy,
  options: IdleGateOptions = {},
): IdleGateResult {
  const env = options.env ?? process.env;
  if (ritualSkipActive(env)) {
    return { ok: false, reason: "DEFT_SESSION_RITUAL_SKIP=1" };
  }
  if (!policy.enabled || policy.optOut) {
    return { ok: false, reason: "policy-disabled" };
  }
  const insideDeft = options.insideDeftRepo ?? ((root: string) => runningInsideDeftRepo(root));
  if (insideDeft(projectRoot)) {
    return { ok: false, reason: "framework-repo" };
  }
  const porcelain = (options.readPorcelain ?? gitPorcelain)(projectRoot);
  if (porcelain === null) {
    return { ok: false, reason: "git-undeterminable" };
  }
  if (porcelain.trim().length > 0) {
    return { ok: false, reason: "dirty-tree" };
  }
  const inFlight = (options.countInFlight ?? countFilesystemInFlight)(projectRoot);
  if (inFlight > 0) {
    return { ok: false, reason: "story-in-flight" };
  }
  return { ok: true };
}

/** Skip the tickler entirely in CI/headless ritual-skip contexts. */
export function shouldSkipTicklerEntirely(env: NodeJS.ProcessEnv = process.env): boolean {
  return ritualSkipActive(env);
}

/** Whether stdin/stdout are TTYs suitable for a blocking consent prompt. */
export function isInteractiveSession(
  env: NodeJS.ProcessEnv = process.env,
  isTty: () => boolean = () => process.stdin.isTTY === true && process.stdout.isTTY === true,
): boolean {
  if (env.DEFT_SESSION_RITUAL_SKIP === "1") {
    return false;
  }
  if (env.CI === "true" || env.CI === "1") {
    return false;
  }
  return isTty();
}
