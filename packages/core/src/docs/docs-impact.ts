#!/usr/bin/env node
/**
 * Declared-versus-touched documentation-impact verifier (#4099).
 *
 * Transport matches closing-keywords: `--pr` (REST pull body) or `--body-file`.
 * Rationale is quoted, length-bounded data and is never a gate input.
 * `no user-doc impact` is refused when a registered command, skill, help key,
 * or public docs-site page is added or removed. Change-class `withdraw` maps
 * to that closed surface set. #447 remains the rule body by reference.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { CHANGE_CLASSES, type ChangeClass } from "./capability-map.js";

export const EXIT_OK = 0;
export const EXIT_IMPACT = 1;
export const EXIT_CONFIG = 2;
export const RATIONALE_MAX_CHARS = 500;

export const CLOSED_SURFACE_KINDS = ["command", "skill-trigger", "help", "docs-site"] as const;
export type ClosedSurfaceKind = (typeof CLOSED_SURFACE_KINDS)[number];

export type DocsImpactChangeClass = ChangeClass | "none";

export interface DeclaredSurface {
  readonly kind: ClosedSurfaceKind;
  readonly id: string;
}

export interface SurfaceChange extends DeclaredSurface {
  readonly op: "add" | "remove";
}

export interface NameStatus {
  readonly status: string;
  readonly path: string;
}

export interface ParsedDeclaration {
  readonly changeClass: DocsImpactChangeClass;
  readonly surfaces: readonly DeclaredSurface[];
  readonly rationale: string;
  readonly noUserDocImpact: boolean;
}

export interface DocsImpactResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly declaration: ParsedDeclaration | null;
}

export type RunGhFn = (cmd: readonly string[]) => {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunGitFn = (args: readonly string[]) => {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const NO_IMPACT_RE = /no user-doc impact/i;
const CHANGE_CLASS_RE = /^change_class:\s*(add|change|withdraw|none)\s*$/im;
const SURFACES_RE = /^surfaces:\s*(.+)\s*$/im;
const RATIONALE_RE = /^rationale:\s*"((?:\\.|[^"\\])*)"\s*$/im;
const HELP_KEY_RE = /^\s+"([^"]+)": \{/gm;
const SKILL_MD_RE = /^content\/skills\/([^/]+)\/SKILL\.md$/;
const DOCS_SITE_RE = /^docs-site\/[^/]+\.html$/;
const TASK_FRAGMENT_RE = /^tasks\/([^./]+)\.yml$/;

function isClosedKind(value: string): value is ClosedSurfaceKind {
  return (CLOSED_SURFACE_KINDS as readonly string[]).includes(value);
}

function isChangeClass(value: string): value is DocsImpactChangeClass {
  return value === "none" || (CHANGE_CLASSES as readonly string[]).includes(value);
}

export function parseDeclaredSurfaces(raw: string): DeclaredSurface[] {
  const trimmed = raw.trim();
  if (trimmed === "none" || trimmed.length === 0) return [];
  const out: DeclaredSurface[] = [];
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (token.length === 0 || token === "none") continue;
    const idx = token.indexOf(":");
    if (idx <= 0) continue;
    const kind = token.slice(0, idx).trim();
    const id = token.slice(idx + 1).trim();
    if (isClosedKind(kind) && id.length > 0) out.push({ kind, id });
  }
  return out;
}

export function parseDocsImpactDeclaration(body: string): {
  declaration: ParsedDeclaration | null;
  errors: string[];
} {
  const errors: string[] = [];
  const noUserDocImpact = NO_IMPACT_RE.test(body);
  const classMatch = CHANGE_CLASS_RE.exec(body);
  const surfacesMatch = SURFACES_RE.exec(body);
  const rationaleMatch = RATIONALE_RE.exec(body);
  if (classMatch === null && !noUserDocImpact) {
    errors.push("missing documentation-impact declaration (change_class or `no user-doc impact`)");
  }
  if (surfacesMatch === null && !noUserDocImpact) {
    errors.push("missing surfaces: field (use `none` or kind:id list)");
  }
  if (rationaleMatch === null) {
    errors.push('missing quoted rationale: "..." (length-bounded data; never a gate input)');
  } else if (rationaleMatch[1] !== undefined && rationaleMatch[1].length > RATIONALE_MAX_CHARS) {
    errors.push(`rationale exceeds ${RATIONALE_MAX_CHARS} characters`);
  }
  const classRaw = classMatch?.[1] ?? (noUserDocImpact ? "none" : "");
  if (classRaw.length > 0 && !isChangeClass(classRaw)) {
    errors.push(`invalid change_class: ${classRaw}`);
  }
  if (errors.length > 0) return { declaration: null, errors };
  const changeClass: DocsImpactChangeClass = isChangeClass(classRaw) ? classRaw : "none";
  const surfaces = noUserDocImpact ? [] : parseDeclaredSurfaces(surfacesMatch?.[1] ?? "none");
  return {
    declaration: {
      changeClass,
      surfaces,
      rationale: rationaleMatch?.[1] ?? "",
      noUserDocImpact: noUserDocImpact || changeClass === "none",
    },
    errors,
  };
}

/** Template fields from .github/PULL_REQUEST_TEMPLATE.md (#4099 / #4293). */
export const DOCS_IMPACT_SEED_BLOCK =
  "## Documentation impact\n" +
  "\n" +
  "change_class: none\n" +
  "surfaces: none\n" +
  'rationale: "No closed user-doc surface added or removed."\n';

/** Compose the template docs-impact block into an explicit PR body. */
export function composeDocsImpactBody(body: string, seed: string = DOCS_IMPACT_SEED_BLOCK): string {
  const parsed = parseDocsImpactDeclaration(body);
  if (parsed.declaration !== null) return body;
  const trimmed = body.replace(/\s+$/u, "");
  if (trimmed.length === 0) return seed;
  return `${trimmed}\n\n${seed}`;
}

/** Run the existing --body-file verifier on one path object (#4293). */
export function verifyDocsImpactBodyFile(
  bodyFile: string,
  projectRoot: string,
  seams: { runGh?: RunGhFn; runGit?: RunGitFn } = {},
): number {
  return docsImpactMain(["--body-file", bodyFile, "--project-root", projectRoot], seams);
}

function sliceAssignment(source: string, name: string): string {
  const match = new RegExp(`(?:export )?const ${name}\\b[^=]*=`).exec(source);
  if (match === null || match.index === undefined) return "";
  const after = source.slice(match.index + match[0].length);
  const openRel = after.search(/[[{]/);
  if (openRel < 0) return "";
  const origin = match.index + match[0].length + openRel;
  const openCh = source[origin];
  const closeCh = openCh === "[" ? "]" : "}";
  let depth = 0;
  let inString: string | null = null;
  for (let i = origin; i < source.length; i += 1) {
    const ch = source[i];
    const prev = i > 0 ? source[i - 1] : "";
    if (inString !== null) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return source.slice(origin, i + 1);
    }
  }
  return "";
}

export function extractQuotedArray(source: string, name: string): string[] {
  return [...sliceAssignment(source, name).matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined);
}

export function extractRecordKeys(source: string, name: string): string[] {
  return [...sliceAssignment(source, name).matchAll(/"([^"]+)"\s*:/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined);
}

export function extractTaskKeys(yml: string): string[] {
  const keys: string[] = [];
  const lines = yml.replace(/\r\n/g, "\n").split("\n");
  let inTasks = false;
  for (const line of lines) {
    if (line.startsWith("tasks:")) {
      inTasks = true;
      continue;
    }
    if (inTasks && line.length > 0 && !line.startsWith(" ") && line.trim() !== "tasks:") {
      inTasks = false;
    }
    if (!inTasks) continue;
    const m = /^ {2}([A-Za-z_][\w:-]*)\s*:/.exec(line);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

export function extractHelpKeysFromSource(source: string): Set<string> {
  const keys = new Set<string>();
  const start = source.indexOf("registry:");
  const block = start >= 0 ? source.slice(start) : source;
  HELP_KEY_RE.lastIndex = 0;
  for (const match of block.matchAll(HELP_KEY_RE)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

export function extractSkillIdsFromPack(source: string): Set<string> {
  const ids = new Set<string>();
  try {
    const parsed = JSON.parse(source) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return ids;
    const pack = parsed as { skills?: readonly { id?: unknown }[] };
    for (const skill of pack.skills ?? []) {
      if (typeof skill.id === "string" && skill.id.length > 0) ids.add(skill.id);
    }
  } catch {
    // Invalid JSON is treated as an empty snapshot; callers still see path-level adds.
  }
  return ids;
}

export function extractCommandIdsFromSources(files: Record<string, string>): Set<string> {
  const ids = new Set<string>();
  const dispatch = files["packages/cli/src/dispatch.ts"];
  if (dispatch !== undefined) {
    for (const name of ["CLI_MODULE_VERBS", "CORE_MODULE_VERBS"]) {
      for (const id of extractQuotedArray(dispatch, name)) ids.add(id);
    }
    for (const id of extractRecordKeys(dispatch, "VERB_ALIASES")) ids.add(id);
  }
  const router = files["packages/cli/src/cli-router/route-argv.ts"];
  if (router !== undefined) {
    for (const id of extractQuotedArray(router, "TOP_LEVEL_UX_VERBS")) ids.add(id);
  }
  const rootTasks = files["Taskfile.yml"];
  if (rootTasks !== undefined) {
    for (const id of extractTaskKeys(rootTasks)) ids.add(id);
  }
  for (const [path, text] of Object.entries(files)) {
    const ns = TASK_FRAGMENT_RE.exec(path)?.[1];
    if (ns === undefined) continue;
    for (const local of extractTaskKeys(text)) ids.add(`${ns}:${local}`);
  }
  return ids;
}

function setDiff<T>(from: ReadonlySet<T>, to: ReadonlySet<T>): T[] {
  const out: T[] = [];
  for (const item of to) {
    if (!from.has(item)) out.push(item);
  }
  return out;
}

function fileAt(files: Record<string, string>, path: string): string {
  return files[path] ?? "";
}

export function detectClosedSurfaceChanges(input: {
  readonly nameStatus: readonly NameStatus[];
  readonly baseFiles: Record<string, string>;
  readonly headFiles: Record<string, string>;
}): SurfaceChange[] {
  const changes: SurfaceChange[] = [];
  const seen = new Set<string>();
  const push = (kind: ClosedSurfaceKind, id: string, op: "add" | "remove"): void => {
    const key = `${op}:${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    changes.push({ kind, id, op });
  };

  const commandTouched = input.nameStatus.some(
    (row) =>
      row.path === "packages/cli/src/dispatch.ts" ||
      row.path === "packages/cli/src/cli-router/route-argv.ts" ||
      row.path === "Taskfile.yml" ||
      TASK_FRAGMENT_RE.test(row.path),
  );
  if (commandTouched) {
    const base = extractCommandIdsFromSources(input.baseFiles);
    const head = extractCommandIdsFromSources(input.headFiles);
    for (const id of setDiff(base, head)) push("command", id, "add");
    for (const id of setDiff(head, base)) push("command", id, "remove");
  }

  const skillPack = "content/packs/skills/skills-pack-0.1.json";
  if (input.nameStatus.some((row) => row.path === skillPack)) {
    const base = extractSkillIdsFromPack(fileAt(input.baseFiles, skillPack));
    const head = extractSkillIdsFromPack(fileAt(input.headFiles, skillPack));
    for (const id of setDiff(base, head)) push("skill-trigger", id, "add");
    for (const id of setDiff(head, base)) push("skill-trigger", id, "remove");
  }
  for (const row of input.nameStatus) {
    const skill = SKILL_MD_RE.exec(row.path)?.[1];
    if (skill === undefined) continue;
    if (row.status.startsWith("A")) push("skill-trigger", skill, "add");
    if (row.status.startsWith("D")) push("skill-trigger", skill, "remove");
  }

  const helpPath = "packages/core/src/triage/help/registry-data.ts";
  if (input.nameStatus.some((row) => row.path === helpPath)) {
    const base = extractHelpKeysFromSource(fileAt(input.baseFiles, helpPath));
    const head = extractHelpKeysFromSource(fileAt(input.headFiles, helpPath));
    for (const id of setDiff(base, head)) push("help", id, "add");
    for (const id of setDiff(head, base)) push("help", id, "remove");
  }

  for (const row of input.nameStatus) {
    if (!DOCS_SITE_RE.test(row.path)) continue;
    if (row.status.startsWith("A")) push("docs-site", row.path, "add");
    if (row.status.startsWith("D")) push("docs-site", row.path, "remove");
  }

  return changes;
}

function surfaceKey(surface: DeclaredSurface): string {
  return `${surface.kind}:${surface.id}`;
}

export function evaluateDocsImpact(input: {
  readonly body: string;
  readonly changes: readonly SurfaceChange[];
}): DocsImpactResult {
  const parsed = parseDocsImpactDeclaration(input.body);
  if (parsed.declaration === null) {
    return { ok: false, errors: parsed.errors, declaration: null };
  }
  const errors = [...parsed.errors];
  const declaration = parsed.declaration;
  const adds = input.changes.filter((change) => change.op === "add");
  const removes = input.changes.filter((change) => change.op === "remove");
  const mutating = [...adds, ...removes];
  if (declaration.noUserDocImpact && mutating.length > 0) {
    const listed = mutating.map((change) => `${change.op} ${surfaceKey(change)}`).join(", ");
    errors.push(
      `no user-doc impact is refused when a registered command, skill, help key, or docs-site page is added or removed (${listed})`,
    );
  }
  if (declaration.changeClass === "withdraw" && removes.length === 0) {
    errors.push(
      "change_class withdraw requires a closed-surface detecting event (remove of command/skill/help key/docs-site page)",
    );
  }
  if (!declaration.noUserDocImpact && mutating.length > 0) {
    const declared = new Set(declaration.surfaces.map(surfaceKey));
    for (const change of mutating) {
      if (!declared.has(surfaceKey(change))) {
        errors.push(
          `declared-versus-touched: ${change.op} ${surfaceKey(change)} is not listed in surfaces`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors, declaration };
}

export function parseNameStatus(text: string): NameStatus[] {
  const rows: NameStatus[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const status = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1);
    const path = rest.includes("\t") ? rest.slice(rest.lastIndexOf("\t") + 1) : rest;
    rows.push({ status, path });
  }
  return rows;
}

export function parseDocsImpactArgs(argv: readonly string[]): {
  pr: number | null;
  bodyFile: string | null;
  repo: string | null;
  projectRoot: string | null;
  help: boolean;
  error: string | null;
} {
  let pr: number | null = null;
  let bodyFile: string | null = null;
  let repo: string | null = null;
  let projectRoot: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--pr") {
      const value = argv[i + 1];
      if (value === undefined) return emptyArgs("argument --pr: expected one argument");
      const n = Number(value);
      if (!Number.isInteger(n)) return emptyArgs(`invalid int value: ${JSON.stringify(value)}`);
      pr = n;
      i += 1;
    } else if (arg?.startsWith("--pr=")) {
      const n = Number(arg.slice("--pr=".length));
      if (!Number.isInteger(n)) return emptyArgs(`invalid --pr value`);
      pr = n;
    } else if (arg === "--body-file") {
      const value = argv[i + 1];
      if (value === undefined) return emptyArgs("argument --body-file: expected one argument");
      bodyFile = value;
      i += 1;
    } else if (arg?.startsWith("--body-file=")) {
      bodyFile = arg.slice("--body-file=".length);
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) return emptyArgs("argument --repo: expected one argument");
      repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) return emptyArgs("argument --project-root: expected one argument");
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg?.startsWith("-")) {
      return emptyArgs(`unrecognized arguments: ${arg}`);
    }
  }
  return { pr, bodyFile, repo, projectRoot, help, error: null };
}

function emptyArgs(error: string): {
  pr: number | null;
  bodyFile: string | null;
  repo: string | null;
  projectRoot: string | null;
  help: boolean;
  error: string;
} {
  return { pr: null, bodyFile: null, repo: null, projectRoot: null, help: false, error };
}

export function restPullsPath(repo: string, pr: number): string {
  return `repos/${repo}/pulls/${pr}`;
}

export function fetchPrBodyRest(pr: number, repo: string, runGh: RunGhFn): string | null {
  const cmd = ["gh", "api", restPullsPath(repo, pr)];
  const { returncode, stdout, stderr } = runGh(cmd);
  if (returncode !== 0) {
    process.stderr.write(`Error: gh REST failed fetching PR #${pr}: ${stderr.trim()}\n`);
    return null;
  }
  try {
    const payload = JSON.parse(stdout) as { body?: unknown };
    return typeof payload.body === "string" ? payload.body : "";
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: failed to parse gh REST output: ${message}\n`);
    return null;
  }
}

export function defaultRunGh(cmd: readonly string[]): {
  returncode: number;
  stdout: string;
  stderr: string;
} {
  if (cmd.length === 0 || cmd[0] !== "gh") {
    return { returncode: -1, stdout: "", stderr: "expected gh as first argv element" };
  }
  try {
    const stdout = execFileSync(cmd[0], cmd.slice(1), {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      returncode: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? ""),
    };
  }
}

export function defaultRunGit(
  args: readonly string[],
  cwd: string,
): { returncode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      returncode: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? ""),
    };
  }
}

const SNAPSHOT_PATHS = [
  "packages/cli/src/dispatch.ts",
  "packages/cli/src/cli-router/route-argv.ts",
  "Taskfile.yml",
  "content/packs/skills/skills-pack-0.1.json",
  "packages/core/src/triage/help/registry-data.ts",
] as const;

function collectSnapshotPaths(nameStatus: readonly NameStatus[]): string[] {
  const paths = new Set<string>(SNAPSHOT_PATHS);
  for (const row of nameStatus) {
    if (TASK_FRAGMENT_RE.test(row.path)) paths.add(row.path);
  }
  return [...paths];
}

function gitShowFile(runGit: RunGitFn, spec: string): string {
  const shown = runGit(["show", spec]);
  return shown.returncode === 0 ? shown.stdout : "";
}

export function docsImpactMain(
  argv: readonly string[] = process.argv.slice(2),
  seams: { runGh?: RunGhFn; runGit?: RunGitFn } = {},
): number {
  const parsed = parseDocsImpactArgs(argv);
  if (parsed.help) {
    process.stdout.write(
      "usage: docs-impact --pr <n> | --body-file <path> [--repo owner/name] [--project-root <dir>]\n" +
        "  declared-versus-touched documentation-impact check (#4099). #447 by reference.\n",
    );
    return EXIT_OK;
  }
  if (parsed.error !== null) {
    process.stderr.write(`docs-impact: ${parsed.error}\n`);
    return EXIT_CONFIG;
  }
  if ((parsed.pr === null) === (parsed.bodyFile === null)) {
    process.stderr.write("Error: must specify --pr OR --body-file.\n");
    return EXIT_CONFIG;
  }
  const repoRoot = resolve(parsed.projectRoot ?? process.cwd());
  const runGh = seams.runGh ?? defaultRunGh;
  const runGit = seams.runGit ?? ((args: readonly string[]) => defaultRunGit(args, repoRoot));

  let body: string | null = null;
  if (parsed.bodyFile !== null) {
    if (!existsSync(parsed.bodyFile)) {
      process.stderr.write(`Error: --body-file not found: ${parsed.bodyFile}\n`);
      return EXIT_CONFIG;
    }
    body = readFileSync(parsed.bodyFile, "utf8");
  } else if (parsed.pr !== null) {
    const repo = parsed.repo ?? process.env.GITHUB_REPOSITORY ?? "";
    if (repo.length === 0) {
      process.stderr.write("Error: --pr requires --repo or GITHUB_REPOSITORY\n");
      return EXIT_CONFIG;
    }
    body = fetchPrBodyRest(parsed.pr, repo, runGh);
    if (body === null) return EXIT_CONFIG;
  }
  if (body === null) return EXIT_CONFIG;

  const mergeBase = runGit(["merge-base", "origin/master", "HEAD"]);
  const baseRef = mergeBase.returncode === 0 ? mergeBase.stdout.trim() : "";
  const range = baseRef.length > 0 ? `${baseRef}...HEAD` : "origin/master...HEAD";
  const nameStatusRaw = runGit(["diff", "--name-status", range]);
  if (nameStatusRaw.returncode !== 0) {
    process.stderr.write(
      `Error: git diff --name-status failed for ${range}: ${nameStatusRaw.stderr.trim() || "no output"}\n`,
    );
    return EXIT_CONFIG;
  }
  const nameStatus = parseNameStatus(nameStatusRaw.stdout);
  const snapshotPaths = collectSnapshotPaths(nameStatus);
  const baseFiles: Record<string, string> = {};
  const headFiles: Record<string, string> = {};
  const showBase = baseRef.length > 0 ? baseRef : "origin/master";
  for (const path of snapshotPaths) {
    baseFiles[path] = gitShowFile(runGit, `${showBase}:${path}`);
    const headPath = resolve(repoRoot, path);
    headFiles[path] = existsSync(headPath) ? readFileSync(headPath, "utf8") : "";
  }
  const changes = detectClosedSurfaceChanges({ nameStatus, baseFiles, headFiles });
  const result = evaluateDocsImpact({ body, changes });
  if (!result.ok) {
    process.stderr.write(`${result.errors.join("\n")}\n`);
    return EXIT_IMPACT;
  }
  process.stdout.write("OK: documentation-impact declaration matches closed-surface changes\n");
  return EXIT_OK;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(docsImpactMain());
}
