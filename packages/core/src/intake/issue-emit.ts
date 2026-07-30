import { createHash } from "node:crypto";
import {
  chmodSync,
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import { containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe, ProjectionContainmentError } from "../fs/projection-containment.js";
import { call } from "../scm/call.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import { resolveProjectRepo } from "../slice/project-context.js";
import type { ScmCallFn } from "./reconcile-issues.js";

export const GITHUB_ISSUE_REF_TYPE = "x-xbrief/github-issue";
export const EXTERNAL_TRUST_LEVEL = "external";

const ISSUE_URL_PATTERN = /https?:\/\/\S+?\/issues\/\d+/;

/**
 * Structured post-create failure: remote issue exists; local stamp/ledger may not.
 * `createdUrl` is the durable handle for retry (also mirrored in process + OS-temp recovery).
 */
export class IssueEmitError extends Error {
  readonly createdUrl?: string;

  constructor(message: string, options?: { createdUrl?: string }) {
    super(message);
    this.name = "IssueEmitError";
    if (options?.createdUrl !== undefined && options.createdUrl.length > 0) {
      this.createdUrl = options.createdUrl;
    }
  }
}

/**
 * Process-local fallback for post-create URL when project ledger and xBRIEF stamp both fail (#2880).
 * Survives same-process retry without re-create; paired with private OS-temp sidecar for restarts.
 */
const processPendingUrls = new Map<string, string>();

/** Vitest-only failure injection via env (not a production export surface). */
function testFailProjectLedger(): boolean {
  return process.env.VITEST === "true" && process.env.DEFT_ISSUE_EMIT_TEST_FAIL_LEDGER === "1";
}

function testFailStamp(): boolean {
  return process.env.VITEST === "true" && process.env.DEFT_ISSUE_EMIT_TEST_FAIL_STAMP === "1";
}

function privateRecoveryRoot(): string {
  const base =
    typeof process.env.XDG_RUNTIME_DIR === "string" && process.env.XDG_RUNTIME_DIR.length > 0
      ? process.env.XDG_RUNTIME_DIR
      : tmpdir();
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "u";
  return join(base, `deft-issue-emit-recovery-${uid}`);
}

/** Refuse dirs/files we do not own or that are group/other-writable (forged recovery, #2880). */
function isTrustedStat(st: {
  isSymbolicLink(): boolean;
  uid?: number;
  mode: number | bigint;
}): boolean {
  if (st.isSymbolicLink()) {
    return false;
  }
  if (typeof process.getuid === "function" && typeof st.uid === "number") {
    if (st.uid !== process.getuid()) {
      return false;
    }
  }
  // Group/other write bits allow another local principal to rewrite recovery state.
  const mode = Number(st.mode);
  if ((mode & 0o022) !== 0) {
    return false;
  }
  return true;
}

function ensureTrustedRecoveryDir(): string {
  const dir = privateRecoveryRoot();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (!isTrustedStat(dirStat) || !dirStat.isDirectory()) {
    throw new Error("issue-emit recovery dir is not a trusted directory owned by the current user");
  }
  if ((dirStat.mode & 0o777) !== 0o700) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best-effort tighten; isTrustedStat already refused group/other write.
    }
  }
  return dir;
}

export function recoverySidecarPath(vbriefAbsPath: string): string {
  const key = createHash("sha256").update(resolve(vbriefAbsPath)).digest("hex").slice(0, 40);
  return join(privateRecoveryRoot(), `${key}.json`);
}

/**
 * Write recovery sidecar without following symlinks (#2880 Greptile P1).
 * Trusted per-uid dir (ownership + mode) + containedWrite create (O_EXCL|O_NOFOLLOW).
 * #2980 wave B: product write sink routes through containedWrite.
 */
function writeRecoverySidecarSafe(sidePath: string, payload: string): void {
  const dir = ensureTrustedRecoveryDir();
  if (resolve(dirname(sidePath)) !== resolve(dir)) {
    // Always write under the validated recovery root.
    throw new Error("issue-emit recovery path escapes trusted root");
  }
  try {
    const existing = lstatSync(sidePath);
    if (existing.isSymbolicLink() || existing.isFile()) {
      // unlink of a symlink removes the link itself (does not follow).
      unlinkSync(sidePath);
    } else {
      throw new Error("issue-emit recovery path exists and is not a regular file");
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
  containedWrite({
    root: dir,
    target: sidePath,
    data: payload,
    mode: "create",
  });
}

/**
 * Always-on recovery after remote create: process memory + private OS-temp sidecar.
 * Independent of project-contained ledger so dual local failure still reconciles on retry (#2880).
 */
export function rememberCreatedUrl(vbriefAbsPath: string, url: string): void {
  const key = resolve(vbriefAbsPath);
  processPendingUrls.set(key, url);
  try {
    writeRecoverySidecarSafe(
      recoverySidecarPath(key),
      `${JSON.stringify({ path: key, url }, null, 2)}\n`,
    );
  } catch {
    // Best-effort disk mirror; process map still holds the URL for same-process retry.
  }
}

export function loadRecoveredUrl(vbriefAbsPath: string): string | undefined {
  const key = resolve(vbriefAbsPath);
  const mem = processPendingUrls.get(key);
  if (typeof mem === "string" && mem.length > 0) {
    return mem;
  }
  try {
    const side = recoverySidecarPath(key);
    // Parent dir must be trusted before we read any sidecar (forged-dir attack, #2880).
    const parent = dirname(side);
    const parentStat = lstatSync(parent);
    if (!isTrustedStat(parentStat) || !parentStat.isDirectory()) {
      return undefined;
    }
    const st = lstatSync(side);
    if (!st.isFile() || !isTrustedStat(st)) {
      return undefined;
    }
    const raw = readFileSync(side, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const url = obj.url;
      const pathField = obj.path;
      if (typeof url === "string" && url.length > 0 && ISSUE_URL_PATTERN.test(url)) {
        if (typeof pathField === "string" && resolve(pathField) !== key) {
          return undefined;
        }
        processPendingUrls.set(key, url);
        return url;
      }
    }
  } catch {
    // Missing or untrusted recovery file is empty.
  }
  return undefined;
}

export function clearRecoveredUrl(vbriefAbsPath: string): void {
  const key = resolve(vbriefAbsPath);
  processPendingUrls.delete(key);
  try {
    const side = recoverySidecarPath(key);
    try {
      const st = lstatSync(side);
      if (st.isSymbolicLink() || st.isFile()) {
        unlinkSync(side);
      }
    } catch {
      rmSync(side, { force: true });
    }
  } catch {
    // Best-effort clear.
  }
}

/** Project ledger first, then process/OS-temp recovery (#2880). */
export function resolvePriorCreatedUrl(
  projectRoot: string,
  vbriefAbsPath: string,
): string | undefined {
  const absPath = resolve(vbriefAbsPath);
  const pending = loadPendingEmitUrls(projectRoot)[absPath];
  if (typeof pending === "string" && pending.length > 0) {
    return pending;
  }
  return loadRecoveredUrl(absPath);
}

/**
 * Record URL immediately after remote create. Project ledger is best-effort;
 * recovery layers always run first so dual local failure cannot force re-create (#2880).
 */
export function recordCreatedUrlDurable(
  projectRoot: string,
  vbriefAbsPath: string,
  url: string,
): void {
  rememberCreatedUrl(vbriefAbsPath, url);
  if (testFailProjectLedger()) {
    return;
  }
  try {
    savePendingEmitUrl(projectRoot, vbriefAbsPath, url);
  } catch {
    // Recovery layers already hold the URL.
  }
}

function stampUrlOntoVbrief(
  path: string,
  data: Record<string, unknown>,
  url: string,
  projectRoot: string,
): void {
  if (testFailStamp()) {
    throw new Error("issue-emit test hook: stamp failure");
  }
  addGithubIssueReference(data, url);
  writeVbrief(path, data, projectRoot);
  clearPendingEmitUrl(projectRoot, path);
  clearRecoveredUrl(path);
}

/** Contained durable map: abs vbrief path -> issue URL for in-flight emits (#2871). */
export function pendingEmitLedgerPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".deft-cache", "issue-emit-pending.json");
}

export function loadPendingEmitUrls(projectRoot: string): Record<string, string> {
  const ledger = pendingEmitLedgerPath(projectRoot);
  try {
    assertWriteTargetSafe(projectRoot, ledger);
    const raw = readFileSync(ledger, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) {
          out[k] = v;
        }
      }
      return out;
    }
  } catch {
    // Missing or unreadable ledger is empty.
  }
  return {};
}

export function savePendingEmitUrl(projectRoot: string, vbriefAbsPath: string, url: string): void {
  const root = resolve(projectRoot);
  const ledger = pendingEmitLedgerPath(projectRoot);
  const map = loadPendingEmitUrls(projectRoot);
  map[resolve(vbriefAbsPath)] = url;
  // #2980 wave B: product write sink routes through containedWrite.
  containedWrite({
    root,
    target: ledger,
    data: `${JSON.stringify(map, null, 2)}\n`,
    mode: "replace",
  });
}

export function clearPendingEmitUrl(projectRoot: string, vbriefAbsPath: string): void {
  const root = resolve(projectRoot);
  const ledger = pendingEmitLedgerPath(projectRoot);
  const key = resolve(vbriefAbsPath);
  const map = loadPendingEmitUrls(projectRoot);
  if (!(key in map)) {
    return;
  }
  delete map[key];
  try {
    // #2980 wave B: product write sink routes through containedWrite.
    containedWrite({
      root,
      target: ledger,
      data: `${JSON.stringify(map, null, 2)}\n`,
      mode: "replace",
    });
  } catch {
    // Best-effort clear; next successful stamp still works via existingGithubIssueRef.
  }
}

export function loadVbrief(path: string): Record<string, unknown> {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * Resolve project root and refuse unsafe write targets before any emit side-effect.
 * Callers that create remote issues MUST invoke this before `fileIssue` so a
 * containment refusal cannot leave an orphan GitHub issue (#2869 / #2871).
 *
 * ⊗ Do not fall back to `dirname(path)` as the containment root — that trusts a
 * possibly-symlinked parent and would re-open the escape (Greptile P1 on #2871).
 */
export function assertVbriefWriteTargetSafe(path: string, projectRoot?: string | null): string {
  const absPath = resolve(path);
  // Resolve root only from explicit projectRoot, DEFT_PROJECT_ROOT, or cwd walk-up.
  // Never start discovery from dirname(absPath) — that trusts a possibly-symlinked parent
  // of the write target as the containment root (Greptile/SLizard P1 on #2871).
  const root =
    projectRoot !== undefined && projectRoot !== null && projectRoot.length > 0
      ? resolve(projectRoot)
      : resolveProjectRoot(null);
  if (root === null) {
    throw new ProjectionContainmentError(
      `projection write refused: could not resolve project root for ${absPath}; pass projectRoot or run from a project checkout`,
      {
        projectDir: process.cwd(),
        targetPath: absPath,
        offendingPath: absPath,
      },
    );
  }
  assertWriteTargetSafe(root, absPath);
  return root;
}

/**
 * Persist an xBRIEF/vBRIEF JSON document. Gates the write target so a leaf or
 * parent-directory symlink cannot divert the stamped file outside the project (#2869).
 * #2980 wave B: product write sink routes through containedWrite.
 */
export function writeVbrief(
  path: string,
  data: Record<string, unknown>,
  projectRoot?: string | null,
): void {
  const root = assertVbriefWriteTargetSafe(path, projectRoot);
  containedWrite({
    root,
    target: resolve(path),
    data: `${JSON.stringify(data, null, 2)}\n`,
    mode: "replace",
  });
}

export function vbriefTitle(data: Record<string, unknown>): string {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const title = plan.title;
  if (typeof title === "string" && title.trim().length > 0) {
    return title.trim();
  }
  const info = (data.vBRIEFInfo ?? {}) as Record<string, unknown>;
  const desc = info.description;
  if (typeof desc === "string" && desc.trim().length > 0) {
    return desc.trim();
  }
  return "Untitled vBRIEF";
}

export function existingGithubIssueRef(data: Record<string, unknown>): string | null | undefined {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return undefined;
  }
  for (const ref of refs) {
    if (ref !== null && typeof ref === "object" && !Array.isArray(ref)) {
      const obj = ref as Record<string, unknown>;
      if (referenceTypeMatches(String(obj.type ?? ""), "github-issue")) {
        const uri = obj.uri ?? obj.url;
        return typeof uri === "string" && uri.length > 0 ? uri : "";
      }
    }
  }
  return undefined;
}

export function addGithubIssueReference(
  data: Record<string, unknown>,
  url: string,
): Record<string, unknown> {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  data.plan = plan;
  const refs = Array.isArray(plan.references) ? plan.references : [];
  refs.push({
    uri: url,
    type: GITHUB_ISSUE_REF_TYPE,
    TrustLevel: EXTERNAL_TRUST_LEVEL,
  });
  plan.references = refs;
  return data;
}

export function renderIssueBody(data: Record<string, unknown>): string {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const narratives = (plan.narratives ?? {}) as Record<string, unknown>;
  const parts: string[] = [];

  const desc = narratives.Description;
  if (typeof desc === "string" && desc.trim().length > 0) {
    parts.push(`## Description\n\n${desc.trim()}`);
  }

  const acceptanceLines: string[] = [];
  const planAcceptance = narratives.Acceptance;
  if (typeof planAcceptance === "string" && planAcceptance.trim().length > 0) {
    acceptanceLines.push(planAcceptance.trim());
  }
  const items = plan.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      const narrative = (itemObj.narrative ?? {}) as Record<string, unknown>;
      const acc = narrative.Acceptance;
      if (typeof acc === "string" && acc.trim().length > 0) {
        const itemTitle = String(itemObj.title ?? "").trim();
        if (itemTitle.length > 0) {
          acceptanceLines.push(`- **${itemTitle}**: ${acc.trim()}`);
        } else {
          acceptanceLines.push(`- ${acc.trim()}`);
        }
      }
    }
  }
  if (acceptanceLines.length > 0) {
    parts.push(`## Acceptance\n\n${acceptanceLines.join("\n")}`);
  }

  const traces = narratives.Traces;
  if (typeof traces === "string" && traces.trim().length > 0) {
    parts.push(`## Traces\n\n${traces.trim()}`);
  }

  if (parts.length === 0) {
    return `Scope vBRIEF: ${vbriefTitle(data)}\n`;
  }
  return `${parts.join("\n\n")}\n`;
}

export function renderUmbrellaBody(
  entries: readonly [string, Record<string, unknown>][],
  intro?: string | null,
): string {
  const lines: string[] = [];
  if (intro !== undefined && intro !== null && intro.trim().length > 0) {
    lines.push(intro.trim(), "");
  }
  lines.push("## Tracked vBRIEFs", "");
  for (const [displayPath, data] of entries) {
    lines.push(`- [ ] ${vbriefTitle(data)} (\`${displayPath}\`)`);
  }
  return `${lines.join("\n")}\n`;
}

export function fileIssue(
  repo: string,
  title: string,
  body: string,
  scmCall: ScmCallFn = call,
): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "deft-issue-emit-"));
  const bodyPath = join(tmpDir, "body.md");
  try {
    // #2980 wave B: temp body file via containedWrite under the OS-temp dir.
    containedWrite({
      root: tmpDir,
      target: "body.md",
      data: body,
      mode: "create",
    });
    const result = scmCall(
      "github-issue",
      "issue",
      ["create", "--repo", repo, "--title", title, "--body-file", bodyPath],
      { timeout: 60 },
    );
    if (result.returncode !== 0) {
      throw new IssueEmitError(
        `gh issue create failed (exit ${result.returncode}): ${(result.stderr ?? "").trim()}`,
      );
    }
    const stdout = (result.stdout ?? "").trim();
    const match = ISSUE_URL_PATTERN.exec(stdout);
    if (match?.[0]) {
      return match[0];
    }
    if (stdout.length > 0) {
      return stdout;
    }
    throw new IssueEmitError("gh issue create succeeded but emitted no issue URL on stdout");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface EmitAction {
  result: "created" | "dryrun" | "skipped";
  vbrief: string;
  url?: string | null;
  title?: string;
}

export function emitSingle(
  path: string,
  options: {
    repo: string;
    scmCall?: ScmCallFn;
    noNetwork?: boolean;
    displayPath?: string | null;
    projectRoot?: string | null;
  },
): EmitAction {
  const shown = options.displayPath ?? path;
  const data = loadVbrief(path);
  const existing = existingGithubIssueRef(data);
  if (existing !== undefined) {
    return {
      result: "skipped",
      vbrief: shown,
      url: typeof existing === "string" && existing.length > 0 ? existing : null,
      title: vbriefTitle(data),
    };
  }

  const title = vbriefTitle(data);
  if (options.noNetwork) {
    return { result: "dryrun", vbrief: shown, url: null, title };
  }

  // Atomic emit contract (#2871 / #2880):
  // 1) Resolve a trusted project root (never dirname of target).
  // 2) Reconcile prior URL from project ledger OR process/OS-temp recovery (no re-create).
  // 3) Pre-persist current payload so the write path is proven.
  // 4) Create remote issue, then always record URL in recovery + best-effort project ledger.
  // 5) Stamp the vbrief; clear recovery on success. Dual local failure still retries safely.
  const root = assertVbriefWriteTargetSafe(path, options.projectRoot);
  const absPath = resolve(path);
  const priorUrl = resolvePriorCreatedUrl(root, absPath);
  if (typeof priorUrl === "string" && priorUrl.length > 0) {
    try {
      stampUrlOntoVbrief(path, data, priorUrl, root);
    } catch (stampErr) {
      throw new IssueEmitError(
        `reconcile ${priorUrl} but failed to stamp local vbrief: ${String(stampErr)}`,
        { createdUrl: priorUrl },
      );
    }
    return { result: "created", vbrief: shown, url: priorUrl, title };
  }

  writeVbrief(path, data, root);
  const body = renderIssueBody(data);
  assertVbriefWriteTargetSafe(path, root);
  const url = fileIssue(options.repo, title, body, options.scmCall);
  // Recovery layers first (process + OS-temp), then best-effort project ledger (#2880).
  // Dual ledger+stamp failure still leaves URL for retry without re-create.
  recordCreatedUrlDurable(root, absPath, url);
  try {
    stampUrlOntoVbrief(path, data, url, root);
  } catch (stampErr) {
    throw new IssueEmitError(
      `created ${url} but failed to stamp local vbrief: ${String(stampErr)}`,
      { createdUrl: url },
    );
  }
  return { result: "created", vbrief: shown, url, title };
}

export function emitPerVbrief(
  paths: string[],
  options: {
    repo: string;
    scmCall?: ScmCallFn;
    noNetwork?: boolean;
    displayPaths?: string[] | null;
    projectRoot?: string | null;
  },
): EmitAction[] {
  const shown = options.displayPaths ?? paths;
  const actions: EmitAction[] = [];
  for (let i = 0; i < paths.length; i += 1) {
    actions.push(
      emitSingle(paths[i] as string, {
        ...options,
        displayPath: shown[i] as string,
      }),
    );
  }
  return actions;
}

export interface UmbrellaAction {
  result: "created" | "dryrun" | "skipped";
  url: string | null;
  title: string;
  vbriefs: { vbrief: string; result: string }[];
}

function defaultUmbrellaTitle(count: number): string {
  const noun = count === 1 ? "vBRIEF" : "vBRIEFs";
  return `Umbrella: ${count} tracked ${noun}`;
}

export function emitUmbrella(
  paths: string[],
  options: {
    repo: string;
    scmCall?: ScmCallFn;
    noNetwork?: boolean;
    title?: string | null;
    displayPaths?: string[] | null;
    projectRoot?: string | null;
  },
): UmbrellaAction {
  const shown = options.displayPaths ?? paths;
  const loaded: [string, string, Record<string, unknown>][] = [];
  for (let i = 0; i < paths.length; i += 1) {
    loaded.push([paths[i] as string, shown[i] as string, loadVbrief(paths[i] as string)]);
  }

  const pending = loaded.filter(([, , data]) => existingGithubIssueRef(data) === undefined);
  const alreadyEntries = loaded.filter(([, , data]) => existingGithubIssueRef(data) !== undefined);
  const already = alreadyEntries.map(([, disp]) => ({ vbrief: disp, result: "skipped" }));

  // Already-stamped siblings seed the umbrella URL and participate in conflict checks (#2880).
  let stampedSiblingUrl: string | null = null;
  for (const [, , data] of alreadyEntries) {
    const ref = existingGithubIssueRef(data);
    if (typeof ref === "string" && ref.length > 0) {
      if (stampedSiblingUrl !== null && stampedSiblingUrl !== ref) {
        throw new IssueEmitError(
          `umbrella siblings already stamped with conflicting issue URLs: ${stampedSiblingUrl} vs ${ref}`,
          { createdUrl: stampedSiblingUrl },
        );
      }
      stampedSiblingUrl = ref;
    }
  }

  const umbrellaTitle = options.title ?? defaultUmbrellaTitle(loaded.length);

  if (pending.length === 0) {
    return { result: "skipped", url: stampedSiblingUrl, title: umbrellaTitle, vbriefs: already };
  }

  if (options.noNetwork) {
    return {
      result: "dryrun",
      url: null,
      title: umbrellaTitle,
      vbriefs: [...pending.map(([, disp]) => ({ vbrief: disp, result: "dryrun" })), ...already],
    };
  }

  // Umbrella emit: same durability contract as emitSingle (#2871 / #2880).
  // Reconcile pending/recovery URLs, pre-persist, create once, record all, stamp all.
  // Mid-loop ledger/stamp failure must not force a second remote create on retry.
  const root =
    options.projectRoot !== undefined &&
    options.projectRoot !== null &&
    options.projectRoot.length > 0
      ? resolve(options.projectRoot)
      : assertVbriefWriteTargetSafe(String(pending[0]?.[0] || ""), options.projectRoot);

  const written: { vbrief: string; result: string }[] = [];
  const stillNeedRemote: [string, string, Record<string, unknown>][] = [];
  // Pass 1: resolve recovered URLs and reject conflicts BEFORE any stamp (#2880).
  // Include already-stamped sibling URLs so partial umbrella cohorts cannot split.
  let reconciledUrl: string | null = stampedSiblingUrl;
  const withPrior: [string, string, Record<string, unknown>, string][] = [];
  for (const [path, disp, data] of pending) {
    const prior = resolvePriorCreatedUrl(root, path);
    if (typeof prior === "string" && prior.length > 0) {
      if (reconciledUrl !== null && reconciledUrl !== prior) {
        throw new IssueEmitError(
          `umbrella recovered conflicting issue URLs: ${reconciledUrl} vs ${prior}; resolve local pending/recovery state before retry`,
          { createdUrl: reconciledUrl },
        );
      }
      reconciledUrl = prior;
      withPrior.push([path, disp, data, prior]);
    } else {
      writeVbrief(path, data, root);
      stillNeedRemote.push([path, disp, data]);
    }
  }
  // Pass 2: stamp only after the recovered set is conflict-free.
  for (const [path, disp, data, prior] of withPrior) {
    try {
      stampUrlOntoVbrief(path, data, prior, root);
      written.push({ vbrief: disp, result: "created" });
    } catch {
      // Leave recovery/ledger for retry; still surface URL via reconciledUrl.
      written.push({ vbrief: disp, result: "pending-reconcile" });
    }
  }

  if (stillNeedRemote.length === 0) {
    const pendingLeft = written.some((w) => w.result === "pending-reconcile");
    if (pendingLeft && reconciledUrl !== null) {
      throw new IssueEmitError(
        `created ${reconciledUrl} but failed to stamp one or more umbrella vbriefs; retry to reconcile without re-create`,
        { createdUrl: reconciledUrl },
      );
    }
    return {
      result: "created",
      url: reconciledUrl,
      title: umbrellaTitle,
      vbriefs: [...written, ...already],
    };
  }

  // Sibling recovery: reuse recovered/stamped umbrella URL instead of a second remote create (#2880).
  let url = reconciledUrl;
  if (url === null || url.length === 0) {
    const body = renderUmbrellaBody(stillNeedRemote.map(([, disp, data]) => [disp, data]));
    url = fileIssue(options.repo, umbrellaTitle, body, options.scmCall);
  }

  // Record URL for every remaining artifact before any stamp can throw (#2880).
  for (const [path] of stillNeedRemote) {
    recordCreatedUrlDurable(root, path, url);
  }

  const stampErrors: string[] = [];
  for (const [path, disp, data] of stillNeedRemote) {
    try {
      stampUrlOntoVbrief(path, data, url, root);
      written.push({ vbrief: disp, result: "created" });
    } catch (stampErr) {
      stampErrors.push(`${disp}: ${String(stampErr)}`);
      written.push({ vbrief: disp, result: "pending-reconcile" });
    }
  }

  if (stampErrors.length > 0) {
    throw new IssueEmitError(
      `created ${url} but failed to stamp ${stampErrors.length} umbrella vbrief(s): ${stampErrors.join("; ")}`,
      { createdUrl: url },
    );
  }

  return { result: "created", url, title: umbrellaTitle, vbriefs: [...written, ...already] };
}

export function expandPatterns(patterns: string[], root: string | null = null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of patterns) {
    const candidate = root !== null && !isAbsolute(pattern) ? join(root, pattern) : pattern;
    let matches = globSync(candidate).sort();
    if (matches.length === 0) {
      try {
        readFileSync(candidate);
        matches = [candidate];
      } catch {
        matches = [];
      }
    }
    for (const match of matches) {
      const resolved = resolve(match);
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      out.push(match);
    }
  }
  return out;
}

export function isNoNetwork(dryRun: boolean): boolean {
  return dryRun || process.env.DEFT_NO_NETWORK === "1";
}

export function displayPath(path: string, projectRoot: string | null): string {
  if (projectRoot !== null) {
    try {
      return relative(resolve(projectRoot), resolve(path));
    } catch {
      // fall through
    }
  }
  return path;
}

export interface IssueEmitCliArgs {
  patterns: string[];
  umbrella?: boolean;
  perVbrief?: boolean;
  title?: string | null;
  dryRun?: boolean;
  json?: boolean;
  repo?: string | null;
  projectRoot?: string | null;
}

export function issueEmitMain(args: IssueEmitCliArgs): number {
  if (args.patterns.length === 0) {
    process.stderr.write("Error: Provide a vBRIEF path or glob(s) to emit\n");
    return 2;
  }
  if (args.title !== undefined && args.title !== null && !args.umbrella) {
    process.stderr.write("Error: --title is only valid with --umbrella\n");
    return 2;
  }

  const projectRoot = resolveProjectRoot(args.projectRoot ?? undefined);
  const paths = expandPatterns(args.patterns, projectRoot);
  if (paths.length === 0) {
    process.stderr.write(`Error: no vBRIEF files matched ${JSON.stringify(args.patterns)}.\n`);
    return 2;
  }

  const noNetwork = isNoNetwork(args.dryRun ?? false);
  let repo = "";
  if (!noNetwork) {
    repo = resolveProjectRepo(args.repo ?? undefined, projectRoot) ?? "";
    if (repo.length === 0) {
      process.stderr.write(
        "Error: could not detect repo. Pass --repo OWNER/NAME, set $DEFT_PROJECT_REPO, or run from the consumer repo (#538).\n",
      );
      return 2;
    }
  }

  const display = paths.map((p) => displayPath(p, projectRoot));

  try {
    let summary: Record<string, unknown>;
    if (args.umbrella) {
      const action = emitUmbrella(paths, {
        repo,
        noNetwork,
        title: args.title,
        displayPaths: display,
        projectRoot,
      });
      summary = { mode: "umbrella", no_network: noNetwork, umbrella: action };
    } else if (args.perVbrief) {
      const actions = emitPerVbrief(paths, {
        repo,
        noNetwork,
        displayPaths: display,
        projectRoot,
      });
      summary = { mode: "per-vbrief", no_network: noNetwork, actions };
    } else {
      if (paths.length !== 1) {
        process.stderr.write(
          `Error: single mode expects exactly one vBRIEF; matched ${paths.length}. Use --umbrella or --per-vbrief for globs.\n`,
        );
        return 2;
      }
      const action = emitSingle(paths[0] as string, {
        repo,
        noNetwork,
        displayPath: display[0],
        projectRoot,
      });
      summary = { mode: "single", no_network: noNetwork, actions: [action] };
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      printSummary(summary);
    }
    return 0;
  } catch (exc) {
    process.stderr.write(`Error: ${String(exc)}\n`);
    return 2;
  }
}

function printSummary(summary: Record<string, unknown>): void {
  const mode = String(summary.mode);
  const noNetwork = Boolean(summary.no_network);
  const banner = noNetwork ? "issue:emit plan (no network)" : "issue:emit";
  process.stdout.write(`${banner} -- mode: ${mode}\n`);
  if (mode === "umbrella") {
    const action = summary.umbrella as UmbrellaAction;
    const verbs: Record<string, string> = {
      created: "FILED umbrella",
      dryrun: "WOULD FILE umbrella",
      skipped: "SKIP umbrella (already tracked)",
    };
    const url = action.url ? ` -> ${action.url}` : "";
    process.stdout.write(`  ${verbs[action.result]}: ${action.title}${url}\n`);
    for (const child of action.vbriefs) {
      process.stdout.write(`    - ${child.result.toUpperCase().padEnd(8)} ${child.vbrief}\n`);
    }
  } else {
    const actions = summary.actions as EmitAction[];
    const verbs: Record<string, string> = {
      created: "FILED",
      dryrun: "WOULD FILE",
      skipped: "SKIP (already tracked)",
    };
    for (const action of actions) {
      const url = action.url ? ` -> ${action.url}` : "";
      process.stdout.write(`  ${verbs[action.result]?.padEnd(22) ?? ""} ${action.vbrief}${url}\n`);
    }
  }
}
