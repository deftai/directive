/**
 * Apply product-oracle integrity to verify:ac (#3322).
 *
 * Missing run-summary is a no-op (no evidence). A flagged
 * fail → method-change → pass fails closed. The run-summary
 * `independent_rederivation` boolean is not a security waiver (#3925).
 * Stdout dest (`DEFT_RUN_SUMMARY_PATH=-`) evaluates the same-process
 * attempts just emitted by this verify:ac — it does not treat non-file
 * dest as no evidence.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isSafetyRefusalRun } from "../literal-acceptance/run.js";
import type { LiteralAcceptanceRunResult } from "../literal-acceptance/types.js";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import {
  evaluatePathBActivationAdmit,
  isBriefLandShapedDiff,
  type PrDiffPath,
} from "../pr-closing-keywords/main.js";
import {
  parseRunSummaryJsonl,
  RunSummaryEmitter,
  resolveRunSummaryDestination,
} from "../run-summary/index.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { resolveRepo } from "../triage/queue/repo.js";
import {
  type FlaggedMethodChangePass,
  flagPassAfterFailWithMethodChange,
  readVerificationAttempts,
  unresolvedMethodChangePasses,
} from "./flag.js";

export interface EvaluateProductOracleIntegrityOptions {
  readonly projectRoot: string;
  /** Injected JSONL (tests). Undefined → read dest; null → empty. */
  readonly runSummaryText?: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProductOracleIntegrityVerdict {
  readonly ok: boolean;
  readonly code: 0 | 1;
  readonly flagged: readonly FlaggedMethodChangePass[];
  readonly unresolved: readonly FlaggedMethodChangePass[];
  readonly message: string;
}

export interface OracleIntegrityResultFields {
  readonly ok: boolean;
  readonly code: number;
  readonly message: string;
}

function formatUnresolved(flag: FlaggedMethodChangePass): string {
  const delta =
    typeof flag.resolved_command_count_delta === "number"
      ? ` command_count_delta=${flag.resolved_command_count_delta}`
      : "";
  return (
    `check_id=${flag.check_id} fail method=${flag.failed_method} ` +
    `then pass method=${flag.passed_method}${delta}`
  );
}

/**
 * Walk-level method fingerprint: command list + cwd hash (#3397 / #3322).
 * Same shape for fail and pass so an honest product fix does not flag.
 */
export function methodFingerprintForWalk(commands: readonly string[], cwd: string): string {
  const cwdHash = createHash("sha256").update(cwd, "utf8").digest("hex");
  return `${commands.join("\0")}\0${cwdHash}`;
}

/** Stable prefix for product-oracle check ids emitted by verify:ac (#3322 / #3337). */
export const VERIFY_AC_CHECK_ID_PREFIX = "verify:ac";

/**
 * Namespace product-oracle check_id per active scope (#3337).
 *
 * Same-session multi-active verify:ac must not pair fail/pass across briefs.
 * Prefer plan.id or xBRIEF path as scopeKey; empty → global fallback `verify:ac`
 * (unknown-scope single-brief / tests without a plan).
 */
export function verifyAcCheckId(scopeKey?: string | null): string {
  const key = typeof scopeKey === "string" ? scopeKey.trim() : "";
  if (key.length === 0) {
    return VERIFY_AC_CHECK_ID_PREFIX;
  }
  // Keep pairing keys readable; strip control chars that would corrupt JSONL.
  const safe = key.replace(/[\0\n\r]/g, "_");
  return `${VERIFY_AC_CHECK_ID_PREFIX}/${safe}`;
}

/** Same-process verification JSONL when dest is stdout (`-`). */
const inProcessVerificationLines: string[] = [];

/** Test seam: isolate stdout-dest buffer across cases. */
export function resetInProcessVerificationBuffer(): void {
  inProcessVerificationLines.length = 0;
}

function inProcessVerificationText(): string | null {
  if (inProcessVerificationLines.length === 0) {
    return null;
  }
  return inProcessVerificationLines.join("\n");
}

/**
 * Product-oracle outcome for one acceptance walk (#3615).
 *
 * A safety refusal is not a measurement. All-refused walks emit nothing.
 * Mixed refused + executed-pass walks emit nothing (filtering refusals then
 * classifying the remainder would be a false green). Any executed fail still
 * emits fail. flag.ts is unchanged.
 */
export function productOracleOutcomeForWalk(
  runs: readonly LiteralAcceptanceRunResult[],
): "pass" | "fail" | null {
  const refused = runs.filter(isSafetyRefusalRun);
  const executed = runs.filter((run) => !isSafetyRefusalRun(run));
  if (executed.length === 0) {
    return null;
  }
  if (refused.length > 0 && executed.every((run) => run.ok)) {
    return null;
  }
  return executed.every((run) => run.ok) ? "pass" : "fail";
}

/**
 * Record one walk-level verification event for the executed command set (#3322 / #3397).
 * Fail and pass use the same method_fingerprint shape (command list + cwd hash).
 * Fail-open: missing dest / write errors never change the AC result.
 * Stdout dest also appends to the same-process buffer so evaluate can
 * inspect this invocation without re-reading a file.
 * check_id is namespaced per active scope when scopeKey is provided (#3337).
 */
export function emitVerifyAcAttempts(options: {
  readonly projectRoot: string;
  readonly runs: readonly LiteralAcceptanceRunResult[];
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId?: string;
  /**
   * Active scope identity (plan.id or xBRIEF path stem). When set, check_id
   * becomes `verify:ac/<scopeKey>` so multi-active sessions do not false-deny (#3337).
   */
  readonly scopeKey?: string | null;
  /** Full check_id override (tests). Wins over scopeKey when non-empty. */
  readonly checkId?: string | null;
  /** stdout seam (tests). */
  readonly writeStdout?: (line: string) => void;
}): void {
  if (options.runs.length === 0) {
    return;
  }
  const outcome = productOracleOutcomeForWalk(options.runs);
  if (outcome === null) {
    return;
  }
  try {
    const env = options.env ?? process.env;
    const projectRoot = resolve(options.projectRoot);
    const dest = resolveRunSummaryDestination(projectRoot, { env });
    const sessionId = options.sessionId;
    const explicitCheck =
      typeof options.checkId === "string" && options.checkId.trim().length > 0
        ? options.checkId.trim()
        : null;
    const checkId = explicitCheck ?? verifyAcCheckId(options.scopeKey);
    const emitter = new RunSummaryEmitter({
      projectRoot,
      sessionId,
      env,
      component: "verify-ac",
      writeStdout: options.writeStdout,
    });
    // Method identity is the executed command set. Refused rows are not
    // measurements; including them would make a later same-command product
    // fix look like a method change (#3615 Greptile P1).
    const executed = options.runs.filter((run) => !isSafetyRefusalRun(run));
    const commands = executed.map((run) => run.command);
    const firstCwd = executed[0]?.cwd ?? "";
    const cwdKey = executed.every((run) => run.cwd === firstCwd)
      ? firstCwd
      : executed.map((run) => run.cwd).join("\0");
    const emitted = emitter.emitVerification({
      check_id: checkId,
      method_fingerprint: methodFingerprintForWalk(commands, cwdKey),
      outcome,
    });
    if (dest.kind === "stdout" && emitted.line !== null) {
      inProcessVerificationLines.push(JSON.stringify(emitted.line));
    }
  } catch {
    // fail-open
  }
}

function loadRunSummaryText(projectRoot: string, env: NodeJS.ProcessEnv): string | null {
  const dest = resolveRunSummaryDestination(resolve(projectRoot), { env });
  if (dest.kind === "stdout") {
    return inProcessVerificationText();
  }
  if (dest.kind !== "file") {
    return null;
  }
  if (!existsSync(dest.path)) {
    return null;
  }
  try {
    return readFileSync(dest.path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Evaluate run-summary verification events for pass-after-fail-with-method-change.
 */
export function evaluateProductOracleIntegrity(
  options: EvaluateProductOracleIntegrityOptions,
): ProductOracleIntegrityVerdict {
  const env = options.env;
  const text =
    options.runSummaryText === undefined
      ? env !== undefined
        ? loadRunSummaryText(options.projectRoot, env)
        : null
      : options.runSummaryText;
  if (text === null || text.trim().length === 0) {
    return { ok: true, code: 0, flagged: [], unresolved: [], message: "" };
  }
  const flagged = flagPassAfterFailWithMethodChange(
    readVerificationAttempts(parseRunSummaryJsonl(text)),
  );
  const unresolved = unresolvedMethodChangePasses(flagged);
  if (unresolved.length === 0) {
    return { ok: true, code: 0, flagged, unresolved, message: "" };
  }
  const lead =
    `UNRESOLVED product-oracle discrepancy (#3322): ${unresolved.map(formatUnresolved).join("; ")}. ` +
    "Resolve by a product change (same method). " +
    "independent_rederivation on the run-summary is not a security waiver (#3925). " +
    "Poisoned-history recovery: new session or truncate-delete (gate-integrity.md).";
  return {
    ok: false,
    code: 1,
    flagged,
    unresolved,
    message: lead,
  };
}

/**
 * Lead the verify:ac message with any unresolved discrepancy.
 * Config errors (code 2) stay 2; unresolved oracle is exit 1.
 */
export function mergeOracleVerdict<T extends OracleIntegrityResultFields>(
  result: T,
  verdict: ProductOracleIntegrityVerdict,
): T {
  if (verdict.ok || verdict.message.length === 0) {
    return result;
  }
  const message = result.message ? `${verdict.message}\n${result.message}` : verdict.message;
  const code = result.code === 2 ? 2 : 1;
  return {
    ...result,
    ok: false,
    code,
    message,
  };
}

/** Named non-product disposition token for Path B brief-land activation (#5792). */
export const PATH_B_ACTIVATION_AC_DISPOSITION = "path_b_activation_deferred" as const;

export const PATH_B_ACTIVATION_AC_MESSAGE =
  `verify:ac ${PATH_B_ACTIVATION_AC_DISPOSITION} (#5792): ` +
  "brief-land Path B activation admitted; product commands and artifact clauses deferred " +
  "until merge-base write authority exists. Not a product verified-pass.";

export type PathBActivationAcDisposition =
  | {
      readonly apply: true;
      readonly message: string;
      readonly witnessDetail: string;
      readonly files: readonly PrDiffPath[];
    }
  | {
      readonly apply: false;
      readonly reason: string;
    };

type GitRunnerResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

function defaultInventoryGitRunner(projectRoot: string, args: readonly string[]): GitRunnerResult {
  const ran = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    windowsHide: true,
  });
  return {
    code: typeof ran.status === "number" ? ran.status : 1,
    stdout: typeof ran.stdout === "string" ? ran.stdout : "",
    stderr: typeof ran.stderr === "string" ? ran.stderr : "",
  };
}

function mapGitNameStatusLetter(status: string): string {
  const letter = status.trim().charAt(0).toUpperCase();
  if (letter === "A") return "added";
  if (letter === "M") return "modified";
  if (letter === "D") return "removed";
  if (letter === "R") return "renamed";
  if (letter === "C") return "copied";
  return letter.toLowerCase();
}

function splitNulInventory(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/** Brief-land allowlist mirror for inventory origin rows (pending|proposed|active|CHANGELOG). */
function isBriefLandAllowlistedInventoryPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (p === "CHANGELOG.md") return true;
  return /^(xbrief|vbrief)\/(proposed|pending|active)\//.test(p);
}

/**
 * Merge inventory rows without dropping rename origins (#5792 Greptile P1).
 * Later dirty/cached edits may replace status but must keep previousFilename.
 * Product-path origins get a synthetic removal so brief-land shape still sees
 * them; brief→brief moves keep previousFilename only (no deleted-nonterminal refuse).
 */
function mergeInventoryPrDiffPath(byPath: Map<string, PrDiffPath>, next: PrDiffPath): void {
  const prev = byPath.get(next.path);
  const previousFilename =
    typeof next.previousFilename === "string" && next.previousFilename.length > 0
      ? next.previousFilename
      : typeof prev?.previousFilename === "string" && prev.previousFilename.length > 0
        ? prev.previousFilename
        : undefined;
  byPath.set(next.path, {
    status: next.status,
    path: next.path,
    ...(previousFilename !== undefined ? { previousFilename } : {}),
  });
  if (
    previousFilename !== undefined &&
    previousFilename !== next.path &&
    !byPath.has(previousFilename) &&
    !isBriefLandAllowlistedInventoryPath(previousFilename)
  ) {
    byPath.set(previousFilename, { status: "removed", path: previousFilename });
  }
}

function ingestNameStatusIntoPrDiff(stdout: string, byPath: Map<string, PrDiffPath>): void {
  const tokens = splitNulInventory(stdout);
  let i = 0;
  while (i < tokens.length) {
    const status = (tokens[i] ?? "").trim();
    if (status.length === 0) {
      i += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousFilename = tokens[i + 1] ?? "";
      const path = tokens[i + 2] ?? "";
      if (path.length > 0) {
        const norm = path.replace(/\\/g, "/");
        mergeInventoryPrDiffPath(byPath, {
          status: mapGitNameStatusLetter(status),
          path: norm,
          ...(previousFilename.length > 0
            ? { previousFilename: previousFilename.replace(/\\/g, "/") }
            : {}),
        });
      }
      i += 3;
      continue;
    }
    const path = tokens[i + 1] ?? "";
    if (path.length > 0) {
      const norm = path.replace(/\\/g, "/");
      mergeInventoryPrDiffPath(byPath, { status: mapGitNameStatusLetter(status), path: norm });
    }
    i += 2;
  }
}

function resolveInventoryBaseRef(
  projectRoot: string,
  runGit: (cwd: string, args: readonly string[]) => GitRunnerResult,
  override?: string | null,
): string | null {
  const candidates: string[] = [];
  if (typeof override === "string" && override.trim().length > 0) {
    candidates.push(override.trim());
  }
  for (const envKey of ["DEFT_BASE_REF", "GITHUB_BASE_REF"] as const) {
    const raw = process.env[envKey]?.trim();
    if (raw !== undefined && raw.length > 0) {
      candidates.push(
        raw.startsWith("origin/") || envKey === "DEFT_BASE_REF" ? raw : `origin/${raw}`,
      );
      candidates.push(raw);
    }
  }
  // Prefer typed deliveryBranch / git remote default before master|main (#5792 Greptile P1).
  const delivery = resolveDeliveryBranch(projectRoot, (root, args) => runGit(root, args));
  if (delivery.error === null && delivery.branch.trim().length > 0) {
    candidates.push(`origin/${delivery.branch}`, delivery.branch);
  }
  const abbrev = runGit(projectRoot, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (abbrev.code === 0) {
    const name = abbrev.stdout.trim();
    if (name.length > 0 && name !== "origin/HEAD") {
      candidates.push(name);
    }
  }
  candidates.push("origin/master", "origin/main", "master", "main");
  for (const cand of candidates) {
    const ran = runGit(projectRoot, ["rev-parse", "--verify", "-q", `${cand}^{commit}`]);
    if (ran.code === 0) return cand;
  }
  return null;
}

/** Map a git-toplevel-relative path onto projectRoot (nested consumers / subdir cwd). */
function inventoryPathRelativeToProject(
  gitToplevel: string,
  projectRoot: string,
  gitRelPath: string,
): string {
  return relative(projectRoot, resolve(gitToplevel, gitRelPath)).replace(/\\/g, "/");
}

function pathEscapesProjectRoot(projectRel: string): boolean {
  const p = projectRel.replace(/\\/g, "/");
  return p === ".." || p.startsWith("../") || /^[A-Za-z]:/.test(p) || p.startsWith("/");
}

/**
 * Remap inventory for nested projectRoot vs git toplevel (#5792 Greptile P1).
 * Nested consumer: strip the project prefix (project-relative paths + read at projectRoot).
 * Subdir cwd with repo-root briefs: keep git-relative allowlisted paths + read at git toplevel.
 * Sibling / product paths outside projectRoot stay visible so brief-land shape fails closed.
 */
function remapInventoryToProjectRoot(
  byPath: Map<string, PrDiffPath>,
  gitToplevel: string,
  projectRoot: string,
): { files: Map<string, PrDiffPath>; briefReadRoot: string } {
  const top = resolve(gitToplevel);
  const root = resolve(projectRoot);
  if (top === root) {
    return { files: byPath, briefReadRoot: root };
  }
  const underProject: PrDiffPath[] = [];
  const gitRootBrief: PrDiffPath[] = [];
  const outside: PrDiffPath[] = [];
  for (const entry of byPath.values()) {
    const path = inventoryPathRelativeToProject(top, root, entry.path);
    const previousFilename =
      typeof entry.previousFilename === "string" && entry.previousFilename.length > 0
        ? inventoryPathRelativeToProject(top, root, entry.previousFilename)
        : undefined;
    const destEscapes = pathEscapesProjectRoot(path);
    const originEscapes =
      previousFilename !== undefined ? pathEscapesProjectRoot(previousFilename) : false;
    if (!destEscapes && !originEscapes) {
      underProject.push({
        status: entry.status,
        path,
        ...(previousFilename !== undefined ? { previousFilename } : {}),
      });
      continue;
    }
    const gitDest = entry.path.replace(/\\/g, "/");
    const gitOrigin =
      typeof entry.previousFilename === "string" && entry.previousFilename.length > 0
        ? entry.previousFilename.replace(/\\/g, "/")
        : undefined;
    if (
      isBriefLandAllowlistedInventoryPath(gitDest) &&
      (gitOrigin === undefined || isBriefLandAllowlistedInventoryPath(gitOrigin))
    ) {
      gitRootBrief.push({
        status: entry.status,
        path: gitDest,
        ...(gitOrigin !== undefined ? { previousFilename: gitOrigin } : {}),
      });
      continue;
    }
    outside.push({
      status: entry.status,
      path,
      ...(previousFilename !== undefined ? { previousFilename } : {}),
    });
  }
  const remapped = new Map<string, PrDiffPath>();
  if (gitRootBrief.length > 0 && underProject.length === 0) {
    for (const row of [...gitRootBrief, ...outside]) {
      mergeInventoryPrDiffPath(remapped, row);
    }
    return { files: remapped, briefReadRoot: top };
  }
  for (const row of [
    ...underProject,
    ...gitRootBrief.map((row) => {
      // Mixed nested + repo-root: project-relative view so shape stays honest.
      const path = inventoryPathRelativeToProject(top, root, row.path);
      const previousFilename =
        typeof row.previousFilename === "string" && row.previousFilename.length > 0
          ? inventoryPathRelativeToProject(top, root, row.previousFilename)
          : undefined;
      return {
        status: row.status,
        path,
        ...(previousFilename !== undefined ? { previousFilename } : {}),
      };
    }),
    ...outside,
  ]) {
    mergeInventoryPrDiffPath(remapped, row);
  }
  return { files: remapped, briefReadRoot: root };
}

/**
 * Complete local change set for Path B activation inventory (#5792):
 * merge-base..HEAD ∪ dirty ∪ cached ∪ untracked, with rename origins as PrDiffPath.
 * Failed inventory yields no activation AC disposition.
 */
export function collectBriefLandInventoryAsPrDiffPaths(input: {
  readonly projectRoot: string;
  readonly baseRef?: string | null;
  readonly runGit?: (cwd: string, args: readonly string[]) => GitRunnerResult;
}): { ok: true; files: PrDiffPath[]; briefReadRoot: string } | { ok: false; reason: string } {
  const projectRoot = resolve(input.projectRoot);
  const runGit = input.runGit ?? defaultInventoryGitRunner;
  const inside = runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { ok: false, reason: "not a git working tree" };
  }
  const top = runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || top.stdout.trim().length === 0) {
    return { ok: false, reason: "git toplevel unresolved" };
  }
  const gitToplevel = top.stdout.trim();
  const baseRef = resolveInventoryBaseRef(projectRoot, runGit, input.baseRef);
  if (baseRef === null) {
    return { ok: false, reason: "no merge-base ref" };
  }
  const byPath = new Map<string, PrDiffPath>();
  const committed = runGit(gitToplevel, [
    "-c",
    "diff.relative=false",
    "diff",
    "-z",
    "--name-status",
    "--find-renames",
    `${baseRef}...HEAD`,
  ]);
  if (committed.code !== 0) {
    return { ok: false, reason: `git diff name-status ${baseRef}...HEAD failed` };
  }
  ingestNameStatusIntoPrDiff(committed.stdout, byPath);

  const vsHead = runGit(gitToplevel, [
    "-c",
    "diff.relative=false",
    "diff",
    "-z",
    "--name-status",
    "--find-renames",
    "HEAD",
  ]);
  if (vsHead.code !== 0) {
    return { ok: false, reason: "git diff name-status HEAD failed" };
  }
  ingestNameStatusIntoPrDiff(vsHead.stdout, byPath);

  const cached = runGit(gitToplevel, [
    "-c",
    "diff.relative=false",
    "diff",
    "-z",
    "--cached",
    "--name-status",
    "--find-renames",
  ]);
  if (cached.code !== 0) {
    return { ok: false, reason: "git diff --cached name-status failed" };
  }
  ingestNameStatusIntoPrDiff(cached.stdout, byPath);

  const untracked = runGit(gitToplevel, [
    "ls-files",
    "-z",
    "--full-name",
    "--others",
    "--exclude-standard",
  ]);
  if (untracked.code !== 0) {
    return { ok: false, reason: "git ls-files --others failed" };
  }
  for (const raw of splitNulInventory(untracked.stdout)) {
    const path = raw.replace(/\\/g, "/");
    if (path.length === 0) continue;
    mergeInventoryPrDiffPath(byPath, { status: "added", path });
  }
  const remapped = remapInventoryToProjectRoot(byPath, gitToplevel, projectRoot);
  return {
    ok: true,
    files: [...remapped.files.values()],
    briefReadRoot: remapped.briefReadRoot,
  };
}

/**
 * One named Path B activation AC disposition (#5792): after complete inventory +
 * Path B witness, defer product command/clause execution. Product paths or a
 * stamped productPullRequest restore full verify:ac. Never banks as product pass.
 */
export function evaluatePathBActivationAcDisposition(input: {
  readonly projectRoot: string;
  readonly bodyText?: string | null;
  readonly prNumber?: number | null;
  readonly repo?: string | null;
  readonly baseRef?: string | null;
  readonly files?: readonly PrDiffPath[];
  readonly runGit?: (cwd: string, args: readonly string[]) => GitRunnerResult;
}): PathBActivationAcDisposition {
  const projectRoot = resolve(input.projectRoot);
  let files: readonly PrDiffPath[];
  let briefReadRoot = projectRoot;
  if (input.files !== undefined) {
    files = input.files;
  } else {
    const inventory = collectBriefLandInventoryAsPrDiffPaths({
      projectRoot,
      baseRef: input.baseRef,
      runGit: input.runGit,
    });
    if (!inventory.ok) {
      return { apply: false, reason: `inventory failed: ${inventory.reason}` };
    }
    files = inventory.files;
    briefReadRoot = inventory.briefReadRoot;
  }
  if (files.length === 0) {
    return { apply: false, reason: "empty inventory" };
  }
  if (!isBriefLandShapedDiff(files)) {
    return { apply: false, reason: "not brief-land shaped (product path restores full verify:ac)" };
  }
  const repo = resolveRepo(input.repo ?? null, projectRoot);
  if (repo === null || repo.length === 0) {
    return { apply: false, reason: "repo slug unresolved" };
  }
  const witness = evaluatePathBActivationAdmit({
    bodyText: input.bodyText ?? null,
    prNumber: input.prNumber ?? null,
    projectRoot: briefReadRoot,
    repo,
    files,
  });
  if (!witness.ok) {
    return { apply: false, reason: witness.detail };
  }
  return {
    apply: true,
    message: PATH_B_ACTIVATION_AC_MESSAGE,
    witnessDetail: witness.detail,
    files,
  };
}

/** True when text is the #5792 activation deferral (not soft_empty / product pass). */
export function isPathBActivationAcDispositionText(text: string): boolean {
  return new RegExp(`${PATH_B_ACTIVATION_AC_DISPOSITION}\\s*\\(#5792\\)`, "i").test(text);
}
