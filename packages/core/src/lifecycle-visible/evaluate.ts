/**
 * verify:lifecycle-visible — detect ignore/index flags that hide lifecycle roots (#3505).
 *
 * Warn-only by default (exit 0). Pass --enforce to fail closed.
 * Not a task-check gate: this is a per-clone environment property.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { defaultGitRunner, type GitRunner } from "../session/git.js";

const EXIT_OK = 0;
const EXIT_ENFORCE_FINDINGS = 1;
const EXIT_CONFIG = 2;

export const LIFECYCLE_ROOT_PREFIXES = ["xbrief", "vbrief"] as const;
export const LIFECYCLE_STAGE_DIRS = [
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;

export type LifecycleHideKind = "ignored" | "skip-worktree" | "assume-unchanged";

export interface LifecycleHideFinding {
  readonly path: string;
  readonly kind: LifecycleHideKind;
  readonly source: string;
  readonly line: number | null;
  readonly rule: string;
  readonly raw: string;
}

export interface LifecycleVisibleOptions {
  readonly projectRoot: string;
  readonly enforce?: boolean;
  readonly runGit?: GitRunner;
}

export interface LifecycleVisibleResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
  readonly findings: readonly LifecycleHideFinding[];
  readonly enforce: boolean;
  readonly failOpen: boolean;
}

export interface CheckIgnoreMatch {
  readonly source: string;
  readonly line: number;
  readonly pattern: string;
  readonly path: string;
}

export interface LsFilesVerboseRecord {
  readonly tag: string;
  readonly path: string;
}

/** Canonical lifecycle root pathspecs (`xbrief/active/`, `vbrief/pending/`, …). */
export function lifecycleRootRelPaths(): string[] {
  const paths: string[] = [];
  for (const prefix of LIFECYCLE_ROOT_PREFIXES) {
    for (const stage of LIFECYCLE_STAGE_DIRS) {
      paths.push(`${prefix}/${stage}/`);
    }
  }
  return paths;
}

/** Date-prefixed brief-shaped pathname so `2026-*.xbrief.json` and `*.json` both fire. */
export const LIFECYCLE_PROBE_SENTINEL = "2026-01-01-lifecycle-visible.xbrief.json";

/** Legacy vbrief filename so `*.vbrief.json` / `2026-*.vbrief.json` cannot report clean. */
export const LIFECYCLE_PROBE_SENTINEL_VBRIEF = "2026-01-01-lifecycle-visible.vbrief.json";

function sentinelForRoot(root: string): string {
  return root.startsWith("vbrief/") ? LIFECYCLE_PROBE_SENTINEL_VBRIEF : LIFECYCLE_PROBE_SENTINEL;
}

/** Stage dirs plus one matching-extension sentinel under each. */
export function lifecycleIgnoreProbeRelPaths(): string[] {
  const probes: string[] = [];
  for (const root of lifecycleRootRelPaths()) {
    probes.push(root);
    probes.push(`${root}${sentinelForRoot(root)}`);
  }
  return probes;
}

/** Map a check-ignore pathname back to its canonical stage root, or null if outside. */
export function lifecycleRootForRelPath(relPosix: string): string | null {
  const posix = relPosix.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const root of lifecycleRootRelPaths()) {
    const prefix = root.replace(/\/+$/, "");
    if (posix === prefix || posix.startsWith(`${prefix}/`)) return root;
  }
  return null;
}

/** Deliberate hybrid ignores under a visible root must not trip the check (#1144). */
export function isSelectiveLifecyclePath(relPosix: string): boolean {
  const posix = relPosix.replace(/\\/g, "/");
  return posix.includes("/.triage-cache/") || posix.includes(".triage-cache/");
}

/** Map git check-ignore source paths to the actionable display form. */
export function displayIgnoreSource(source: string, projectRoot: string): string {
  const posix = source.replace(/\\/g, "/");
  if (posix.endsWith("/info/exclude") || posix.endsWith(".git/info/exclude")) {
    return ".git/info/exclude";
  }
  try {
    const rel = relative(resolve(projectRoot), resolve(source)).replace(/\\/g, "/");
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
      return rel;
    }
  } catch {
    // keep original
  }
  return source;
}

/**
 * Parse one `git check-ignore -v` line: `<source>:<linenum>:<pattern>\\t<pathname>`.
 * Source may be a Windows absolute path with a drive colon.
 */
export function parseCheckIgnoreVerboseLine(line: string): CheckIgnoreMatch | null {
  const tab = line.lastIndexOf("\t");
  if (tab < 0) return null;
  const meta = line.slice(0, tab);
  const pathname = line.slice(tab + 1).replace(/\\/g, "/");
  const match = /^(.*):(\d+):(.*)$/.exec(meta);
  if (match === null) return null;
  const source = match[1] ?? "";
  const lineNo = Number.parseInt(match[2] ?? "", 10);
  const pattern = match[3] ?? "";
  if (source.length === 0 || Number.isNaN(lineNo)) return null;
  return { source, line: lineNo, pattern, path: pathname };
}

/** Parse one `git ls-files -v` record (`S path` / `h path`). */
export function parseLsFilesVerboseRecord(record: string): LsFilesVerboseRecord | null {
  if (record.length < 3 || record[1] !== " ") return null;
  const tag = record[0];
  if (tag === undefined) return null;
  return { tag, path: record.slice(2).replace(/\\/g, "/") };
}

/** Index flag encoded by the `ls-files -v` status tag. */
export function indexFlagKind(tag: string): "skip-worktree" | "assume-unchanged" | null {
  if (tag === "S" || tag === "s") return "skip-worktree";
  if (tag.length === 1 && tag >= "a" && tag <= "z") return "assume-unchanged";
  return null;
}

/** Git top-level so a nested cwd cannot miss repo-root lifecycle dirs. */
function resolveScanRoot(projectRoot: string, runGit: GitRunner): string {
  const { code, stdout } = runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (code === 0 && stdout.trim().length > 0) {
    return resolve(stdout.trim());
  }
  return resolve(projectRoot);
}

function formatFinding(finding: LifecycleHideFinding): string {
  if (finding.kind === "ignored") {
    const loc =
      finding.line === null
        ? `${finding.source}:${finding.rule}`
        : `${finding.source}:${finding.line}:${finding.rule}`;
    return `  ${finding.path}  ignored by ${loc}`;
  }
  return `  ${finding.path}  ${finding.kind} (${finding.source})`;
}

function resultFor(
  findings: readonly LifecycleHideFinding[],
  enforce: boolean,
): LifecycleVisibleResult {
  if (findings.length === 0) {
    return {
      code: EXIT_OK,
      message:
        `OK: verify:lifecycle-visible — lifecycle roots are not hidden by ignore rules ` +
        `or index flags (enforce=${enforce}).`,
      stream: "stdout",
      findings: [],
      enforce,
      failOpen: !enforce,
    };
  }
  const lines = [
    `verify:lifecycle-visible: ${findings.length} hidden lifecycle path(s):`,
    ...findings.map(formatFinding),
  ];
  if (enforce) {
    lines.push(
      "FAIL: --enforce is set; remove the matching ignore rule or index flag so lifecycle roots stay visible to git (#3505).",
    );
    return {
      code: EXIT_ENFORCE_FINDINGS,
      message: lines.join("\n"),
      stream: "stderr",
      findings,
      enforce: true,
      failOpen: false,
    };
  }
  lines.push("ADVISORY (warn-only): exit 0. Pass --enforce to fail closed (#3505).");
  return {
    code: EXIT_OK,
    message: lines.join("\n"),
    stream: "stdout",
    findings,
    enforce: false,
    failOpen: true,
  };
}

function joinPath(root: string, relPosix: string): string {
  return resolve(
    root,
    ...relPosix
      .replace(/\/+$/, "")
      .split("/")
      .filter((p) => p.length > 0),
  );
}

/** Existing non-dot files under present stage dirs (skip .triage-cache / .gitkeep). */
function presentLifecycleFileRelPaths(projectRoot: string): string[] {
  const out: string[] = [];
  for (const root of lifecycleRootRelPaths()) {
    let entries: readonly Dirent[];
    try {
      entries = readdirSync(joinPath(projectRoot, root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || ent.name.startsWith(".")) continue;
      const rel = `${root.replace(/\/+$/, "")}/${ent.name}`;
      if (isSelectiveLifecyclePath(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

function collectIgnoredRoots(projectRoot: string, runGit: GitRunner): LifecycleHideFinding[] {
  // Probe every canonical stage even when the directory is absent so an ignore
  // rule cannot hide a missing xbrief/active/ before it is created (#3505).
  // Directory pathspecs miss file-only globs (`xbrief/active/*.json`); a
  // brief-shaped sentinel plus present files close that hole.
  const probes = [
    ...new Set([...lifecycleIgnoreProbeRelPaths(), ...presentLifecycleFileRelPaths(projectRoot)]),
  ];
  // --no-index: report the matching rule even when some files under the root
  // are already tracked (the #3504 hide is untracked new briefs).
  const { code, stdout, stderr } = runGit(projectRoot, [
    "check-ignore",
    "-v",
    "--no-index",
    "--",
    ...probes,
  ]);
  if (code === 1) return [];
  if (code !== 0) {
    throw new GitProbeError(code, stderr || "git check-ignore failed");
  }
  const findings: LifecycleHideFinding[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine.length === 0) continue;
    const negatedLine = rawLine.startsWith("!");
    const line = negatedLine ? rawLine.slice(1) : rawLine;
    const parsed = parseCheckIgnoreVerboseLine(line);
    if (parsed === null) continue;
    if (negatedLine || parsed.pattern.startsWith("!")) continue;
    if (isSelectiveLifecyclePath(parsed.path)) continue;
    const displayPath = lifecycleRootForRelPath(parsed.path);
    if (displayPath === null) continue;
    const source = displayIgnoreSource(parsed.source, projectRoot);
    const key = `${displayPath}|ignored|${source}|${parsed.line}|${parsed.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      path: displayPath,
      kind: "ignored",
      source,
      line: parsed.line,
      rule: parsed.pattern,
      raw: rawLine,
    });
  }
  return findings;
}

function collectIndexFlags(projectRoot: string, runGit: GitRunner): LifecycleHideFinding[] {
  const pathspecs = lifecycleRootRelPaths().map((rel) => rel.replace(/\/+$/, ""));
  const { code, stdout, stderr } = runGit(projectRoot, ["ls-files", "-v", "--", ...pathspecs]);
  if (code !== 0) {
    if (code === 1 && stdout.length === 0) return [];
    throw new GitProbeError(code, stderr || "git ls-files -v failed");
  }
  const findings: LifecycleHideFinding[] = [];
  for (const record of stdout.split(/\r?\n/)) {
    if (record.length === 0) continue;
    const parsed = parseLsFilesVerboseRecord(record);
    if (parsed === null) continue;
    if (isSelectiveLifecyclePath(parsed.path)) continue;
    const kind = indexFlagKind(parsed.tag);
    if (kind === null) continue;
    findings.push({
      path: parsed.path,
      kind,
      source: "index",
      line: null,
      rule: kind,
      raw: record,
    });
  }
  return findings;
}

class GitProbeError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Session:start advisory lines — silent when clean. */
export function formatLifecycleVisibleSessionLines(result: LifecycleVisibleResult): string[] {
  if (result.findings.length === 0) return [];
  const lines = result.findings.map((finding) => {
    if (finding.kind === "ignored") {
      const loc =
        finding.line === null
          ? `${finding.source}:${finding.rule}`
          : `${finding.source}:${finding.line}:${finding.rule}`;
      return `[deft lifecycle-visible] hidden ${finding.path}  (${loc})`;
    }
    return `[deft lifecycle-visible] ${finding.kind} on ${finding.path}`;
  });
  lines.push(
    "[deft lifecycle-visible] ADVISORY: lifecycle roots must stay visible to git " +
      "(warn-only; task verify:lifecycle-visible -- --enforce to fail closed).",
  );
  return lines;
}

/** Evaluate whether lifecycle roots are hidden by ignore rules or index flags (#3505). */
export function evaluateLifecycleVisible(options: LifecycleVisibleOptions): LifecycleVisibleResult {
  const root = resolve(options.projectRoot);
  const enforce = options.enforce === true;
  if (!existsSync(root)) {
    return {
      code: EXIT_CONFIG,
      message: `verify:lifecycle-visible: project root not found: ${root}`,
      stream: "stderr",
      findings: [],
      enforce,
      failOpen: !enforce,
    };
  }
  const runGit = options.runGit ?? defaultGitRunner;
  try {
    const scanRoot = resolveScanRoot(root, runGit);
    const findings = [
      ...collectIgnoredRoots(scanRoot, runGit),
      ...collectIndexFlags(scanRoot, runGit),
    ];
    return resultFor(findings, enforce);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const gitCode = err instanceof GitProbeError ? err.exitCode : undefined;
    const hint =
      gitCode === 127
        ? "git executable not found on PATH"
        : gitCode === 128
          ? "not a git repository"
          : detail;
    return {
      code: EXIT_CONFIG,
      message: `verify:lifecycle-visible: ${hint}`,
      stream: "stderr",
      findings: [],
      enforce,
      failOpen: !enforce,
    };
  }
}
