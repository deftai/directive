/**
 * Refuse newly added completed/ blobs that bypass runTransition (#3679),
 * and refuse a source D or rename-from of active/ with no paired stamped
 * destination (#3766).
 *
 * Historical corpus is advisory (doctor). New work in the change set is hard
 * (verify:completed-write-guard). Does not read completionProvenance and does
 * not change verify:completed-tracked.
 *
 * Disk reads are capped at COMPLETED_WRITE_GUARD_MAX_BYTES so a huge
 * contributor-controlled completed/ add fails through the guard instead of
 * exhausting memory on the required gate path.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GitCommandError, GitNotFoundError } from "../encoding/git.js";
import {
  hasArtifactSuffix,
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
} from "../layout/resolve.js";
import {
  hasTransitionWrite,
  LEFTOVER_LAND_PR_REMEDIATION,
  transitionWriteFitsFolder,
} from "../scope/lifecycle-write.js";
import { resolveDefaultBaseRef, unquoteGitPath } from "../scope-provenance/evaluate.js";

export type CompletedWriteGuardCode = 0 | 1 | 2;

export interface CompletedWriteGuardFinding {
  readonly relPath: string;
  readonly detail: string;
}

export interface CompletedWriteGuardResult {
  readonly code: CompletedWriteGuardCode;
  readonly message: string;
  readonly findings: readonly CompletedWriteGuardFinding[];
}

export interface CompletedWriteGuardOptions {
  readonly baseRef?: string;
  /** Inject added repo-relative POSIX paths (skips git). Synthesized as A records. */
  readonly addedFiles?: readonly string[];
  /**
   * Inject git `--name-status` stdout (skips git). Same parser as discovery.
   * Takes precedence over `addedFiles` when both are set.
   */
  readonly nameStatus?: string;
  /** Inject payloads: relPath -> raw JSON. */
  readonly payloads?: ReadonlyMap<string, string>;
}

/**
 * In-repo completed xBRIEFs average ~5.5 KiB and peak near 44 KiB.
 * 1 MiB is ~23× that peak and still refuses a multi-hundred-MB add
 * before the bytes are loaded.
 */
export const COMPLETED_WRITE_GUARD_MAX_BYTES = 1_048_576;

const COMPLETED_REL_RE = /^(?:xbrief|vbrief)\/completed\/[^/]+$/;
const ACTIVE_REL_RE = /^(?:xbrief|vbrief)\/active\/[^/]+$/;
const CANCELLED_REL_RE = /^(?:xbrief|vbrief)\/cancelled\/[^/]+$/;

/** Halt copy for unpaired active/ D or rename-from (#3766). */
export const UNPAIRED_ACTIVE_DELETE_REMEDIATION =
  "Halt: run `task scope:complete` or `task scope:cancel` so the destination is stamped, or leave the brief untracked. " +
  "Lone-D untracking cleanup is not an authorization token (#3766).";

interface NameStatusRecord {
  readonly status: "A" | "D" | "R";
  readonly src: string;
  readonly dest: string;
}

function normalizeRepoRelPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

function lastPathSegment(relPath: string): string {
  const n = normalizeRepoRelPath(relPath);
  const i = n.lastIndexOf("/");
  return i === -1 ? n : n.slice(i + 1);
}

function sanitizeDetail(text: string): string {
  return text.replace(/\r?\n/g, " ");
}

function isCompletedArtifactRel(relPath: string): boolean {
  const n = normalizeRepoRelPath(relPath);
  if (!COMPLETED_REL_RE.test(n)) {
    return false;
  }
  return hasArtifactSuffix(lastPathSegment(n));
}

function isActiveArtifactRel(relPath: string): boolean {
  const n = normalizeRepoRelPath(relPath);
  if (!ACTIVE_REL_RE.test(n)) {
    return false;
  }
  return hasArtifactSuffix(lastPathSegment(n));
}

function isCancelledArtifactRel(relPath: string): boolean {
  const n = normalizeRepoRelPath(relPath);
  if (!CANCELLED_REL_RE.test(n)) {
    return false;
  }
  return hasArtifactSuffix(lastPathSegment(n));
}

function originIssueKey(plan: Record<string, unknown>): string {
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return "";
  }
  const issues: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const rec = ref as Record<string, unknown>;
    const type = String(rec.type ?? "");
    const uri = String(rec.uri ?? "")
      .trim()
      .toLowerCase();
    if (type.includes("github-issue") && uri.length > 0) {
      issues.push(uri);
    }
  }
  return issues.sort().join("|");
}

function itemTitles(items: unknown): string {
  if (!Array.isArray(items)) {
    return "";
  }
  const titles: string[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const title = String((item as Record<string, unknown>).title ?? "").trim();
    if (title.length > 0) {
      titles.push(title);
    }
  }
  return titles.join("\0");
}

function planIdentity(plan: Record<string, unknown>): string {
  const title = String(plan.title ?? "").trim();
  const origin = originIssueKey(plan);
  const items = itemTitles(plan.items);
  return [title, origin, items].filter((part) => part.length > 0).join("\n");
}

function pairingKey(relPath: string): string | null {
  const n = normalizeRepoRelPath(relPath);
  const family = n.startsWith("xbrief/") ? "xbrief" : n.startsWith("vbrief/") ? "vbrief" : null;
  const base = lastPathSegment(n);
  if (family === null || base.length === 0) {
    return null;
  }
  return `${family}/${base}`;
}

function parsePlan(raw: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }
    const plan = (data as Record<string, unknown>).plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return null;
    }
    return plan as Record<string, unknown>;
  } catch {
    return null;
  }
}

function gitEnv(projectRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(projectRoot));
  return env;
}

function git(args: string[], projectRoot: string): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(projectRoot),
  });
  if (result.error !== undefined) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new GitNotFoundError("'git' executable not found on PATH");
    }
    throw new GitCommandError(`git ${args.join(" ")} failed: ${String(e.message)}`);
  }
  if (result.signal !== null && result.signal !== undefined) {
    throw new GitCommandError(`git ${args.join(" ")} killed by signal ${String(result.signal)}`);
  }
  const status = result.status ?? 1;
  const stderr = String(result.stderr ?? "").trim();
  if (status !== 0 && stderr.length > 0) {
    return { status, stdout: `${result.stdout ?? ""}\n${stderr}` };
  }
  return { status, stdout: result.stdout ?? "" };
}

function parseNameStatusRecords(stdout: string): NameStatusRecord[] {
  const out: NameStatusRecord[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (t.length === 0) {
      continue;
    }
    const parts = t.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("A")) {
      const path = parts[1];
      if (path !== undefined) {
        const n = normalizeRepoRelPath(unquoteGitPath(path));
        out.push({ status: "A", src: n, dest: n });
      }
    } else if (status.startsWith("D")) {
      const path = parts[1];
      if (path !== undefined) {
        const n = normalizeRepoRelPath(unquoteGitPath(path));
        out.push({ status: "D", src: n, dest: n });
      }
    } else if (status.startsWith("R")) {
      const srcRaw = parts[1];
      const destRaw = parts[2] ?? parts[1];
      if (srcRaw !== undefined && destRaw !== undefined) {
        out.push({
          status: "R",
          src: normalizeRepoRelPath(unquoteGitPath(srcRaw)),
          dest: normalizeRepoRelPath(unquoteGitPath(destRaw)),
        });
      }
    }
  }
  return out;
}

function discoverNameStatusRecords(projectRoot: string, baseRef: string): NameStatusRecord[] {
  const inside = git(["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (inside.status !== 0) {
    throw new GitCommandError("not a git working tree");
  }
  let resolved = baseRef;
  if (baseRef === "HEAD" || baseRef === "") {
    const upgraded = resolveDefaultBaseRef(projectRoot);
    if (upgraded === null) {
      throw new GitCommandError(
        "no merge-base ref (origin/master|main or DEFT_BASE_REF/GITHUB_BASE_REF)",
      );
    }
    resolved = upgraded;
  }
  const hasBase = git(["rev-parse", "--verify", "-q", resolved], projectRoot).status === 0;
  if (!hasBase) {
    throw new GitCommandError(`base ref '${resolved}' not found; pass --base-ref`);
  }
  const records: NameStatusRecord[] = [];
  const range = resolved.includes("...") ? resolved : `${resolved}...HEAD`;
  const committed = git(["diff", "-M", "--name-status", "--diff-filter=ARD", range], projectRoot);
  if (committed.status !== 0) {
    const detail =
      committed.stdout.trim() || `git diff ${range} exited ${String(committed.status)}`;
    throw new GitCommandError(
      `committed change-set unavailable for '${range}': ${detail}. ` +
        "Pass --base-ref to a merge-base ancestor of HEAD.",
    );
  }
  records.push(...parseNameStatusRecords(committed.stdout));
  const vsHead = git(["diff", "-M", "--name-status", "--diff-filter=ARD", "HEAD"], projectRoot);
  if (vsHead.status !== 0) {
    const detail = vsHead.stdout.trim() || `git diff HEAD exited ${String(vsHead.status)}`;
    throw new GitCommandError(`working-tree change-set unavailable: ${detail}`);
  }
  records.push(...parseNameStatusRecords(vsHead.stdout));
  const untracked = git(["ls-files", "--others", "--exclude-standard"], projectRoot);
  if (untracked.status !== 0) {
    const detail = untracked.stdout.trim() || `git ls-files exited ${String(untracked.status)}`;
    throw new GitCommandError(`untracked change-set unavailable: ${detail}`);
  }
  const untrackedAsAdds: string[] = [];
  for (const line of untracked.stdout.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (t.length > 0) {
      untrackedAsAdds.push(`A\t${t}`);
    }
  }
  records.push(...parseNameStatusRecords(untrackedAsAdds.join("\n")));
  return records;
}

type PayloadRead =
  | { readonly kind: "ok"; readonly raw: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe"; readonly detail: string };

function readPayload(
  projectRoot: string,
  relPath: string,
  payloads: ReadonlyMap<string, string> | undefined,
): PayloadRead {
  const n = normalizeRepoRelPath(relPath);
  const injected = payloads?.get(n);
  if (injected !== undefined) {
    if (injected.length > COMPLETED_WRITE_GUARD_MAX_BYTES) {
      return {
        kind: "unsafe",
        detail:
          `${n}: completed/ artifact is ${String(injected.length)} bytes; ` +
          `exceeds the ${String(COMPLETED_WRITE_GUARD_MAX_BYTES)}-byte read limit`,
      };
    }
    return { kind: "ok", raw: injected };
  }
  const parts = n.split("/").filter((part) => part.length > 0 && part !== ".");
  let abs = resolve(projectRoot);
  let st: Stats | undefined;
  for (const part of parts) {
    if (part === "..") {
      return {
        kind: "unsafe",
        detail: `${n}: completed/ path escapes project root; refuse without following`,
      };
    }
    abs = join(abs, part);
    try {
      st = lstatSync(abs);
    } catch {
      return { kind: "missing" };
    }
    if (st.isSymbolicLink()) {
      return {
        kind: "unsafe",
        detail: `${n}: completed/ path contains a symlink; refuse without following`,
      };
    }
  }
  if (st === undefined || !st.isFile()) {
    return {
      kind: "unsafe",
      detail: `${n}: completed/ add is not a regular file; refuse without reading`,
    };
  }
  if (st.size > COMPLETED_WRITE_GUARD_MAX_BYTES) {
    return {
      kind: "unsafe",
      detail:
        `${n}: completed/ artifact is ${String(st.size)} bytes; ` +
        `exceeds the ${String(COMPLETED_WRITE_GUARD_MAX_BYTES)}-byte read limit`,
    };
  }
  try {
    return { kind: "ok", raw: readFileSync(abs, "utf8") };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Hard check: newly added completed/ artifacts must show runTransition evidence,
 * and active/ D or rename-from must pair with a stamped terminal destination.
 */
export function evaluateCompletedWriteGuard(
  projectRoot: string,
  options: CompletedWriteGuardOptions = {},
): CompletedWriteGuardResult {
  const root = resolve(projectRoot);
  let records: readonly NameStatusRecord[];
  let pairingBaseRef = options.baseRef ?? "";
  try {
    if (options.nameStatus !== undefined) {
      records = parseNameStatusRecords(options.nameStatus);
    } else if (options.addedFiles !== undefined) {
      records = parseNameStatusRecords(
        options.addedFiles.map((rel) => `A\t${normalizeRepoRelPath(rel)}`).join("\n"),
      );
    } else {
      const inside = git(["rev-parse", "--is-inside-work-tree"], root);
      if (inside.status !== 0 || inside.stdout.trim() !== "true") {
        return {
          code: 0,
          findings: [],
          message: "verify_completed_write_guard: skipped -- not a git working tree.",
        };
      }
      let baseRef = options.baseRef ?? "";
      if (baseRef.length === 0 || baseRef === "HEAD") {
        const resolved = resolveDefaultBaseRef(root);
        if (resolved === null) {
          return {
            code: 2,
            findings: [],
            message:
              "verify_completed_write_guard: no merge-base ref found " +
              "(origin/master|main, DEFT_BASE_REF, or GITHUB_BASE_REF). " +
              "Pass --base-ref. Unguarded completed/ adds cannot be skipped.",
          };
        }
        baseRef = resolved;
      }
      records = discoverNameStatusRecords(root, baseRef);
      pairingBaseRef = baseRef;
    }
  } catch (err: unknown) {
    if (err instanceof GitNotFoundError) {
      return {
        code: 2,
        findings: [],
        message:
          "verify_completed_write_guard: 'git' executable not found on PATH.\n" +
          "  Recovery: install git or run inside a git working tree.",
      };
    }
    if (err instanceof GitCommandError) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("not a git repository") ||
        msg.includes("outside repository") ||
        msg.includes("not a git working tree")
      ) {
        return {
          code: 0,
          findings: [],
          message: `verify_completed_write_guard: skipped -- not a git working tree (${err.message}).`,
        };
      }
      return {
        code: 2,
        findings: [],
        message: `verify_completed_write_guard: git failed -- ${err.message}`,
      };
    }
    throw err;
  }

  const added = [
    ...new Set(
      records.filter((rec) => rec.status === "A" || rec.status === "R").map((rec) => rec.dest),
    ),
  ];

  const findings: CompletedWriteGuardFinding[] = [];
  // Pairing: stamped completed/ or cancelled/ dest (#3766). Cancel stamps
  // lifecycleWrite action=cancel. Status-only cancelled dests do not pair.
  // R dests are git-bound to src. D+A also requires dest plan.title to match
  // the deleted source so a copied stamp under the same basename cannot
  // authorize an unrelated deletion.
  interface AuthDest {
    readonly rel: string;
    readonly key: string;
    readonly identity: string;
  }
  const authorizedDests: AuthDest[] = [];

  const rememberDest = (rel: string, plan: Record<string, unknown>): void => {
    const key = pairingKey(rel);
    const identity = planIdentity(plan);
    if (key !== null && identity.length > 0) {
      authorizedDests.push({ rel, key, identity });
    }
  };

  for (const rel of added) {
    if (isCancelledArtifactRel(rel)) {
      const payload = readPayload(root, rel, options.payloads);
      if (payload.kind !== "ok") {
        continue;
      }
      const plan = parsePlan(payload.raw);
      if (plan !== null && transitionWriteFitsFolder(plan, "cancelled")) {
        rememberDest(rel, plan);
      }
      continue;
    }
    if (!isCompletedArtifactRel(rel)) {
      continue;
    }
    const payload = readPayload(root, rel, options.payloads);
    if (payload.kind === "missing") {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(`${rel}: added under completed/ but unreadable`),
      });
      continue;
    }
    if (payload.kind === "unsafe") {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(payload.detail),
      });
      continue;
    }
    const plan = parsePlan(payload.raw);
    if (plan === null) {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(`${rel}: added under completed/ with unreadable plan`),
      });
      continue;
    }
    if (!transitionWriteFitsFolder(plan, "completed")) {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(`${rel}: added under completed/ without a runTransition write`),
      });
      continue;
    }
    rememberDest(rel, plan);
  }

  const sourceIdentity = (src: string): string => {
    const payload = readPayload(root, src, options.payloads);
    if (payload.kind === "ok") {
      const plan = parsePlan(payload.raw);
      return plan === null ? "" : planIdentity(plan);
    }
    if (options.nameStatus !== undefined) {
      return "";
    }
    const specs: string[] = [`HEAD:${src}`];
    const deletedAt = git(["log", "-1", "--diff-filter=D", "--format=%H", "--", src], root);
    const deletedSha = deletedAt.stdout.trim();
    if (deletedAt.status === 0 && deletedSha.length > 0) {
      specs.push(`${deletedSha}^:${src}`);
    }
    specs.push(`HEAD^:${src}`);
    if (pairingBaseRef.length > 0) {
      specs.push(`${pairingBaseRef}:${src}`);
    }
    for (const spec of specs) {
      const shown = git(["show", spec], root);
      if (shown.status !== 0) {
        continue;
      }
      const plan = parsePlan(shown.stdout);
      if (plan === null) {
        continue;
      }
      const identity = planIdentity(plan);
      if (identity.length > 0) {
        return identity;
      }
    }
    return "";
  };

  const seenActive = new Set<string>();
  for (const rec of records) {
    if (rec.status !== "D" && rec.status !== "R") {
      continue;
    }
    if (!isActiveArtifactRel(rec.src)) {
      continue;
    }
    let paired = false;
    const srcId = sourceIdentity(rec.src);
    if (rec.status === "R") {
      const dest = authorizedDests.find((d) => d.rel === rec.dest);
      paired = dest !== undefined && srcId.length > 0 && dest.identity === srcId;
    } else {
      const srcKey = pairingKey(rec.src);
      if (srcKey !== null && srcId.length > 0) {
        paired = authorizedDests.some((d) => d.key === srcKey && d.identity === srcId);
      }
    }
    if (paired) {
      continue;
    }
    if (seenActive.has(rec.src)) {
      continue;
    }
    seenActive.add(rec.src);
    const verb = rec.status === "R" ? "renamed away from" : "deleted from";
    findings.push({
      relPath: rec.src,
      detail: sanitizeDetail(`${rec.src}: ${verb} active/ with no paired stamped destination`),
    });
  }

  if (findings.length === 0) {
    return {
      code: 0,
      findings: [],
      message: "verify_completed_write_guard: clean -- no unguarded completed/ adds",
    };
  }

  const destFindings = findings.filter((f) => isCompletedArtifactRel(f.relPath));
  const deleteFindings = findings.filter((f) => isActiveArtifactRel(f.relPath));
  if (deleteFindings.length === 0) {
    return {
      code: 1,
      findings,
      message:
        `verify_completed_write_guard: ${findings.length} unguarded completed/ add(s) (#3679).\n` +
        findings.map((f) => `  - ${f.detail}`).join("\n") +
        `\n${LEFTOVER_LAND_PR_REMEDIATION}`,
    };
  }

  const parts = [
    `verify_completed_write_guard: ${String(findings.length)} finding(s) (#3679 / #3766).`,
    ...findings.map((f) => `  - ${f.detail}`),
  ];
  if (destFindings.length > 0) {
    parts.push(LEFTOVER_LAND_PR_REMEDIATION);
  }
  parts.push(UNPAIRED_ACTIVE_DELETE_REMEDIATION);
  return {
    code: 1,
    findings,
    message: parts.join("\n"),
  };
}

export interface CompletedWriteCorpusResult {
  readonly findings: readonly CompletedWriteGuardFinding[];
  readonly scanned: number;
}

function listCompletedArtifactRels(projectRoot: string): string[] {
  const out: string[] = [];
  for (const dirName of [MIGRATED_ARTIFACT_DIR, LEGACY_ARTIFACT_DIR]) {
    const completedDir = join(projectRoot, dirName, "completed");
    if (!existsSync(completedDir)) {
      continue;
    }
    let names: string[] = [];
    try {
      names = readdirSync(completedDir).filter((n) => hasArtifactSuffix(n));
    } catch {
      continue;
    }
    for (const name of names) {
      out.push(`${dirName}/completed/${name}`);
    }
  }
  return out.sort();
}

/**
 * Corpus scan for doctor: artifacts without transition evidence.
 * Caller marks these advisory so historical pre-stamp files do not red doctor.
 */
export function scanCompletedWriteCorpus(projectRoot: string): CompletedWriteCorpusResult {
  const findings: CompletedWriteGuardFinding[] = [];
  const rels = listCompletedArtifactRels(projectRoot);
  for (const rel of rels) {
    const payload = readPayload(resolve(projectRoot), rel, undefined);
    if (payload.kind !== "ok") {
      continue;
    }
    const plan = parsePlan(payload.raw);
    if (plan === null) {
      continue;
    }
    if (!hasTransitionWrite(plan)) {
      findings.push({
        relPath: rel,
        detail: `${rel}: completed/ artifact has no runTransition write (historical advisory)`,
      });
    }
  }
  return { findings, scanned: rels.length };
}
