/**
 * Update-time generation rewind gate (#4120).
 *
 * Live apply pins an invocation-owned delivery-tip OID, reads the token with
 * raw object semantics, and refuses increment arms unless proposed > tip.
 * Returned-failure only: callers never mint a remote-derived integer.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  defaultGitExec,
  type GitExecFn,
  type GitExecResult,
} from "../init-deposit/update-git-preflight.js";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import {
  inspectLocalGeneration,
  type LocalGenerationInspection,
  nextLiveGenerationNumber,
  parseLiveGeneration,
} from "./generation.js";
import type { LiveGeneration } from "./types.js";

export const GENERATION_REWIND_ERROR_CODE = "generation_rewind" as const;

export const GENERATION_GIT_PATH = ".deft/GENERATION.json";

export const GENERATION_REWIND_RECOVERY =
  "pull or rebase onto the delivery branch, then re-run update";

export const GENERATION_UNREADABLE_RECOVERY =
  "retry when the remote is reachable; pull or rebase when behind; upgrade git if fetch rejected unknown options";

const RETIRED_SINGLETON_TIP_REF = "refs/deft/delivery-tip";

export type GenerationTipState =
  | { readonly kind: "known-at-oid"; readonly generation: number; readonly oid: string }
  | { readonly kind: "proven-absent-at-oid"; readonly oid: string }
  | { readonly kind: "no-remote" }
  | { readonly kind: "delivery-ref-absent-on-remote" }
  | { readonly kind: "remote-configured-unreadable"; readonly detail: string };

export type GenerationDecision =
  | { readonly action: "stamp"; readonly generation: number }
  | { readonly action: "keep-prior" }
  | {
      readonly action: "refuse";
      readonly error_code: typeof GENERATION_REWIND_ERROR_CODE;
      readonly message: string;
      readonly recovery: string;
    };

export interface PinDeliveryTipInput {
  readonly projectDir: string;
  readonly remote: string;
  readonly branch: string;
  readonly runId?: string;
  readonly execGit?: GitExecFn;
}

export interface PinDeliveryTipSuccess {
  readonly ok: true;
  readonly oid: string;
  readonly runId: string;
  readonly ref: string;
  readonly fetchArgs: readonly string[];
}

export interface PinDeliveryTipFailure {
  readonly ok: false;
  readonly runId: string;
  readonly ref: string;
  readonly fetchArgs: readonly string[];
  readonly status: number;
  readonly stderr: string;
}

export type PinDeliveryTipResult = PinDeliveryTipSuccess | PinDeliveryTipFailure;

export interface TokenProbePresent {
  readonly kind: "present";
  readonly generation: number;
  readonly raw: string;
}

export interface TokenProbeAbsent {
  readonly kind: "proven-absent-at-oid";
}

export interface TokenProbeUnreadable {
  readonly kind: "remote-configured-unreadable";
  readonly detail: string;
}

export type TokenProbe = TokenProbePresent | TokenProbeAbsent | TokenProbeUnreadable;

export interface EvaluateGenerationGateInput {
  readonly projectDir: string;
  readonly contentVersion: string;
  readonly increment: boolean;
  readonly execGit?: GitExecFn;
  readonly runId?: string;
  readonly nowIso?: string;
}

export type GenerationGateProceed =
  | {
      readonly action: "stamp";
      readonly generation: number;
      readonly tip: GenerationTipState;
      readonly local: LocalGenerationInspection;
      readonly fetchArgs?: readonly string[];
    }
  | {
      readonly action: "keep-prior";
      readonly tip: GenerationTipState;
      readonly local: LocalGenerationInspection;
      readonly fetchArgs?: readonly string[];
    };

export interface GenerationGateRefuse {
  readonly action: "refuse";
  readonly error_code: typeof GENERATION_REWIND_ERROR_CODE;
  readonly message: string;
  readonly recovery: string;
  readonly tip: GenerationTipState;
  readonly local: LocalGenerationInspection;
  readonly wroteDest: false;
}

export type GenerationGateResult = GenerationGateProceed | GenerationGateRefuse;

export interface DryRunGenerationGate {
  readonly fetches: false;
  readonly writes_refs: false;
  readonly wrote_dest: false;
  readonly live_apply: "invocation-owned-refresh";
  readonly remote_classification: "no-remotes" | "has-remotes";
  readonly local: LocalGenerationInspection["kind"];
  readonly proposed_generation: number | null;
  readonly verdict: "would-evaluate-at-live-apply" | "refuse";
  readonly error_code?: typeof GENERATION_REWIND_ERROR_CODE;
  readonly message?: string;
  readonly recovery?: string;
}

function gitCwd(projectDir: string): { cwd: string } {
  return { cwd: projectDir };
}

function deliveryTipRef(runId: string): string {
  return `refs/deft/update/${runId}/delivery-tip`;
}

export function generationFetchArgs(remote: string, branch: string, runId: string): string[] {
  return [
    "--no-optional-locks",
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    "--refmap=",
    remote,
    `+refs/heads/${branch}:${deliveryTipRef(runId)}`,
  ];
}

function deletePerRunRef(execGit: GitExecFn, projectDir: string, ref: string): void {
  execGit(["--no-optional-locks", "update-ref", "-d", ref], gitCwd(projectDir));
}

function refuse(
  message: string,
  recovery: string,
): Extract<GenerationDecision, { action: "refuse" }> {
  return {
    action: "refuse",
    error_code: GENERATION_REWIND_ERROR_CODE,
    message,
    recovery,
  };
}

function notAGitRepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

/**
 * True when `projectDir` is inside a git checkout: this directory or an
 * ancestor has `.git` (directory or gitfile). Empty-dir no-remote stamping is
 * only for dests that are not inside a checkout.
 */
function gitCheckoutAtOrAbove(projectDir: string): boolean {
  let current = resolve(projectDir);
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

export function listRemotes(
  execGit: GitExecFn,
  projectDir: string,
): {
  readonly kind: "no-remotes" | "has-remotes" | "unreadable";
  readonly remotes: readonly string[];
  readonly detail?: string;
} {
  const result = execGit(["--no-optional-locks", "remote"], gitCwd(projectDir));
  if (result.errorCode === "ENOENT") {
    // Empty dest / missing cwd / missing git binary: no checkout at or above
    // this directory is affirmative no-remote evidence (R3). A dest inside a
    // git checkout stays unreadable — remotes cannot be listed, and ancestor
    // `.git` must not be skipped.
    if (!gitCheckoutAtOrAbove(projectDir)) {
      return { kind: "no-remotes", remotes: [] };
    }
    return { kind: "unreadable", remotes: [], detail: "git binary not found" };
  }
  if (result.status) {
    if (notAGitRepository(result.stderr) && !gitCheckoutAtOrAbove(projectDir)) {
      return { kind: "no-remotes", remotes: [] };
    }
    return {
      kind: "unreadable",
      remotes: [],
      detail: result.stderr.length ? result.stderr : "git remote failed",
    };
  }
  const remotes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length);
  if (!remotes.length) {
    return { kind: "no-remotes", remotes: [] };
  }
  return { kind: "has-remotes", remotes };
}

export function pickFetchRemote(remotes: readonly string[]): string {
  if (remotes.includes("origin")) {
    return "origin";
  }
  for (const name of remotes) {
    return name;
  }
  return "origin";
}

export function pinDeliveryTipOid(input: PinDeliveryTipInput): PinDeliveryTipResult {
  const execGit = input.execGit ?? defaultGitExec;
  const runId = input.runId ?? randomUUID();
  const ref = deliveryTipRef(runId);
  const fetchArgs = generationFetchArgs(input.remote, input.branch, runId);
  const fetch = execGit(fetchArgs, gitCwd(input.projectDir));
  if (fetch.status) {
    deletePerRunRef(execGit, input.projectDir, ref);
    return {
      ok: false,
      runId,
      ref,
      fetchArgs,
      status: fetch.status,
      stderr: fetch.stderr,
    };
  }
  const parsed = execGit(["--no-optional-locks", "rev-parse", ref], gitCwd(input.projectDir));
  deletePerRunRef(execGit, input.projectDir, ref);
  if (parsed.status) {
    return {
      ok: false,
      runId,
      ref,
      fetchArgs,
      status: parsed.status,
      stderr: parsed.stderr.length ? parsed.stderr : "rev-parse of per-run delivery-tip failed",
    };
  }
  const oid = parsed.stdout.trim();
  if (!oid.length) {
    return {
      ok: false,
      runId,
      ref,
      fetchArgs,
      status: parsed.status,
      stderr: "empty OID from per-run delivery-tip",
    };
  }
  return { ok: true, oid, runId, ref, fetchArgs };
}

function lsTreeProbe(execGit: GitExecFn, projectDir: string, oid: string): GitExecResult {
  return execGit(
    ["--no-optional-locks", "--no-replace-objects", "ls-tree", oid, "--", GENERATION_GIT_PATH],
    gitCwd(projectDir),
  );
}

function showToken(execGit: GitExecFn, projectDir: string, oid: string): GitExecResult {
  return execGit(
    ["--no-optional-locks", "--no-replace-objects", "show", `${oid}:${GENERATION_GIT_PATH}`],
    gitCwd(projectDir),
  );
}

export function probeGenerationAtOid(
  execGit: GitExecFn,
  projectDir: string,
  oid: string,
): TokenProbe {
  const listed = lsTreeProbe(execGit, projectDir, oid);
  if (listed.status) {
    return {
      kind: "remote-configured-unreadable",
      detail: listed.stderr.length ? listed.stderr : "ls-tree of pinned OID failed",
    };
  }
  if (!listed.stdout.trim().length) {
    return { kind: "proven-absent-at-oid" };
  }
  const shown = showToken(execGit, projectDir, oid);
  if (shown.status) {
    return {
      kind: "remote-configured-unreadable",
      detail: shown.stderr.length ? shown.stderr : "show of pinned GENERATION.json failed",
    };
  }
  try {
    const parsed: unknown = JSON.parse(shown.stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        kind: "remote-configured-unreadable",
        detail: "pinned GENERATION.json is not an object",
      };
    }
    const token = parseLiveGeneration(parsed);
    if (token === null) {
      return {
        kind: "remote-configured-unreadable",
        detail: "pinned GENERATION.json generation is not a safe integer >= 1",
      };
    }
    return { kind: "present", generation: token.generation, raw: shown.stdout };
  } catch {
    return {
      kind: "remote-configured-unreadable",
      detail: "pinned GENERATION.json is not valid JSON",
    };
  }
}

function lsRemoteAssertsAbsence(
  execGit: GitExecFn,
  projectDir: string,
  remote: string,
  branch: string,
): boolean {
  const listed = execGit(
    ["--no-optional-locks", "ls-remote", remote, `refs/heads/${branch}`],
    gitCwd(projectDir),
  );
  return !listed.status && !listed.stdout.trim().length;
}

export function decideGenerationStamp(input: {
  readonly local: LocalGenerationInspection;
  readonly tip: GenerationTipState;
  readonly increment: boolean;
  readonly contentVersion: string;
}): GenerationDecision {
  if (input.local.kind === "unreadable") {
    return refuse(
      "directive update: local .deft/GENERATION.json is invalid; refuse before dest writes. Named recovery: replace or remove the unreadable token, then re-run update.",
      "replace or remove the unreadable local token, then re-run update",
    );
  }
  const prior: LiveGeneration | null = input.local.kind === "valid" ? input.local.token : null;
  let proposed = nextLiveGenerationNumber(prior, {
    increment: input.increment,
    contentVersion: input.contentVersion,
  });
  if (!Number.isSafeInteger(proposed)) {
    return refuse(
      "directive update: proposed generation successor is not a safe integer; refuse before dest writes.",
      GENERATION_REWIND_RECOVERY,
    );
  }

  if (input.tip.kind === "remote-configured-unreadable") {
    return refuse(
      `directive update: delivery-tip generation is unreadable (${input.tip.detail}). ${GENERATION_UNREADABLE_RECOVERY}.`,
      GENERATION_UNREADABLE_RECOVERY,
    );
  }

  const contentMatches =
    prior !== null && prior.contentVersion === input.contentVersion.trim().replace(/^v/, "");

  if (input.tip.kind === "no-remote" || input.tip.kind === "delivery-ref-absent-on-remote") {
    if (!input.increment && prior !== null && contentMatches) {
      return { action: "keep-prior" };
    }
    return { action: "stamp", generation: proposed };
  }

  if (input.tip.kind === "proven-absent-at-oid") {
    if (!input.increment && prior !== null && contentMatches) {
      return { action: "keep-prior" };
    }
    return { action: "stamp", generation: proposed };
  }

  const tipGeneration = input.tip.generation;
  const sufficient = prior !== null && prior.generation >= tipGeneration;
  const noWriteArm = !input.increment && prior !== null && contentMatches && sufficient;
  if (noWriteArm) {
    return { action: "keep-prior" };
  }
  // Bootstrap 1 is only for proven-absent / no-remote / delivery-ref-absent.
  // A missing local token against a known tip is an increment repair: stamp
  // tip+1. Do not propose 1 (init would fail closed with no useful recovery).
  if (input.local.kind === "absent") {
    proposed = tipGeneration + 1;
  }
  if (!Number.isSafeInteger(proposed) || proposed < 1) {
    return refuse(
      "directive update: proposed generation successor is not a safe integer; refuse before dest writes.",
      GENERATION_REWIND_RECOVERY,
    );
  }
  if (!(proposed > tipGeneration)) {
    return refuse(
      `directive update: generation rewind refused (proposed ${proposed} is not greater than delivery-tip ${tipGeneration}). ${GENERATION_REWIND_RECOVERY}.`,
      GENERATION_REWIND_RECOVERY,
    );
  }
  return { action: "stamp", generation: proposed };
}

function resolveTipState(input: {
  readonly projectDir: string;
  readonly execGit: GitExecFn;
  readonly runId?: string;
}): { tip: GenerationTipState; fetchArgs?: readonly string[] } {
  const remotes = listRemotes(input.execGit, input.projectDir);
  if (remotes.kind === "unreadable") {
    return {
      tip: {
        kind: "remote-configured-unreadable",
        detail: remotes.detail ?? "git remote unreadable",
      },
    };
  }
  if (remotes.kind === "no-remotes") {
    return { tip: { kind: "no-remote" } };
  }
  const delivery = resolveDeliveryBranch(input.projectDir);
  const remote = pickFetchRemote(remotes.remotes);
  const pin = pinDeliveryTipOid({
    projectDir: input.projectDir,
    remote,
    branch: delivery.branch,
    runId: input.runId,
    execGit: input.execGit,
  });
  if (!pin.ok) {
    const identityResolved = delivery.source === "typed" || delivery.source === "git-default";
    const emptyLsRemote = lsRemoteAssertsAbsence(
      input.execGit,
      input.projectDir,
      remote,
      delivery.branch,
    );
    // R3: default-fallback / default-on-error never authorize local arithmetic.
    // Empty ls-remote of the fallback name is not absence when another remote
    // may hold the real delivery branch (e.g. upstream/main).
    if (identityResolved && emptyLsRemote) {
      return { tip: { kind: "delivery-ref-absent-on-remote" }, fetchArgs: pin.fetchArgs };
    }
    const detail =
      !identityResolved && emptyLsRemote
        ? "delivery branch identity unresolved; empty ls-remote of the fallback name is not absence"
        : pin.stderr.length
          ? pin.stderr
          : "invocation-owned fetch failed";
    return {
      tip: { kind: "remote-configured-unreadable", detail },
      fetchArgs: pin.fetchArgs,
    };
  }
  const probe = probeGenerationAtOid(input.execGit, input.projectDir, pin.oid);
  if (probe.kind === "proven-absent-at-oid") {
    return { tip: { kind: "proven-absent-at-oid", oid: pin.oid }, fetchArgs: pin.fetchArgs };
  }
  if (probe.kind === "remote-configured-unreadable") {
    return {
      tip: { kind: "remote-configured-unreadable", detail: probe.detail },
      fetchArgs: pin.fetchArgs,
    };
  }
  return {
    tip: { kind: "known-at-oid", generation: probe.generation, oid: pin.oid },
    fetchArgs: pin.fetchArgs,
  };
}

export function evaluateGenerationGate(input: EvaluateGenerationGateInput): GenerationGateResult {
  const execGit = input.execGit ?? defaultGitExec;
  const local = inspectLocalGeneration(input.projectDir);
  const { tip, fetchArgs } = resolveTipState({
    projectDir: input.projectDir,
    execGit,
    runId: input.runId,
  });
  const decision = decideGenerationStamp({
    local,
    tip,
    increment: input.increment,
    contentVersion: input.contentVersion,
  });
  return resultFromDecision(decision, tip, local, fetchArgs);
}

function resultFromDecision(
  decision: GenerationDecision,
  tip: GenerationTipState,
  local: LocalGenerationInspection,
  fetchArgs?: readonly string[],
): GenerationGateResult {
  if (decision.action === "refuse") {
    return {
      action: "refuse",
      error_code: decision.error_code,
      message: decision.message,
      recovery: decision.recovery,
      tip,
      local,
      wroteDest: false,
    };
  }
  if (decision.action === "keep-prior") {
    return { action: "keep-prior", tip, local, fetchArgs };
  }
  return {
    action: "stamp",
    generation: decision.generation,
    tip,
    local,
    fetchArgs,
  };
}

function localInspectionsEquivalent(
  left: LocalGenerationInspection,
  right: LocalGenerationInspection,
): boolean {
  if (left.kind === "absent" && right.kind === "absent") {
    return true;
  }
  if (left.kind === "unreadable" && right.kind === "unreadable") {
    return left.reason === right.reason;
  }
  if (left.kind === "valid" && right.kind === "valid") {
    return (
      left.token.generation === right.token.generation &&
      left.token.contentVersion === right.token.contentVersion
    );
  }
  return false;
}

/**
 * Re-run {@link decideGenerationStamp} against the current local token, keeping
 * the cached tip. Callers that reuse a prior gate (CLI preflight → refresh
 * apply) MUST recheck `.deft/GENERATION.json` so a concurrent stamp cannot be
 * overwritten with an older generation (#4120).
 */
export function recheckGenerationGateLocal(
  cached: GenerationGateResult,
  projectDir: string,
  input: { readonly increment: boolean; readonly contentVersion: string },
): GenerationGateResult {
  if (cached.action === "refuse") {
    return cached;
  }
  const local = inspectLocalGeneration(projectDir);
  if (localInspectionsEquivalent(cached.local, local)) {
    return cached;
  }
  const decision = decideGenerationStamp({
    local,
    tip: cached.tip,
    increment: input.increment,
    contentVersion: input.contentVersion,
  });
  return resultFromDecision(decision, cached.tip, local, cached.fetchArgs);
}

export function describeDryRunGenerationGate(input: {
  readonly projectDir: string;
  readonly contentVersion: string;
  readonly increment: boolean;
  readonly execGit?: GitExecFn;
}): DryRunGenerationGate {
  const execGit = input.execGit ?? defaultGitExec;
  const local = inspectLocalGeneration(input.projectDir);
  const remotes = listRemotes(execGit, input.projectDir);
  const prior = local.kind === "valid" ? local.token : null;
  const proposed =
    local.kind === "unreadable"
      ? null
      : nextLiveGenerationNumber(prior, {
          increment: input.increment,
          contentVersion: input.contentVersion,
        });
  if (local.kind === "unreadable") {
    return {
      fetches: false,
      writes_refs: false,
      wrote_dest: false,
      live_apply: "invocation-owned-refresh",
      remote_classification: remotes.kind === "has-remotes" ? "has-remotes" : "no-remotes",
      local: local.kind,
      proposed_generation: null,
      verdict: "refuse",
      error_code: GENERATION_REWIND_ERROR_CODE,
      message:
        "directive update: local .deft/GENERATION.json is invalid; refuse before dest writes.",
      recovery: "replace or remove the unreadable local token, then re-run update",
    };
  }
  if (proposed !== null && !Number.isSafeInteger(proposed)) {
    return {
      fetches: false,
      writes_refs: false,
      wrote_dest: false,
      live_apply: "invocation-owned-refresh",
      remote_classification: remotes.kind === "has-remotes" ? "has-remotes" : "no-remotes",
      local: local.kind,
      proposed_generation: proposed,
      verdict: "refuse",
      error_code: GENERATION_REWIND_ERROR_CODE,
      message:
        "directive update: proposed generation successor is not a safe integer; refuse before dest writes.",
      recovery: GENERATION_REWIND_RECOVERY,
    };
  }
  return {
    fetches: false,
    writes_refs: false,
    wrote_dest: false,
    live_apply: "invocation-owned-refresh",
    remote_classification: remotes.kind === "has-remotes" ? "has-remotes" : "no-remotes",
    local: local.kind,
    proposed_generation: proposed,
    verdict: "would-evaluate-at-live-apply",
  };
}

export function generationRewindJsonFields(result: GenerationGateRefuse): Record<string, unknown> {
  return {
    success: false,
    error_code: result.error_code,
    message: result.message,
    recovery: result.recovery,
    wrote_dest: result.wroteDest,
  };
}

/** Test helper: never read the retired singleton ref. */
export function retiredSingletonTipRef(): string {
  return RETIRED_SINGLETON_TIP_REF;
}

export function evaluateGenerationMonotonicVsBase(input: {
  readonly changed: boolean;
  readonly baseBlob: string | null;
  readonly headBlob: string | null;
}): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (!input.changed) {
    return { ok: true };
  }
  if (input.headBlob === null) {
    return {
      ok: false,
      message: "deft-core-guard: .deft/GENERATION.json changed but the head blob is unreadable",
    };
  }
  let headToken: LiveGeneration | null;
  try {
    headToken = parseLiveGeneration(JSON.parse(input.headBlob) as unknown);
  } catch {
    headToken = null;
  }
  if (headToken === null) {
    return {
      ok: false,
      message: "deft-core-guard: head .deft/GENERATION.json is not a valid live token",
    };
  }
  if (input.baseBlob === null) {
    return { ok: true };
  }
  let baseToken: LiveGeneration | null;
  try {
    baseToken = parseLiveGeneration(JSON.parse(input.baseBlob) as unknown);
  } catch {
    return {
      ok: false,
      message: "deft-core-guard: origin base .deft/GENERATION.json is unreadable",
    };
  }
  if (baseToken === null) {
    return {
      ok: false,
      message: "deft-core-guard: origin base .deft/GENERATION.json is not a valid live token",
    };
  }
  if (!(headToken.generation > baseToken.generation)) {
    return {
      ok: false,
      message:
        "deft-core-guard: .deft/GENERATION.json must increase relative to origin/$BASE_REF " +
        `(head ${headToken.generation} is not greater than base ${baseToken.generation})`,
    };
  }
  return { ok: true };
}
