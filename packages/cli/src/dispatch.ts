/**
 * Unified `directive <verb> [args]` dispatcher (#1828 s0).
 * Routes to ported command modules in packages/cli and packages/core.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { engineInfo } from "@deftai/directive-core";

export type CommandHandler = (argv: string[]) => number | Promise<number>;

export interface DispatchIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const HANDLER_KEYS = [
  "run",
  "main",
  "mainEntry",
  "launchMain",
  "completeCohortMain",
  "readinessMain",
  "verifyReviewCleanMain",
  "worktreesMain",
] as const;

/** CLI modules in packages/cli/src (excluding parity harnesses and bin/index). */
export const CLI_MODULE_VERBS = [
  "agents-refresh",
  "cache",
  "check",
  "capacity-backfill",
  "capacity-show",
  "codebase-default-extractor",
  "codebase-map",
  "codebase-map-fresh",
  "codebase-projection-registry",
  "codebase-provider",
  "doctor",
  "parity",
  "policy",
  "pr-closing-keywords",
  "pr-merge-readiness",
  "pr-monitor",
  "pr-protected-issues",
  "pr-wait-mergeable",
  "preflight-cache",
  "preflight-gh",
  "probe-session",
  "release",
  "release-e2e",
  "release-publish",
  "release-rollback",
  "scope-lifecycle",
  "slice",
  "subagent-monitor",
  "toolchain-check",
  "triage-actions",
  "triage-bootstrap",
  "triage-bulk",
  "triage-classify",
  "triage-help",
  "triage-queue",
  "triage-reconcile",
  "triage-refresh",
  "triage-scope",
  "triage-scope-drift",
  "triage-smoketest",
  "triage-subscribe",
  "triage-summary",
  "triage-welcome",
  "ts-check-lane",
  "vbrief-activate",
  "vbrief-build",
  "vbrief-preflight",
  "vbrief-reconcile",
  "vbrief-validate",
  "vbrief-validation",
  "verify-branch",
  "verify-encoding",
  "verify-hooks-installed",
  "verify-investigation",
  "verify-judgment-gates",
  "verify-no-task-runtime",
  "validate-links",
  "validate-strategy-output",
  "verify-bridge-drift",
  "verify-capacity",
  "verify-content-manifest",
  "verify-go-freeze",
  "verify-scm-boundary",
  "verify-session-ritual",
  "verify-stubs",
  "rule-ownership-lint",
  "verify-story-ready",
  "verify-tools",
  "verify-wip-cap",
] as const;

/** Core-only CLI entrypoints without a packages/cli wrapper. */
export const CORE_MODULE_VERBS = [
  "scm",
  "github-auth-modes",
  "github-body",
  "issue-emit",
  "issue-ingest",
  "reconcile-issues",
  "swarm-launch",
  "swarm-complete-cohort",
  "swarm-readiness",
  "swarm-routing-verify",
  "swarm-routing-set",
  "swarm-verify-review-clean",
  "swarm-worktrees",
  "framework-commands",
  "pack-render",
  "packs-slice",
  "prd-render",
  "project-render",
  "roadmap-render",
  "spec-render",
  "spec-validate",
  "code-structure-validate",
  "pack-migrate-skills",
  "pack-migrate-rules",
  "pack-migrate-strategies",
  "pack-migrate-patterns",
  "pack-migrate-swarm-spec",
  "policy-set",
  "scope-undo",
  "scope-demote",
  "scope-decompose",
  "changelog-resolve-unreleased",
  "architecture-preflight-sor",
] as const;

/** Task-style aliases (framework_commands / Taskfile names). */
export const VERB_ALIASES: Readonly<Record<string, string>> = {
  "verify:encoding": "verify-encoding",
  "verify:branch": "verify-branch",
  "verify:wip-cap": "verify-wip-cap",
  "verify:hooks-installed": "verify-hooks-installed",
  "verify:no-task-runtime": "verify-no-task-runtime",
  "vbrief:validate": "vbrief-validate",
  "vbrief:preflight": "vbrief-preflight",
  "vbrief:activate": "vbrief-activate",
  "verify:story-ready": "verify-story-ready",
  "verify:tools": "verify-tools",
  "verify:investigation": "verify-investigation",
  "verify:judgment-gates": "verify-judgment-gates",
  "verify:stubs": "verify-stubs",
  "verify:links": "validate-links",
  "validate:links": "validate-links",
  "verify:rule-ownership": "rule-ownership-lint",
  "rule:ownership-lint": "rule-ownership-lint",
  "verify:content-manifest": "verify-content-manifest",
  "verify:go-freeze": "verify-go-freeze",
  "verify:bridge-drift": "verify-bridge-drift",
  "verify:scm-boundary": "verify-scm-boundary",
  "verify:capacity": "verify-capacity",
  "verify:session-ritual": "verify-session-ritual",
  "verify-strategy-output": "validate-strategy-output",
  "validate:strategy-output": "validate-strategy-output",
  "verify:codebase-map-fresh": "codebase-map-fresh",
  "codebase:map": "codebase-map",
  "triage:welcome": "triage-welcome",
  "triage:bootstrap": "triage-bootstrap",
  "triage:summary": "triage-summary",
  "triage:queue": "triage-queue",
  "triage:scope": "triage-scope",
  "triage:accept": "triage-actions",
  "triage:status": "triage-actions",
  "agents:refresh": "agents-refresh",
  "session:start": "framework-commands",
  "toolchain:check": "toolchain-check",
  "ts:check-lane": "ts-check-lane",
  "spec:validate": "spec-validate",
  "spec:render": "spec-render",
  "prd:render": "prd-render",
  "project:render": "project-render",
  doctor: "doctor",
  build: "framework-commands",
};

/** CLI modules living under verify-source-cli/ or content-validate-cli/ subdirs. */
const SUBDIR_CLI_STEMS: Readonly<Record<string, string>> = {
  "verify-stubs": "verify-source-cli/verify-stubs",
  "rule-ownership-lint": "verify-source-cli/rule-ownership-lint",
  "verify-content-manifest": "verify-source-cli/verify-content-manifest",
  "verify-scm-boundary": "verify-source-cli/verify-scm-boundary",
  "verify-go-freeze": "gates-cli/verify-go-freeze",
  "verify-bridge-drift": "gates-cli/verify-bridge-drift",
  "validate-links": "content-validate-cli/validate-links",
  "verify-capacity": "content-validate-cli/verify-capacity",
  "validate-strategy-output": "content-validate-cli/validate-strategy-output",
};

const WRAPPER_CLI_STEMS = new Set<string>([
  "capacity-backfill",
  "capacity-show",
  "codebase-default-extractor",
  "codebase-map",
  "codebase-map-fresh",
  "codebase-projection-registry",
  "codebase-provider",
  "vbrief-activate",
  "vbrief-build",
  "vbrief-reconcile",
  "vbrief-validate",
  "vbrief-validation",
]);

function emitCliResult(result: CliResult, io: DispatchIo): number {
  if (result.stdout) io.writeOut(result.stdout);
  if (result.stderr) io.writeErr(result.stderr);
  return result.exitCode;
}

function resolveHandler(mod: Record<string, unknown>): CommandHandler | null {
  for (const key of HANDLER_KEYS) {
    const fn = mod[key];
    if (typeof fn === "function") {
      return fn as CommandHandler;
    }
  }
  return null;
}

async function loadWrapperCliHandler(stem: string, io: DispatchIo): Promise<CommandHandler> {
  switch (stem) {
    case "capacity-backfill": {
      const { runCapacityBackfillCli } = await import("@deftai/directive-core/capacity");
      return async (argv) => emitCliResult(await runCapacityBackfillCli(argv), io);
    }
    case "capacity-show": {
      const { runCapacityShowCli } = await import("@deftai/directive-core/capacity");
      return (argv) => emitCliResult(runCapacityShowCli(argv), io);
    }
    case "codebase-default-extractor": {
      const { runDefaultExtractorCli } = await import("@deftai/directive-core/codebase");
      return (argv) => emitCliResult(runDefaultExtractorCli(argv), io);
    }
    case "codebase-map": {
      const { runCodebaseMapCli } = await import("@deftai/directive-core/codebase");
      return (argv) => emitCliResult(runCodebaseMapCli(argv), io);
    }
    case "codebase-map-fresh": {
      const { runCodebaseMapFreshCli } = await import("@deftai/directive-core/codebase");
      return (argv) => emitCliResult(runCodebaseMapFreshCli(argv), io);
    }
    case "codebase-projection-registry": {
      const { runProjectionRegistryCli } = await import("@deftai/directive-core/codebase");
      return (argv) => emitCliResult(runProjectionRegistryCli(argv), io);
    }
    case "codebase-provider": {
      const { runProviderCli } = await import("@deftai/directive-core/codebase");
      return (argv) => emitCliResult(runProviderCli(argv), io);
    }
    case "vbrief-activate": {
      const { run } = await import("@deftai/directive-core/vbrief-activate");
      return run;
    }
    case "vbrief-build": {
      const { cmdVbriefBuild } = await import("@deftai/directive-core/vbrief-build");
      return cmdVbriefBuild;
    }
    case "vbrief-reconcile": {
      const { cmdVbriefReconcile } = await import("@deftai/directive-core/vbrief-reconcile");
      return cmdVbriefReconcile;
    }
    case "vbrief-validate": {
      const { cmdVbriefValidate } = await import("@deftai/directive-core/vbrief-validate");
      return cmdVbriefValidate;
    }
    case "vbrief-validation": {
      const { cmdVbriefValidation } = await import("@deftai/directive-core/vbrief-validation");
      return cmdVbriefValidation;
    }
    default:
      throw new Error(`no wrapper handler for ${stem}`);
  }
}

async function loadCliModuleHandler(stem: string, io: DispatchIo): Promise<CommandHandler> {
  if (WRAPPER_CLI_STEMS.has(stem)) {
    return loadWrapperCliHandler(stem, io);
  }
  const subdir = SUBDIR_CLI_STEMS[stem];
  const modulePath = subdir !== undefined ? `./${subdir}.js` : `./${stem}.js`;
  const mod = (await import(modulePath)) as Record<string, unknown>;
  const handler = resolveHandler(mod);
  if (handler === null) {
    throw new Error(`module ${stem} has no command handler export`);
  }
  return handler;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(import.meta.dirname, "..", "..", "..");
}

function parseCodeStructureArgs(argv: readonly string[]): {
  projectRoot: string;
  paths: string[];
  json: boolean;
  strict: boolean;
  error?: string;
} {
  let projectRoot = ".";
  const paths: string[] = [];
  let json = false;
  let strict = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const v = argv[i + 1];
      if (v === undefined)
        return { projectRoot, paths, json, strict, error: "missing --project-root value" };
      projectRoot = v;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--path") {
      const v = argv[i + 1];
      if (v === undefined)
        return { projectRoot, paths, json, strict, error: "missing --path value" };
      paths.push(v);
      i += 1;
    } else if (arg?.startsWith("--path=")) {
      paths.push(arg.slice("--path=".length));
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else {
      return { projectRoot, paths, json, strict, error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot, paths, json, strict };
}

// ===========================================================================
// Native pack-migrate handlers (#2022 Phase 1).
//
// Port of scripts/pack_migrate_{skills,rules,strategies,patterns,swarm_spec}.py
// to native TypeScript so the pack-render surface no longer shells into bundled
// Python. Output parity with the Python scripts is exact, including the
// json.dumps(..., indent=2, ensure_ascii=True) + "\n" serialization, document
// scanning order, and per-entry field ordering.
// ===========================================================================

const PACK_VERSION = "0.1";
const DEFAULT_SKILL_VERSION = "0.1";

const SHOULD_NOT_GLYPH = "\u2249";
const MUST_NOT_GLYPH = "\u2297";

/** Serialize like Python json.dumps(value, indent=2, ensure_ascii=True) + "\n". */
function dumpsAsciiJson(value: unknown): string {
  const base = JSON.stringify(value, null, 2);
  let out = "";
  for (let i = 0; i < base.length; i += 1) {
    const code = base.charCodeAt(i);
    // ensure_ascii escapes every code unit outside the printable ASCII range
    // (0x20-0x7e). JSON.stringify has already escaped control chars (< 0x20)
    // and the structural quote/backslash, so only chars > 0x7e remain literal.
    if (code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += base.charAt(i);
    }
  }
  return `${out}\n`;
}

/** Strip leading/trailing chars in `chars` (Python str.strip(chars)); whitespace when omitted. */
function pyStrip(value: string, chars?: string): string {
  if (chars === undefined) {
    return value.replace(/^\s+/, "").replace(/\s+$/, "");
  }
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value.charAt(start))) start += 1;
  while (end > start && chars.includes(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

// Python str.splitlines() universal newlines: \n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029.
// Built from code points (as \uXXXX escape text) so no literal control characters land in the source.
const LINE_BOUNDARY_CLASS = [0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]
  .map((code) => `\\u${code.toString(16).padStart(4, "0")}`)
  .join("");
const LINE_BOUNDARY_RE = new RegExp(`\\r\\n|[${LINE_BOUNDARY_CLASS}]`);

/** Mirror Python str.splitlines(): split on universal line boundaries, dropping one terminal break. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split(LINE_BOUNDARY_RE);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Repo-relative POSIX path of `to` measured from `from`. */
function relPosix(from: string, to: string): string {
  return relative(from, to).split(/[\\/]/).join("/");
}

/** Python Path.stem -- filename minus its final suffix. */
function stemOf(filePath: string): string {
  const base = basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Slugify a doc stem: lowercase, runs of non-alnum -> '-', trimmed of '-'. */
function slugify(stem: string): string {
  return pyStrip(stem.toLowerCase().replace(/[^a-z0-9]+/g, "-"), "-");
}

function isFileSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Sorted SKILL.md paths one directory below skillsDir (Python skills_dir glob of the SKILL.md docs). */
function globSkillMd(skillsDir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(skillsDir);
  } catch {
    return out;
  }
  for (const name of names) {
    const dir = join(skillsDir, name);
    if (!isDirSafe(dir)) continue;
    const candidate = join(dir, "SKILL.md");
    if (isFileSafe(candidate)) out.push(candidate);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** Sorted full paths of `<dir>/*.md` (Python dir.glob("*.md")). */
function globMd(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const candidate = join(dir, name);
    if (isFileSafe(candidate)) out.push(candidate);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

const H1_RE = /^#\s+(.+?)\s*$/;
const CHROME_PREFIXES = [
  "legend ",
  "legend(",
  "**legend",
  `**${"\u26a0\ufe0f"}`,
  "**see also",
  "<!--",
] as const;

function isChrome(line: string): boolean {
  const low = line.replace(/^\s+/, "").toLowerCase();
  if (CHROME_PREFIXES.some((prefix) => low.startsWith(prefix))) return true;
  const stripped = line.trim();
  return stripped.length > 0 && [...stripped].every((ch) => ch === "-" || ch === "=");
}

/** Index a line array with a defined fallback (`i` is always in range at call sites). */
function lineAt(lines: string[], i: number): string {
  return lines[i] ?? "";
}

function extractTitle(md: string): string {
  for (const line of splitLines(md)) {
    const match = H1_RE.exec(line);
    if (match) return (match[1] ?? "").trim();
  }
  return "";
}

function extractDescription(md: string): string {
  const lines = splitLines(md);
  const n = lines.length;
  let i = 0;
  while (i < n && !H1_RE.test(lineAt(lines, i))) i += 1;
  if (i < n) i += 1;
  while (i < n && (lineAt(lines, i).trim() === "" || isChrome(lineAt(lines, i)))) i += 1;
  const block: string[] = [];
  while (
    i < n &&
    lineAt(lines, i).trim() !== "" &&
    !lineAt(lines, i).replace(/^\s+/, "").startsWith("#")
  ) {
    let stripped = lineAt(lines, i).trim();
    if (stripped.startsWith(">")) stripped = stripped.replace(/^>+/, "").trim();
    if (stripped) block.push(stripped);
    i += 1;
  }
  return block.join(" ");
}

const REDIRECT_MARKERS = [
  "legacy alias",
  "superseded",
  "has been renamed",
  "has moved",
  "deprecated",
];

function isRedirectStub(md: string): boolean {
  const lines = splitLines(md);
  const n = lines.length;
  let i = 0;
  while (i < n && !H1_RE.test(lineAt(lines, i))) i += 1;
  if (i < n) i += 1;
  while (i < n && (lineAt(lines, i).trim() === "" || isChrome(lineAt(lines, i)))) i += 1;
  if (i >= n || !lineAt(lines, i).replace(/^\s+/, "").startsWith(">")) return false;
  const block: string[] = [];
  while (i < n && lineAt(lines, i).replace(/^\s+/, "").startsWith(">")) {
    block.push(lineAt(lines, i).replace(/^\s+/, "").replace(/^>+/, "").trim());
    i += 1;
  }
  const quote = block.join(" ").toLowerCase();
  return REDIRECT_MARKERS.some((marker) => quote.includes(marker));
}

const BANNER_OPEN = "<!-- AUTO-GENERATED by task packs:render";

function stripLeadingBanner(body: string): string {
  const lines = body.split("\n");
  const n = lines.length;
  let i = 0;
  while (i < n && lineAt(lines, i).trim() === "") i += 1;
  if (i < n && lineAt(lines, i).startsWith(BANNER_OPEN)) {
    while (i < n && lineAt(lines, i).replace(/^\s+/, "").startsWith("<!--")) i += 1;
    while (i < n && lineAt(lines, i).trim() === "") i += 1;
  }
  return lines.slice(i).join("\n");
}

const FRONTMATTER_RE = /^---\n([\s\S]*?\n)---\n?([\s\S]*)$/;

function splitFrontmatter(text: string): [string | null, string] {
  if (!text.startsWith("---\n")) return [null, text];
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return [null, text];
  return [match[1] ?? "", match[2] ?? ""];
}

function foldBlock(blockLines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of blockLines) {
    if (line.trim() === "") {
      if (current.length) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line.trim());
    }
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

const KEY_RE = /^([A-Za-z_][\w-]*):(.*)$/;
const BLOCK_INDICATORS = new Set([">", ">-", ">+", "|", "|-", "|+"]);

function isIndented(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("\t");
}

function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  const lines = frontmatter.split("\n");
  const fields: Record<string, string> = {};
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lineAt(lines, i);
    const match = KEY_RE.exec(line);
    if (!match || isIndented(line)) {
      i += 1;
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (BLOCK_INDICATORS.has(value)) {
      const block: string[] = [];
      i += 1;
      while (i < n) {
        const nxt = lineAt(lines, i);
        if (nxt.trim() === "") {
          block.push("");
          i += 1;
          continue;
        }
        if (isIndented(nxt)) {
          block.push(nxt);
          i += 1;
          continue;
        }
        break;
      }
      fields[key] = foldBlock(block);
      continue;
    }
    if (value === "" || value.startsWith("- ")) {
      i += 1;
      while (
        i < n &&
        (lineAt(lines, i).replace(/^\s+/, "").startsWith("- ") || isIndented(lineAt(lines, i)))
      ) {
        i += 1;
      }
      if (!(key in fields)) fields[key] = "";
      continue;
    }
    fields[key] = pyStrip(pyStrip(value, '"'), "'");
    i += 1;
  }
  return fields;
}

function extractExtraFrontmatter(frontmatter: string): string | null {
  const lines = frontmatter.split("\n");
  const extra: string[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lineAt(lines, i);
    const match = KEY_RE.exec(line);
    if (!match || isIndented(line)) {
      i += 1;
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    const block: string[] = [line];
    i += 1;
    if (BLOCK_INDICATORS.has(value)) {
      while (i < n && (lineAt(lines, i).trim() === "" || isIndented(lineAt(lines, i)))) {
        block.push(lineAt(lines, i));
        i += 1;
      }
    } else if (value === "" || value.startsWith("- ")) {
      while (
        i < n &&
        (lineAt(lines, i).replace(/^\s+/, "").startsWith("- ") || isIndented(lineAt(lines, i)))
      ) {
        block.push(lineAt(lines, i));
        i += 1;
      }
    }
    if (key !== "name" && key !== "description") extra.push(...block);
  }
  while (extra.length && (extra[extra.length - 1] ?? "").trim() === "") extra.pop();
  return extra.length ? extra.join("\n") : null;
}

const ROUTING_HEADING = "## Skill Routing";
const ROUTING_PATH_RE = /`(?:content\/)?(skills\/[^`]+\/SKILL\.md)`/;
const ARROW_SPLIT_RE = /\u2192|->/;

function parseRouting(agentsMd: string): Map<string, string[]> {
  const mapping = new Map<string, string[]>();
  const start = agentsMd.indexOf(ROUTING_HEADING);
  if (start === -1) return mapping;
  const rest = agentsMd.slice(start + ROUTING_HEADING.length);
  const end = rest.indexOf("\n## ");
  const section = end !== -1 ? rest.slice(0, end) : rest;
  for (const raw of splitLines(section)) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const pathMatch = ROUTING_PATH_RE.exec(line);
    if (!pathMatch) continue;
    const path = pathMatch[1] ?? "";
    const head = line.split(ARROW_SPLIT_RE)[0] ?? "";
    const keywords = (head.match(/"[^"]+"/g) ?? []).map((quoted) => quoted.slice(1, -1));
    let bucket = mapping.get(path);
    if (!bucket) {
      bucket = [];
      mapping.set(path, bucket);
    }
    for (const keyword of keywords) {
      if (!bucket.includes(keyword)) bucket.push(keyword);
    }
  }
  return mapping;
}

interface SkillEntry {
  id: string;
  description: string;
  triggers: string[];
  path: string;
  version: string;
  body: string | null;
  frontmatter_extra: string | null;
}

function buildSkillEntry(
  skillMd: string,
  skillsDir: string,
  routing: Map<string, string[]>,
  captureBody: boolean,
): SkillEntry | null {
  const text = readFileSync(skillMd, "utf8");
  const [frontmatter, body] = splitFrontmatter(text);
  if (frontmatter === null) return null;
  const fields = parseFrontmatterFields(frontmatter);
  const name = (fields.name ?? "").trim();
  if (!name) return null;
  const relPath = relPosix(dirname(resolve(skillsDir)), resolve(skillMd));
  const triggers = routing.get(relPath) ?? [];
  const version = (fields.version ?? "").trim() || DEFAULT_SKILL_VERSION;
  return {
    id: name,
    description: (fields.description ?? "").trim(),
    triggers,
    path: relPath,
    version,
    body: captureBody ? stripLeadingBanner(body) : null,
    frontmatter_extra: extractExtraFrontmatter(frontmatter),
  };
}

function buildSkillsPack(
  skillsDir: string,
  agentsMd: string,
  proofSkill: string | null,
): { pack: string; version: string; generated_from: string; skills: SkillEntry[] } {
  const routing = parseRouting(readFileSync(agentsMd, "utf8"));
  const captureAll = proofSkill === null;
  const proofPath = proofSkill !== null ? `skills/${proofSkill}/SKILL.md` : null;
  const base = dirname(resolve(skillsDir));
  const skills: SkillEntry[] = [];
  for (const skillMd of globSkillMd(skillsDir)) {
    const relPath = relPosix(base, resolve(skillMd));
    const entry = buildSkillEntry(skillMd, skillsDir, routing, captureAll || relPath === proofPath);
    if (entry !== null) skills.push(entry);
  }
  return {
    pack: "skills-pack-0.1",
    version: PACK_VERSION,
    generated_from: "skills/*/SKILL.md + AGENTS.md (Skill Routing)",
    skills,
  };
}

const GLYPH_TIER: Record<string, string> = {
  "!": "MUST",
  "~": "SHOULD",
  [SHOULD_NOT_GLYPH]: "SHOULD_NOT",
  [MUST_NOT_GLYPH]: "MUST_NOT",
  "?": "MAY",
};

const MARKER_RE = new RegExp(
  `^\\s*(?:-\\s+)?([!~?${SHOULD_NOT_GLYPH}${MUST_NOT_GLYPH}])\\s+(\\S.*)$`,
);

const PROSE_TIERS: ReadonlyArray<readonly [string, string]> = [
  ["MUST NOT", "MUST_NOT"],
  ["SHOULD NOT", "SHOULD_NOT"],
  ["MUST", "MUST"],
  ["SHOULD", "SHOULD"],
  ["MAY", "MAY"],
];

function proseTier(text: string): string | null {
  for (const [keyword, tier] of PROSE_TIERS) {
    const pattern = new RegExp(`\\b${keyword.replace(/ /g, "[ ]")}\\b`);
    if (pattern.test(text)) return tier;
  }
  return null;
}

interface RuleEntry {
  id: string;
  tier: string;
  domain: string;
  text: string;
  path?: string;
  body?: string | null;
}

function parseRules(md: string, domain: string): RuleEntry[] {
  const rules: RuleEntry[] = [];
  let seq = 0;
  for (const raw of splitLines(md)) {
    const line = raw.replace(/\s+$/, "");
    let tier: string | null = null;
    let text = "";
    const marker = MARKER_RE.exec(line);
    if (marker) {
      tier = GLYPH_TIER[marker[1] ?? ""] ?? null;
      text = (marker[2] ?? "").trim();
    } else {
      const stripped = line.trim();
      if (!stripped.startsWith("- ")) continue;
      text = stripped.slice(2).trim();
      tier = text ? proseTier(text) : null;
    }
    if (tier === null || text === "") continue;
    seq += 1;
    rules.push({ id: `${domain}-${String(seq).padStart(3, "0")}`, tier, domain, text });
  }
  return rules;
}

const MANAGED_SECTION_RE =
  /<!--\s*deft:managed-section[\s\S]*?<!--\s*\/deft:managed-section\s*-->/g;

function stripManagedSection(md: string): string {
  return md.replace(MANAGED_SECTION_RE, "");
}

function buildRulesPack(
  codingDir: string,
  extraSources: string[],
): { pack: string; version: string; generated_from: string; rules: RuleEntry[] } {
  const base = dirname(resolve(codingDir));
  const rules: RuleEntry[] = [];
  for (const md of globMd(codingDir)) {
    const relPath = relPosix(base, resolve(md));
    const domain = slugify(stemOf(md));
    const text = readFileSync(md, "utf8");
    const docRules = parseRules(text, domain);
    docRules.forEach((rule, idx) => {
      rule.path = relPath;
      rule.body = idx === 0 ? stripLeadingBanner(text) : null;
      rules.push(rule);
    });
  }
  for (const src of extraSources) {
    if (!isFileSafe(src)) continue;
    const candidate = relPosix(base, resolve(src));
    const relPath = candidate.startsWith("..") || isAbsolute(candidate) ? basename(src) : candidate;
    const domain = slugify(stemOf(src));
    let text = readFileSync(src, "utf8");
    if (basename(src) === "AGENTS.md") text = stripManagedSection(text);
    for (const rule of parseRules(text, domain)) {
      rule.path = relPath;
      rule.body = null;
      rules.push(rule);
    }
  }
  return {
    pack: "rules-pack-0.1",
    version: PACK_VERSION,
    generated_from:
      "coding/*.md + AGENTS.md + main.md (marker-prefixed RFC2119 directives; " +
      "AGENTS.md managed-section excluded; coding bodies rendered, " +
      "AGENTS.md/main.md metadata-only)",
    rules,
  };
}

interface MdEntry {
  id: string;
  title: string;
  description: string;
  triggers: string[];
  path: string;
  body: string | null;
}

function buildMdEntry(md: string, dir: string, captureBody: boolean): MdEntry {
  const relPath = relPosix(dirname(resolve(dir)), resolve(md));
  const stemSlug = slugify(stemOf(md));
  const text = readFileSync(md, "utf8");
  return {
    id: stemSlug,
    title: extractTitle(text),
    description: extractDescription(text),
    triggers: stemSlug ? [stemSlug] : [],
    path: relPath,
    body: captureBody ? stripLeadingBanner(text) : null,
  };
}

function buildStrategiesPack(
  strategiesDir: string,
  proofStrategy: string | null,
): { pack: string; version: string; generated_from: string; strategies: MdEntry[] } {
  const base = dirname(resolve(strategiesDir));
  const captureAll = proofStrategy === null;
  const strategies: MdEntry[] = [];
  for (const md of globMd(strategiesDir)) {
    const relPath = relPosix(base, resolve(md));
    const captureBody = captureAll
      ? !isRedirectStub(readFileSync(md, "utf8"))
      : relPath === proofStrategy;
    strategies.push(buildMdEntry(md, strategiesDir, captureBody));
  }
  return {
    pack: "strategies-pack-0.1",
    version: PACK_VERSION,
    generated_from: "strategies/*.md",
    strategies,
  };
}

function buildPatternsPack(
  patternsDir: string,
  proofPattern: string,
): { pack: string; version: string; generated_from: string; patterns: MdEntry[] } {
  const base = dirname(resolve(patternsDir));
  const patterns: MdEntry[] = [];
  for (const md of globMd(patternsDir)) {
    const relPath = relPosix(base, resolve(md));
    patterns.push(buildMdEntry(md, patternsDir, relPath === proofPattern));
  }
  return {
    pack: "patterns-pack-0.1",
    version: PACK_VERSION,
    generated_from: "patterns/*.md",
    patterns,
  };
}

function buildSwarmSpecPack(
  swarmDir: string,
  proofEntry: string,
): { pack: string; version: string; generated_from: string; entries: MdEntry[] } {
  const base = dirname(resolve(swarmDir));
  const entries: MdEntry[] = [];
  for (const md of globMd(swarmDir)) {
    const relPath = relPosix(base, resolve(md));
    entries.push(buildMdEntry(md, swarmDir, relPath === proofEntry));
  }
  return {
    pack: "swarm-spec-pack-0.1",
    version: PACK_VERSION,
    generated_from: "swarm/*.md",
    entries,
  };
}

function writePack(out: string, pack: unknown): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, dumpsAsciiJson(pack), "utf8");
}

/** Resolve the shippable content root: <root>/content when present, else <root> (#1875). */
function resolveContentRoot(): string {
  const root = resolveDeftRoot();
  const candidate = join(root, "content");
  return isDirSafe(candidate) ? candidate : root;
}

interface ParsedPackArgs {
  values: Record<string, string>;
  lists: Record<string, string[]>;
  error?: string;
}

/**
 * Minimal argparse-compatible option reader supporting `--flag value` and
 * `--flag=value`. `listFlags` accumulate repeats; all flags take a value.
 */
function parsePackArgs(
  argv: readonly string[],
  valueFlags: readonly string[],
  listFlags: readonly string[] = [],
): ParsedPackArgs {
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const known = new Set([...valueFlags, ...listFlags]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    let flag = arg;
    let inlineValue: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      flag = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    if (!known.has(flag)) {
      return { values, lists, error: `unrecognized argument: ${arg}` };
    }
    let value: string | undefined = inlineValue;
    if (value === undefined) {
      i += 1;
      value = argv[i];
    }
    if (value === undefined) {
      return { values, lists, error: `argument ${flag}: expected one argument` };
    }
    if (listFlags.includes(flag)) {
      const bucket = lists[flag] ?? [];
      bucket.push(value);
      lists[flag] = bucket;
    } else {
      values[flag] = value;
    }
  }
  return { values, lists };
}

function runPackMigrateSkills(argv: string[], io: DispatchIo): number {
  const contentRoot = resolveContentRoot();
  const parsed = parsePackArgs(argv, ["--skills-dir", "--agents-md", "--proof-skill", "--out"]);
  if (parsed.error !== undefined) {
    io.writeErr(`error: ${parsed.error}\n`);
    return 2;
  }
  const skillsDir = parsed.values["--skills-dir"] ?? join(contentRoot, "skills");
  const agentsMd = parsed.values["--agents-md"] ?? join(resolveDeftRoot(), "AGENTS.md");
  const proofSkill = parsed.values["--proof-skill"] ?? null;
  const out =
    parsed.values["--out"] ?? join(contentRoot, "packs", "skills", "skills-pack-0.1.json");

  if (!isDirSafe(skillsDir)) {
    io.writeErr(`error: skills directory not found: ${skillsDir}\n`);
    return 1;
  }
  if (!isFileSafe(agentsMd)) {
    io.writeErr(`error: AGENTS.md not found: ${agentsMd}\n`);
    return 1;
  }
  const pack = buildSkillsPack(skillsDir, agentsMd, proofSkill);
  if (pack.skills.length === 0) {
    io.writeErr(`error: no skills with frontmatter discovered under ${skillsDir}\n`);
    return 1;
  }
  writePack(out, pack);
  const bodied = pack.skills.filter((s) => s.body !== null).length;
  io.writeOut(`Migrated ${pack.skills.length} skills (${bodied} with body) -> ${out}\n`);
  return 0;
}

function runPackMigrateRules(argv: string[], io: DispatchIo): number {
  const contentRoot = resolveContentRoot();
  const deftRoot = resolveDeftRoot();
  const parsed = parsePackArgs(argv, ["--coding-dir", "--out"], ["--extra-source"]);
  if (parsed.error !== undefined) {
    io.writeErr(`error: ${parsed.error}\n`);
    return 2;
  }
  const codingDir = parsed.values["--coding-dir"] ?? join(contentRoot, "coding");
  const extraSources = parsed.lists["--extra-source"] ?? [
    join(deftRoot, "AGENTS.md"),
    join(deftRoot, "main.md"),
  ];
  const out = parsed.values["--out"] ?? join(contentRoot, "packs", "rules", "rules-pack-0.1.json");

  if (!isDirSafe(codingDir)) {
    io.writeErr(`error: coding directory not found: ${codingDir}\n`);
    return 1;
  }
  const pack = buildRulesPack(codingDir, extraSources);
  if (pack.rules.length === 0) {
    io.writeErr(`error: no directives discovered under ${codingDir}\n`);
    return 1;
  }
  writePack(out, pack);
  const bodied = pack.rules.filter((r) => r.body != null).length;
  io.writeOut(`Migrated ${pack.rules.length} rules (${bodied} with body) -> ${out}\n`);
  return 0;
}

function runPackMigrateStrategies(argv: string[], io: DispatchIo): number {
  const contentRoot = resolveContentRoot();
  const parsed = parsePackArgs(argv, ["--strategies-dir", "--proof-strategy", "--out"]);
  if (parsed.error !== undefined) {
    io.writeErr(`error: ${parsed.error}\n`);
    return 2;
  }
  const strategiesDir = parsed.values["--strategies-dir"] ?? join(contentRoot, "strategies");
  const proofStrategy = parsed.values["--proof-strategy"] ?? null;
  const out =
    parsed.values["--out"] ?? join(contentRoot, "packs", "strategies", "strategies-pack-0.1.json");

  if (!isDirSafe(strategiesDir)) {
    io.writeErr(`error: strategies directory not found: ${strategiesDir}\n`);
    return 1;
  }
  const pack = buildStrategiesPack(strategiesDir, proofStrategy);
  if (pack.strategies.length === 0) {
    io.writeErr(`error: no strategies discovered under ${strategiesDir}\n`);
    return 1;
  }
  writePack(out, pack);
  const bodied = pack.strategies.filter((s) => s.body !== null).length;
  io.writeOut(`Migrated ${pack.strategies.length} strategies (${bodied} with body) -> ${out}\n`);
  return 0;
}

function runPackMigratePatterns(argv: string[], io: DispatchIo): number {
  const contentRoot = resolveContentRoot();
  const parsed = parsePackArgs(argv, ["--patterns-dir", "--proof-pattern", "--out"]);
  if (parsed.error !== undefined) {
    io.writeErr(`error: ${parsed.error}\n`);
    return 2;
  }
  const patternsDir = parsed.values["--patterns-dir"] ?? join(contentRoot, "patterns");
  const proofPattern = parsed.values["--proof-pattern"] ?? "patterns/multi-agent.md";
  const out =
    parsed.values["--out"] ?? join(contentRoot, "packs", "patterns", "patterns-pack-0.1.json");

  if (!isDirSafe(patternsDir)) {
    io.writeErr(`error: patterns directory not found: ${patternsDir}\n`);
    return 1;
  }
  const pack = buildPatternsPack(patternsDir, proofPattern);
  if (pack.patterns.length === 0) {
    io.writeErr(`error: no patterns discovered under ${patternsDir}\n`);
    return 1;
  }
  writePack(out, pack);
  const bodied = pack.patterns.filter((p) => p.body !== null).length;
  io.writeOut(`Migrated ${pack.patterns.length} patterns (${bodied} with body) -> ${out}\n`);
  return 0;
}

function runPackMigrateSwarmSpec(argv: string[], io: DispatchIo): number {
  const contentRoot = resolveContentRoot();
  const parsed = parsePackArgs(argv, ["--swarm-dir", "--proof-entry", "--out"]);
  if (parsed.error !== undefined) {
    io.writeErr(`error: ${parsed.error}\n`);
    return 2;
  }
  const swarmDir = parsed.values["--swarm-dir"] ?? join(contentRoot, "swarm");
  const proofEntry = parsed.values["--proof-entry"] ?? "swarm/swarm.md";
  const out =
    parsed.values["--out"] ?? join(contentRoot, "packs", "swarm-spec", "swarm-spec-pack-0.1.json");

  if (!isDirSafe(swarmDir)) {
    io.writeErr(`error: swarm directory not found: ${swarmDir}\n`);
    return 1;
  }
  const pack = buildSwarmSpecPack(swarmDir, proofEntry);
  if (pack.entries.length === 0) {
    io.writeErr(`error: no swarm-spec docs discovered under ${swarmDir}\n`);
    return 1;
  }
  writePack(out, pack);
  const bodied = pack.entries.filter((e) => e.body !== null).length;
  io.writeOut(
    `Migrated ${pack.entries.length} swarm-spec entries (${bodied} with body) -> ${out}\n`,
  );
  return 0;
}

function loadPythonScriptHandler(scriptName: string): CommandHandler {
  return (argv) => {
    const deftRoot = resolveDeftRoot();
    try {
      execFileSync(
        "uv",
        ["--project", deftRoot, "run", "python", join(deftRoot, "scripts", scriptName), ...argv],
        {
          cwd: deftRoot,
          encoding: "utf8",
          env: { ...process.env, PYTHONUTF8: "1", DEFT_CACHE_DISABLE: "1" },
          stdio: "inherit",
        },
      );
      return 0;
    } catch (err) {
      const e = err as { status?: number };
      return typeof e.status === "number" ? e.status : 1;
    }
  };
}

async function loadCoreModuleHandler(verb: string, io: DispatchIo): Promise<CommandHandler> {
  switch (verb) {
    case "scm": {
      const { main } = await import("@deftai/directive-core/dist/scm/main.js");
      return (argv) => main(argv);
    }
    case "github-auth-modes": {
      const { mainEntry } = await import(
        "@deftai/directive-core/dist/intake/github-auth-modes-cli.js"
      );
      return mainEntry;
    }
    case "github-body": {
      const { mainEntry } = await import("@deftai/directive-core/dist/intake/github-body-cli.js");
      return mainEntry;
    }
    case "issue-emit": {
      const { mainEntry } = await import("@deftai/directive-core/dist/intake/issue-emit-cli.js");
      return mainEntry;
    }
    case "issue-ingest": {
      const { mainEntry } = await import("@deftai/directive-core/dist/intake/issue-ingest-cli.js");
      return mainEntry;
    }
    case "reconcile-issues": {
      const { mainEntry } = await import(
        "@deftai/directive-core/dist/intake/reconcile-issues-cli.js"
      );
      return mainEntry;
    }
    case "swarm-launch": {
      const { launchMain } = await import("@deftai/directive-core/dist/swarm/launch-cli.js");
      return launchMain;
    }
    case "swarm-complete-cohort": {
      const { completeCohortMain } = await import(
        "@deftai/directive-core/dist/swarm/complete-cohort-cli.js"
      );
      return completeCohortMain;
    }
    case "swarm-readiness": {
      const { readinessMain } = await import("@deftai/directive-core/dist/swarm/readiness-cli.js");
      return readinessMain;
    }
    case "swarm-routing-verify": {
      const { routingVerifyMain } = await import(
        "@deftai/directive-core/dist/swarm/routing-verify-cli.js"
      );
      return routingVerifyMain;
    }
    case "swarm-routing-set": {
      const { routingSetMain } = await import(
        "@deftai/directive-core/dist/swarm/routing-set-cli.js"
      );
      return routingSetMain;
    }
    case "swarm-verify-review-clean": {
      const { verifyReviewCleanMain } = await import(
        "@deftai/directive-core/dist/swarm/verify-review-clean-cli.js"
      );
      return verifyReviewCleanMain;
    }
    case "swarm-worktrees": {
      const { worktreesMain } = await import("@deftai/directive-core/dist/swarm/worktrees-cli.js");
      return worktreesMain;
    }
    case "framework-commands": {
      const { frameworkCommandsMain } = await import("@deftai/directive-core/render");
      return (argv) => frameworkCommandsMain(argv);
    }
    case "pack-render": {
      const { main } = await import("@deftai/directive-core/dist/packs/pack-render.js");
      return (argv) => main([...argv]);
    }
    case "packs-slice": {
      const { main } = await import("@deftai/directive-core/dist/packs/packs-slice.js");
      return (argv) => main([...argv]);
    }
    case "roadmap-render": {
      const { main } = await import("@deftai/directive-core/dist/render/roadmap-render.js");
      return (argv) => main(argv);
    }
    case "spec-validate": {
      const { runSpecValidateCli } = await import("./render-cli/spec-validate-cli.js");
      return (argv) => runSpecValidateCli(argv);
    }
    case "spec-render": {
      const { runSpecRenderCli } = await import("./render-cli/spec-render-cli.js");
      return (argv) => runSpecRenderCli(argv);
    }
    case "prd-render": {
      const { runPrdRenderCli } = await import("./render-cli/prd-render-cli.js");
      return (argv) => runPrdRenderCli(argv);
    }
    case "project-render": {
      const { runProjectRenderCli } = await import("./render-cli/project-render-cli.js");
      return (argv) => runProjectRenderCli(argv);
    }
    case "code-structure-validate": {
      const { evaluateCodeStructure } = await import("@deftai/directive-core/verify-source");
      return (argv) => {
        const parsed = parseCodeStructureArgs(argv);
        if (parsed.error !== undefined) {
          io.writeErr(`code_structure_validate: ${parsed.error}\n`);
          return 2;
        }
        const result = evaluateCodeStructure(parsed.projectRoot, {
          paths: parsed.paths.length > 0 ? parsed.paths : undefined,
          json: parsed.json,
          strict: parsed.strict,
        });
        if (result.stdout) io.writeOut(result.stdout);
        if (result.stderr) io.writeErr(result.stderr);
        return result.code;
      };
    }
    case "pack-migrate-skills":
      return (argv) => runPackMigrateSkills(argv, io);
    case "pack-migrate-rules":
      return (argv) => runPackMigrateRules(argv, io);
    case "pack-migrate-strategies":
      return (argv) => runPackMigrateStrategies(argv, io);
    case "pack-migrate-patterns":
      return (argv) => runPackMigratePatterns(argv, io);
    case "pack-migrate-swarm-spec":
      return (argv) => runPackMigrateSwarmSpec(argv, io);
    case "policy-set":
      return loadPythonScriptHandler("policy_set.py");
    case "scope-undo": {
      const { undoMain } = await import("@deftai/directive-core/dist/scope/main.js");
      return undoMain;
    }
    case "scope-demote": {
      const { demoteMain } = await import("@deftai/directive-core/dist/scope/main.js");
      return demoteMain;
    }
    case "scope-decompose": {
      const { decomposeMain } = await import("@deftai/directive-core/dist/scope/decompose.js");
      return decomposeMain;
    }
    case "changelog-resolve-unreleased": {
      const { changelogResolveUnreleasedMain } = await import(
        "@deftai/directive-core/dist/platform/changelog-cli.js"
      );
      return changelogResolveUnreleasedMain;
    }
    case "architecture-preflight-sor": {
      const { architecturePreflightSorMain } = await import(
        "@deftai/directive-core/dist/architecture/sor-preflight.js"
      );
      return architecturePreflightSorMain;
    }
    default:
      throw new Error(`unknown core verb: ${verb}`);
  }
}

const handlerCache = new Map<string, Promise<CommandHandler>>();

function loadHandler(canonical: string, io: DispatchIo): Promise<CommandHandler> {
  let pending = handlerCache.get(canonical);
  if (pending === undefined) {
    pending = (CLI_MODULE_VERBS as readonly string[]).includes(canonical)
      ? loadCliModuleHandler(canonical, io)
      : loadCoreModuleHandler(canonical, io);
    handlerCache.set(canonical, pending);
  }
  return pending;
}

function defaultIo(): DispatchIo {
  return {
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
  };
}

/** Resolve a user-facing verb to its canonical handler key. */
export function resolveCanonicalVerb(verb: string): string | null {
  if ((CLI_MODULE_VERBS as readonly string[]).includes(verb)) return verb;
  if ((CORE_MODULE_VERBS as readonly string[]).includes(verb)) return verb;
  const alias = VERB_ALIASES[verb];
  if (alias !== undefined) return alias;
  return null;
}

/** Sorted list of all registered verb names (canonical + aliases). */
export function registeredVerbs(): readonly string[] {
  const names = new Set<string>([
    ...CLI_MODULE_VERBS,
    ...CORE_MODULE_VERBS,
    ...Object.keys(VERB_ALIASES),
  ]);
  return [...names].sort();
}

/** Print dispatcher help listing every registered verb. */
export function printHelp(io: DispatchIo = defaultIo()): void {
  io.writeOut("Usage: directive <verb> [args...]\n\nRegistered verbs:\n");
  for (const name of registeredVerbs()) {
    io.writeOut(`  ${name}\n`);
  }
}

async function invokeHandler(handler: CommandHandler, argv: string[]): Promise<number> {
  const code = await handler(argv);
  return typeof code === "number" ? code : 0;
}

const CLI_PACKAGE = "@deftai/directive" as const;

function versionBanner(): string {
  const info = engineInfo();
  return `${CLI_PACKAGE} (engine: ${info.name}@${info.version})\n`;
}

/** Dispatch argv to a registered verb; returns the handler exit code. */
export async function dispatch(argv: string[], io: DispatchIo = defaultIo()): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-V") {
    io.writeOut(versionBanner());
    return 0;
  }

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printHelp(io);
    return 0;
  }

  const [verb, ...rest] = argv;
  const canonical = resolveCanonicalVerb(verb ?? "");
  if (canonical === null) {
    io.writeErr(`directive: unknown verb '${verb}'\n`);
    return 1;
  }

  try {
    const handler = await loadHandler(canonical, io);
    const handlerArgv =
      canonical === "framework-commands" && verb !== undefined && verb !== canonical
        ? [verb, ...rest]
        : rest;
    return await invokeHandler(handler, handlerArgv);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.writeErr(`directive: ${message}\n`);
    return 2;
  }
}

/** Test seam: reset lazy handler cache between cases. */
export function resetHandlerCacheForTests(): void {
  handlerCache.clear();
}
