/**
 * C3 live-procedure target validation (#3602 / #3899) and command-snippet
 * registry lookup (#4094).
 *
 * A shipped live procedure must not name a helper the deposit does not
 * contain. Python helpers are identified via python-free; markdown is
 * walked with the validate-links skip set and extractLinkTargets. History,
 * examples, and prohibitions are skipped by declaration.
 *
 * Metric: unique live-invalid helper targets (not occurrences, not matching
 * lines). Prefer a zero unique-target assertion; do not freeze raw counts.
 *
 * Command snippets reuse this markdown walker (backticks + fences). Registry
 * lookup is static Taskfile parse plus dispatch.ts / CLI help. Verb/namespace
 * only — extracted fences are never executed.
 */

import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTaskfileIncludes,
  taskDefinedInTaskfileYaml,
} from "../check/consumer-gate-integrity.js";
import { NON_PRODUCT_DIRS } from "../fs/non-product-dirs.js";
import { extractLinkTargets, shouldSkipLinkTarget } from "../validate-content/link-parser.js";
import {
  isDeclaredLiveProcedureExclusion,
  isLiveProcedureSectionExcluded,
  parseMarkdownHeading,
} from "./live-procedure-exclusions.js";
import { isPrunedPythonArtifactPath } from "./python-free.js";

const SKIP_DIRS = new Set([...NON_PRODUCT_DIRS, ".planning", "specs"]);

export interface LiveProcedureHit {
  readonly file: string;
  readonly line: number;
  readonly target: string;
}

export interface ExtraMarkdownFile {
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface EvaluateLiveProcedureTargetsOptions {
  readonly stagedRoot: string;
  readonly extraFiles?: readonly ExtraMarkdownFile[];
}

/**
 * Metric used by C3: unique live-invalid helper targets.
 * Not occurrence count, not matching-line count.
 */
export const LIVE_PROCEDURE_METRIC = "unique-targets" as const;

export interface LiveProcedureEvaluation {
  readonly metric: typeof LIVE_PROCEDURE_METRIC;
  readonly hits: readonly LiveProcedureHit[];
  readonly uniqueTargets: readonly string[];
}

function shouldSkipPath(parts: string[]): boolean {
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  return parts.includes("history") && parts.includes("archive");
}

function toPosix(rel: string): string {
  return rel.split(sep).join("/");
}

function collectMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, parts: string[]): void => {
    if (shouldSkipPath(parts)) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const nextParts = [...parts, entry.name];
      if (shouldSkipPath(nextParts)) continue;
      if (entry.isDirectory()) {
        walk(full, nextParts);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  walk(root, []);
  return out.sort();
}

const PATH_CHAR = /[A-Za-z0-9_.-]/;
const PY_HELPER_TOKEN = /^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.py[c]?$/;
const RUN_SHIM_TOKEN = /^(?:\.deft\/core\/run|deft\/run|run)$/;
/** Known pruned deposit helpers named without a directory. Not consumer app.py. */
const PRUNED_BARE_HELPER_BASENAMES = new Set([
  "gh_rest.py",
  "ip_risk.py",
  "preflight_implementation.py",
  "preflight_gh.py",
  "migrate_vbrief.py",
  "slug_normalize.py",
  "slice_record.py",
  "validate_strategy_output.py",
  "_precutover.py",
  "swarm_mint_jwt.py",
]);

function stripRelativePrefix(posix: string): string {
  let out = posix;
  while (out.startsWith("./")) out = out.slice(2);
  while (out.startsWith("../")) out = out.slice(3);
  return out;
}

export function normalizePythonHelperTarget(raw: string): string | null {
  const clean = (raw.split("#")[0] ?? "").split("?")[0] ?? "";
  const posix = clean.replace(/\\/g, "/");
  if (posix.includes("://")) return null;
  const stripped = stripRelativePrefix(posix);
  if (stripped.includes("..")) return null;
  const scriptsIdx = stripped.lastIndexOf("scripts/");
  const token = scriptsIdx >= 0 ? stripped.slice(scriptsIdx) : stripped;
  if (RUN_SHIM_TOKEN.test(token) || RUN_SHIM_TOKEN.test(stripped)) {
    if (stripped === ".deft/core/run" || stripped.endsWith("/.deft/core/run")) {
      return ".deft/core/run";
    }
    if (stripped === "deft/run" || stripped.endsWith("/deft/run")) return "deft/run";
    if (token === "run" || stripped === "run") return "run";
  }
  if (!token.includes("/") && PRUNED_BARE_HELPER_BASENAMES.has(token)) {
    return token;
  }
  if (!PY_HELPER_TOKEN.test(token)) return null;
  return token;
}

function isPathChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return PATH_CHAR.test(ch) || ch === "/" || ch === "\\";
}

function forEachBacktickSpan(line: string, visit: (inner: string) => void): void {
  let tick = 0;
  while (tick < line.length) {
    const open = line.indexOf("`", tick);
    if (open < 0) break;
    const close = line.indexOf("`", open + 1);
    if (close < 0) break;
    visit(line.slice(open + 1, close).trim());
    tick = close + 1;
  }
}

function extractBacktickPythonHelpers(line: string): string[] {
  const out: string[] = [];
  const suffixes = [".pyc", ".py"] as const;
  for (const suffix of suffixes) {
    let from = 0;
    while (from < line.length) {
      const idx = line.indexOf(suffix, from);
      if (idx < 0) break;
      const after = line[idx + suffix.length];
      if (isPathChar(after)) {
        from = idx + suffix.length;
        continue;
      }
      let start = idx;
      while (start > 0 && isPathChar(line[start - 1])) start -= 1;
      const token = line.slice(start, idx + suffix.length);
      from = idx + suffix.length;
      const normalized = normalizePythonHelperTarget(token);
      if (normalized) out.push(normalized);
    }
  }
  for (const spelling of [".deft/core/run", "deft/run"] as const) {
    if (line.includes(spelling)) {
      const normalized = normalizePythonHelperTarget(spelling);
      if (normalized) out.push(normalized);
    }
  }
  forEachBacktickSpan(line, (inner) => {
    const parts = inner.split(/\s+/).filter((p) => p.length > 0);
    const first = (parts[0] ?? "").replace(/^\.\//, "");
    const arg = parts[1];
    const launcherArgs = new Set([
      "bootstrap",
      "spec",
      "init",
      "project",
      "upgrade",
      "doctor",
      "validate",
      "reset",
    ]);
    if (first === "run" && (arg === undefined || launcherArgs.has(arg))) {
      const normalized = normalizePythonHelperTarget("run");
      if (normalized) out.push(normalized);
    }
  });
  return out;
}

function extractLineTargets(line: string): string[] {
  const found = new Set<string>();
  for (const raw of extractLinkTargets(line)) {
    if (
      raw.startsWith("http://") ||
      raw.startsWith("https://") ||
      raw.startsWith("mailto:") ||
      raw.startsWith("#")
    ) {
      continue;
    }
    if (shouldSkipLinkTarget(raw)) continue;
    const normalized = normalizePythonHelperTarget(raw);
    if (normalized) found.add(normalized);
  }
  for (const token of extractBacktickPythonHelpers(line)) found.add(token);
  return [...found];
}

function scanMarkdownFile(absolutePath: string, relativePath: string): LiveProcedureHit[] {
  if (isDeclaredLiveProcedureExclusion(relativePath)) return [];
  let text: string;
  try {
    text = readFileSync(absolutePath, "utf8");
  } catch {
    return [];
  }
  const hits: LiveProcedureHit[] = [];
  const lines = text.split("\n");
  let skipUntilLevel: number | null = null;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      if (skipUntilLevel !== null) continue;
    } else if (!inFence) {
      const heading = parseMarkdownHeading(line);
      if (heading) {
        if (skipUntilLevel !== null && heading.level <= skipUntilLevel) {
          skipUntilLevel = null;
        }
        if (
          skipUntilLevel === null &&
          isLiveProcedureSectionExcluded(relativePath, heading.title)
        ) {
          skipUntilLevel = heading.level;
          continue;
        }
      }
    }
    if (skipUntilLevel !== null) continue;
    for (const target of extractLineTargets(line)) {
      if (!isPrunedPythonArtifactPath(target)) continue;
      hits.push({ file: relativePath, line: i + 1, target });
    }
  }
  return hits;
}

export function evaluateLiveProcedureTargets(
  options: EvaluateLiveProcedureTargetsOptions,
): LiveProcedureEvaluation {
  const stagedRoot = resolve(options.stagedRoot);
  const hits: LiveProcedureHit[] = [];
  if (existsSync(stagedRoot)) {
    for (const md of collectMarkdownFiles(stagedRoot)) {
      const rel = toPosix(relative(stagedRoot, md));
      hits.push(...scanMarkdownFile(md, rel));
    }
  }
  for (const extra of options.extraFiles ?? []) {
    const rel = extra.relativePath.replace(/\\/g, "/");
    hits.push(...scanMarkdownFile(extra.absolutePath, rel));
  }
  const unique = [...new Set(hits.map((h) => h.target))].sort();
  return { metric: LIVE_PROCEDURE_METRIC, hits, uniqueTargets: unique };
}

export function extraDepositMarkdownFiles(root: string): ExtraMarkdownFile[] {
  const extras: ExtraMarkdownFile[] = [];
  for (const name of ["main.md", "SKILL.md"] as const) {
    const absolutePath = join(root, name);
    if (existsSync(absolutePath)) {
      extras.push({ relativePath: name, absolutePath });
    }
  }
  return extras;
}

export class LiveProcedureTargetsError extends Error {
  readonly evaluation: LiveProcedureEvaluation;

  constructor(evaluation: LiveProcedureEvaluation) {
    super(formatLiveProcedureFailure(evaluation));
    this.name = "LiveProcedureTargetsError";
    this.evaluation = evaluation;
  }
}

/** Fail closed when a deposit's live procedures name pruned Python helpers (#3602 C3). */
export function assertLiveProcedureDepositClean(depositDir: string): void {
  const result = evaluateLiveProcedureTargets({
    stagedRoot: depositDir,
    extraFiles: extraDepositMarkdownFiles(depositDir),
  });
  if (result.uniqueTargets.length > 0) {
    throw new LiveProcedureTargetsError(result);
  }
}

export function formatLiveProcedureFailure(result: LiveProcedureEvaluation): string {
  const lines = [
    `C3 live-procedure target validation failed: ${result.uniqueTargets.length} unique live-invalid helper target(s) (metric=${result.metric}).`,
  ];
  for (const hit of result.hits.slice(0, 40)) {
    lines.push(`  ${hit.file}:${hit.line} -> ${hit.target}`);
  }
  if (result.hits.length > 40) {
    lines.push(`  ... ${result.hits.length - 40} more occurrence(s)`);
  }
  return lines.join("\n");
}

/** Closed classification set for command snippets (#4094). */
export const COMMAND_SNIPPET_CLASSIFICATIONS = [
  "current",
  "historical",
  "frozen",
  "template",
  "illustrative",
] as const;

export type CommandSnippetClassification = (typeof COMMAND_SNIPPET_CLASSIFICATIONS)[number];

/** Audience/context key: which registry a snippet is judged against (#4094). */
export const COMMAND_SNIPPET_AUDIENCES = ["consumer", "maintainer", "frozen"] as const;

export type CommandSnippetAudience = (typeof COMMAND_SNIPPET_AUDIENCES)[number];

export type CommandSnippetFamily = "task" | "cli";

export type CommandSnippetSpan = "backtick" | "fence";

export type CommandSnippetRegistryKind =
  | "taskfile-public"
  | "taskfile-internal"
  | "cli-preferred"
  | "cli-registered"
  | "cli-deferred"
  | "cli-stubbed"
  | "cli-help"
  | "skipped"
  | "absent";

export interface CommandSnippetCorpusEntry {
  readonly path: string;
  readonly audience: CommandSnippetAudience;
  readonly defaultClassification: CommandSnippetClassification;
  readonly failClosed: boolean;
  readonly historicalHeadingPrefixes?: readonly string[];
}

/**
 * Enumerated corpus (#4094). failClosed is this story's commands.md surface.
 * Sibling owners (README, QUICK-START, getting-started, doctor) are named
 * and not fail-closed here. Historical trees are default-historical by path.
 */
export const COMMAND_SNIPPET_CORPUS: readonly CommandSnippetCorpusEntry[] = [
  {
    path: "content/commands.md",
    audience: "maintainer",
    defaultClassification: "current",
    failClosed: true,
    historicalHeadingPrefixes: ["## Command Lifecycle:", "## Historical "],
  },
  {
    path: "README.md",
    audience: "consumer",
    defaultClassification: "current",
    failClosed: false,
  },
  {
    path: "content/QUICK-START.md",
    audience: "consumer",
    defaultClassification: "current",
    failClosed: false,
  },
  {
    path: "content/docs/getting-started.md",
    audience: "consumer",
    defaultClassification: "current",
    failClosed: false,
  },
  {
    path: "CHANGELOG.md",
    audience: "frozen",
    defaultClassification: "historical",
    failClosed: false,
  },
  {
    path: "SPECIFICATION.md",
    audience: "frozen",
    defaultClassification: "historical",
    failClosed: false,
  },
];

/** Path prefixes that are historical without per-snippet annotation. */
export const COMMAND_SNIPPET_HISTORICAL_PREFIXES = [
  "history/",
  "docs/analysis/",
  "xbrief/completed/",
] as const;

/** Retired verbs kept as regression fixtures; they must not resolve public. */
export const COMMAND_SNIPPET_KNOWN_FALSE_TASK_VERBS = [
  "check:slow",
  "verify:xbrief-conformance",
  "ci:local",
  "validate-links",
] as const;

/** Live verbs that current guidance may name only as frozen, never as public-current. */
export const COMMAND_SNIPPET_FROZEN_TASK_VERBS = new Set(["migrate:vbrief"]);

export interface CommandSnippetExemption {
  readonly family: CommandSnippetFamily;
  readonly verb: string;
  readonly path: string;
  readonly classification: Exclude<CommandSnippetClassification, "current">;
  readonly reason: string;
}

/**
 * Closed exemption allowlist. Empty at first ship. An addition in the same
 * diff as the snippet it exempts fails (#4094).
 */
export const COMMAND_SNIPPET_EXEMPTIONS: readonly CommandSnippetExemption[] = [];

export interface CommandSnippet {
  readonly file: string;
  readonly line: number;
  readonly family: CommandSnippetFamily;
  readonly verb: string;
  readonly raw: string;
  readonly span: CommandSnippetSpan;
  readonly classification: CommandSnippetClassification;
  readonly audience: CommandSnippetAudience;
}

export interface CommandSnippetResolution {
  readonly kind: CommandSnippetRegistryKind;
  readonly publicCurrent: boolean;
}

export interface CommandSnippetFinding {
  readonly snippet: CommandSnippet;
  readonly resolution: CommandSnippetResolution;
}

export interface CommandSnippetEvaluation {
  readonly snippets: readonly CommandSnippet[];
  readonly findings: readonly CommandSnippetFinding[];
}

export interface CommandRegistries {
  readonly publicTasks: ReadonlySet<string>;
  readonly internalTasks: ReadonlySet<string>;
  readonly includeNamespaces: ReadonlySet<string>;
  readonly preferredCli: ReadonlySet<string>;
  readonly registeredCli: ReadonlySet<string>;
  readonly helpCli: ReadonlySet<string>;
  readonly deferredCli: ReadonlySet<string>;
  readonly stubbedCli: ReadonlySet<string>;
}

const TASK_RUNNER_FLAGS_WITH_ARG = new Set([
  "-t",
  "--taskfile",
  "-d",
  "--dir",
  "-o",
  "--output",
  "--concurrency",
]);

const CONSUMER_INCLUDE_PREFIX = "deft:";

export function frameworkRepoRoot(): string {
  return resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
}

function normalizeYaml(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function taskBlockIsInternal(text: string, localName: string): boolean {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^ {2}${escaped}\\s*:`, "m");
  const match = header.exec(text);
  if (match === null || match.index === undefined) return false;
  const after = text.slice(match.index + match[0].length);
  const next = after.search(/^ {2}[A-Za-z_][\w:-]*\s*:/m);
  const body = next < 0 ? after : after.slice(0, next);
  return /^\s+internal:\s*true\s*$/m.test(body);
}

function collectTaskKeys(text: string): string[] {
  const keys: string[] = [];
  const lines = normalizeYaml(text).split("\n");
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

function quotedStrings(block: string): string[] {
  return [...block.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined);
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

function parseStringArrayExport(source: string, name: string): string[] {
  return quotedStrings(sliceAssignment(source, name));
}

function parseRecordKeys(source: string, name: string): string[] {
  return [...sliceAssignment(source, name).matchAll(/"([^"]+)"\s*:/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined);
}

export function loadCommandRegistries(repoRoot: string): CommandRegistries {
  const rootText = normalizeYaml(readFileSync(join(repoRoot, "Taskfile.yml"), "utf8"));
  const publicTasks = new Set<string>();
  const internalTasks = new Set<string>();
  for (const key of collectTaskKeys(rootText)) {
    if (!taskDefinedInTaskfileYaml(rootText, key)) continue;
    if (taskBlockIsInternal(rootText, key)) internalTasks.add(key);
    else publicTasks.add(key);
  }
  const includes = parseTaskfileIncludes(rootText);
  const includeNamespaces = new Set(includes.keys());
  for (const [namespace, include] of includes) {
    const includePath = resolve(repoRoot, include.taskfile);
    if (!existsSync(includePath)) continue;
    const fragment = normalizeYaml(readFileSync(includePath, "utf8"));
    for (const local of collectTaskKeys(fragment)) {
      if (!taskDefinedInTaskfileYaml(fragment, local)) continue;
      const full = `${namespace}:${local}`;
      if (taskBlockIsInternal(fragment, local)) internalTasks.add(full);
      else publicTasks.add(full);
    }
  }

  const dispatch = readFileSync(join(repoRoot, "packages/cli/src/dispatch.ts"), "utf8");
  const router = readFileSync(join(repoRoot, "packages/cli/src/cli-router/route-argv.ts"), "utf8");
  const moduleVerbs = parseStringArrayExport(dispatch, "CLI_MODULE_VERBS");
  const coreVerbs = parseStringArrayExport(dispatch, "CORE_MODULE_VERBS");
  const aliasKeys = parseRecordKeys(dispatch, "VERB_ALIASES");
  const aliasValues = [...sliceAssignment(dispatch, "VERB_ALIASES").matchAll(/:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  const colonAliasKeys = [
    ...parseRecordKeys(dispatch, "TRIAGE_ACTION_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "POLICY_ACTION_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "AUTHZ_ACTION_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "ESCALATION_ACTION_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "PLAN_SEQUENCE_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "PRODUCT_SIGNAL_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "FRESHNESS_ALIAS_SUBCOMMANDS"),
  ];
  const helpCli = new Set(
    [...sliceAssignment(dispatch, "CURATED_HELP_GROUPS").matchAll(/name:\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((s): s is string => s !== undefined),
  );
  const topLevel = parseStringArrayExport(router, "TOP_LEVEL_UX_VERBS");
  const deferredCli = new Set(quotedStrings(sliceAssignment(router, "DEFERRED_TOP_LEVEL_VERBS")));
  const stubbedCli = new Set(quotedStrings(sliceAssignment(router, "STUBBED_TOP_LEVEL_VERBS")));
  const scopeLocals = quotedStrings(sliceAssignment(router, "SCOPE_LIFECYCLE_VERBS"));
  const aliasedCanonicals = new Set(aliasValues.filter((s): s is string => s !== undefined));
  const registeredCli = new Set<string>([
    ...moduleVerbs,
    ...coreVerbs,
    ...aliasKeys,
    ...colonAliasKeys,
    ...topLevel,
    ...scopeLocals.map((local) => `scope:${local}`),
    ...helpCli,
  ]);
  const preferredCli = new Set<string>([
    ...topLevel.filter((verb) => !deferredCli.has(verb) && !stubbedCli.has(verb)),
    ...aliasKeys,
    ...colonAliasKeys,
    ...[...moduleVerbs, ...coreVerbs].filter((verb) => !aliasedCanonicals.has(verb)),
    ...scopeLocals.map((local) => `scope:${local}`),
    ...[...helpCli].filter((name) => registeredCli.has(name) && !deferredCli.has(name)),
  ]);

  return {
    publicTasks,
    internalTasks,
    includeNamespaces,
    preferredCli,
    registeredCli,
    helpCli,
    deferredCli,
    stubbedCli,
  };
}

function skipRunnerPrefix(parts: readonly string[]): string[] {
  let i = 0;
  while (i < parts.length) {
    const token = parts[i];
    if (token === undefined) break;
    if (/^[A-Za-z_][\w]*=/.test(token) && !token.includes(":")) {
      i += 1;
      continue;
    }
    break;
  }
  const launcher = parts[i];
  if (launcher !== "task" && launcher !== "deft" && launcher !== "directive") {
    return parts.slice(i);
  }
  i += 1;
  while (i < parts.length) {
    const token = parts[i];
    if (token === undefined) break;
    if (token === "--") {
      i += 1;
      break;
    }
    if (token.startsWith("-")) {
      i += TASK_RUNNER_FLAGS_WITH_ARG.has(token) ? 2 : 1;
      continue;
    }
    break;
  }
  return [launcher, ...parts.slice(i)];
}

function shouldSkipVerb(verb: string): boolean {
  if (verb.length === 0) return true;
  if (verb.startsWith("-")) return true;
  if (
    verb.endsWith(":") ||
    verb.includes("*") ||
    verb.includes("|") ||
    verb.includes("<") ||
    verb.includes(">")
  ) {
    return true;
  }
  return false;
}

function classifyByHeadings(
  line: string,
  defaultClassification: CommandSnippetClassification,
  historicalPrefixes: readonly string[],
  state: { historical: boolean },
): CommandSnippetClassification {
  const trimmed = line.trim();
  if (trimmed.startsWith("## ")) {
    state.historical = historicalPrefixes.some((prefix) => trimmed.startsWith(prefix));
  }
  if (state.historical) return "historical";
  return defaultClassification;
}

function exemptionFor(
  file: string,
  family: CommandSnippetFamily,
  verb: string,
  exemptions: readonly CommandSnippetExemption[],
): CommandSnippetExemption | undefined {
  return exemptions.find(
    (entry) => entry.path === file && entry.family === family && entry.verb === verb,
  );
}

interface ExtractedCommand {
  readonly family: CommandSnippetFamily;
  readonly verb: string;
  readonly raw: string;
}

function commandsFromTokens(parts: readonly string[]): ExtractedCommand[] {
  const found: ExtractedCommand[] = [];
  const rest = skipRunnerPrefix(parts);
  const launcher = rest[0];
  if (launcher !== "task" && launcher !== "deft" && launcher !== "directive") return found;
  const verbToken = rest[1];
  if (verbToken === undefined) return found;
  let verb = verbToken;
  if (launcher === "task" && verb.startsWith(CONSUMER_INCLUDE_PREFIX)) {
    verb = verb.slice(CONSUMER_INCLUDE_PREFIX.length);
  }
  if (shouldSkipVerb(verb)) return found;
  if (launcher === "task") {
    found.push({ family: "task", verb, raw: `task ${verbToken}` });
  } else {
    found.push({ family: "cli", verb, raw: `${launcher} ${verbToken}` });
  }
  return found;
}

/**
 * Extract `task` / `deft` / `directive` verbs from backtick spans and fenced
 * lines. Same walker as C3 backticks; fences are parsed, never executed.
 */
export function extractCommandSnippets(
  text: string,
  file: string,
  entry: Pick<
    CommandSnippetCorpusEntry,
    "audience" | "defaultClassification" | "historicalHeadingPrefixes"
  >,
  exemptions: readonly CommandSnippetExemption[] = COMMAND_SNIPPET_EXEMPTIONS,
): CommandSnippet[] {
  const snippets: CommandSnippet[] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const headingState = { historical: false };
  const historicalPrefixes = entry.historicalHeadingPrefixes ?? [];
  let inFence = false;

  const push = (
    extracted: ExtractedCommand,
    line: number,
    span: CommandSnippetSpan,
    classification: CommandSnippetClassification,
  ): void => {
    let nextClassification = classification;
    if (COMMAND_SNIPPET_FROZEN_TASK_VERBS.has(extracted.verb) && extracted.family === "task") {
      nextClassification = "frozen";
    }
    const exempt = exemptionFor(file, extracted.family, extracted.verb, exemptions);
    if (exempt) nextClassification = exempt.classification;
    snippets.push({
      file,
      line,
      family: extracted.family,
      verb: extracted.verb,
      raw: extracted.raw,
      span,
      classification: nextClassification,
      audience: entry.audience,
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const classification = classifyByHeadings(
      line,
      entry.defaultClassification,
      historicalPrefixes,
      headingState,
    );
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const parts = trimmed
        .replace(/^[$]\s+/, "")
        .split(/\s+/)
        .filter((p) => p.length > 0);
      for (const extracted of commandsFromTokens(parts)) {
        push(extracted, i + 1, "fence", classification);
      }
      continue;
    }
    forEachBacktickSpan(line, (inner) => {
      const parts = inner.split(/\s+/).filter((p) => p.length > 0);
      for (const extracted of commandsFromTokens(parts)) {
        push(extracted, i + 1, "backtick", classification);
      }
    });
  }
  return snippets;
}

export function resolveCommandSnippet(
  snippet: CommandSnippet,
  registries: CommandRegistries,
): CommandSnippetResolution {
  if (snippet.family === "task") {
    if (
      !snippet.verb.includes(":") &&
      registries.includeNamespaces.has(snippet.verb) &&
      !registries.publicTasks.has(snippet.verb) &&
      !registries.internalTasks.has(snippet.verb)
    ) {
      return { kind: "skipped", publicCurrent: false };
    }
    if (registries.internalTasks.has(snippet.verb)) {
      return { kind: "taskfile-internal", publicCurrent: false };
    }
    if (registries.publicTasks.has(snippet.verb)) {
      return { kind: "taskfile-public", publicCurrent: true };
    }
    return { kind: "absent", publicCurrent: false };
  }
  const hyphen = snippet.verb.replace(/:/g, "-");
  const cliNames = snippet.verb.includes(":") ? [snippet.verb, hyphen] : [snippet.verb];
  if (cliNames.some((name) => registries.deferredCli.has(name))) {
    return { kind: "cli-deferred", publicCurrent: false };
  }
  if (cliNames.some((name) => registries.stubbedCli.has(name))) {
    return { kind: "cli-stubbed", publicCurrent: false };
  }
  if (cliNames.some((name) => registries.preferredCli.has(name))) {
    return { kind: "cli-preferred", publicCurrent: true };
  }
  if (cliNames.some((name) => registries.helpCli.has(name))) {
    return {
      kind: "cli-help",
      publicCurrent: cliNames.some((name) => registries.registeredCli.has(name)),
    };
  }
  if (cliNames.some((name) => registries.registeredCli.has(name))) {
    return { kind: "cli-registered", publicCurrent: false };
  }
  return { kind: "absent", publicCurrent: false };
}

export function evaluateMarkdownCommandSnippets(options: {
  readonly text: string;
  readonly file: string;
  readonly entry: CommandSnippetCorpusEntry;
  readonly registries: CommandRegistries;
  readonly exemptions?: readonly CommandSnippetExemption[];
}): CommandSnippetEvaluation {
  const snippets = extractCommandSnippets(
    options.text,
    options.file,
    options.entry,
    options.exemptions ?? COMMAND_SNIPPET_EXEMPTIONS,
  );
  const findings: CommandSnippetFinding[] = [];
  for (const snippet of snippets) {
    const resolution = resolveCommandSnippet(snippet, options.registries);
    if (
      options.entry.failClosed &&
      snippet.classification === "current" &&
      snippet.audience !== "frozen" &&
      !resolution.publicCurrent &&
      resolution.kind !== "skipped"
    ) {
      findings.push({ snippet, resolution });
    }
  }
  return { snippets, findings };
}

const COMMAND_SNIPPET_DIFF_PATHS = [
  "packages/core/src/deposit/live-procedure-targets.ts",
  "content/commands.md",
] as const;

function gitOut(repoRoot: string, args: readonly string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  } catch {
    return "";
  }
}

function gitOutOrNull(repoRoot: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  } catch {
    return null;
  }
}

function gitOk(repoRoot: string, args: readonly string[]): boolean {
  try {
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function commitExists(repoRoot: string, spec: string): boolean {
  return gitOk(repoRoot, ["cat-file", "-e", `${spec}^{commit}`]);
}

function maybeFetchBase(repoRoot: string, spec: string): void {
  if (commitExists(repoRoot, spec)) return;
  const ci =
    process.env.GITHUB_ACTIONS === "true" ||
    Boolean(process.env.GITHUB_BASE_SHA?.trim()) ||
    process.env.GITHUB_EVENT_NAME?.trim() === "push";
  if (!ci) return;
  const token = spec.replace(/^origin\//, "");
  if (token.length === 0) return;
  gitOut(repoRoot, ["fetch", "--depth", "1", "origin", token]);
}

function pushBeforeSha(): string {
  const path = process.env.GITHUB_EVENT_PATH?.trim();
  if (!path || !existsSync(path)) return "";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { before?: unknown };
    const before = typeof parsed.before === "string" ? parsed.before.trim() : "";
    if (/^[0-9a-f]{40}$/i.test(before) && before !== "0".repeat(40)) return before;
  } catch {
    return "";
  }
  return "";
}

function headSha(repoRoot: string): string {
  return gitOut(repoRoot, ["rev-parse", "HEAD"]).trim();
}

function diffAgainstBase(repoRoot: string, base: string, files: readonly string[]): string | null {
  maybeFetchBase(repoRoot, base);
  const head = headSha(repoRoot);
  const mergeBase = gitOut(repoRoot, ["merge-base", "HEAD", base]).trim();
  if (mergeBase.length > 0) {
    // Depth-one clones point origin/<default> at HEAD, so merge-base==HEAD is
    // not a PR base and would hide earlier commits as an empty range.
    if (isShallowRepo(repoRoot) && mergeBase === head) return null;
    return gitOutOrNull(repoRoot, ["diff", `${mergeBase}...HEAD`, "--", ...files]);
  }
  if (commitExists(repoRoot, base)) {
    const baseSha = gitOut(repoRoot, ["rev-parse", `${base}^{commit}`]).trim();
    if (isShallowRepo(repoRoot) && baseSha === head) return null;
    return gitOutOrNull(repoRoot, ["diff", base, "HEAD", "--", ...files]);
  }
  return null;
}

function isShallowRepo(repoRoot: string): boolean {
  return gitOut(repoRoot, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
}

/** Sentinel: depth-one checkout could not obtain a usable base-range diff. */
export const UNRESOLVED_SHALLOW_CANDIDATE_DIFF = "UNRESOLVED_SHALLOW_CANDIDATE_DIFF";

/** Candidate diff for same-diff exemption ownership. */
export function readCommandSnippetCandidateDiff(repoRoot: string): string {
  const files = [...COMMAND_SNIPPET_DIFF_PATHS];
  const working = [
    gitOut(repoRoot, ["diff", "HEAD", "--", ...files]),
    gitOut(repoRoot, ["diff", "--cached", "--", ...files]),
  ].join("\n");
  if (working.includes("diff --git")) return working;
  const bases = [
    process.env.GITHUB_BASE_SHA?.trim() ?? "",
    pushBeforeSha(),
    process.env.GITHUB_BASE_REF?.trim() ? `origin/${process.env.GITHUB_BASE_REF.trim()}` : "",
    "origin/master",
    "origin/main",
  ].filter((base) => base.length > 0);
  for (const base of bases) {
    const ranged = diffAgainstBase(repoRoot, base, files);
    // null is a failed or disconnected range — try the next base.
    // "" is a successful empty range (this PR does not touch command-snippet
    // paths). That is resolved, not UNRESOLVED_SHALLOW.
    if (ranged === null) continue;
    return ranged;
  }
  // Depth-one PR checkouts only have HEAD. A `git log -p` fallback would hide
  // exemption + snippet additions from earlier PR commits (fail-open).
  // Push-to-master CI also has origin/<default>==HEAD and no PR base metadata;
  // failing closed there would red the live command-snippet tests on every push.
  if (isShallowRepo(repoRoot)) {
    if (process.env.GITHUB_EVENT_NAME?.trim() === "push") {
      return gitOut(repoRoot, ["log", "-p", "-n", "50", "--", ...files]);
    }
    return `${UNRESOLVED_SHALLOW_CANDIDATE_DIFF}\n`;
  }
  return gitOut(repoRoot, ["log", "-p", "-n", "50", "--", ...files]);
}

export function evaluateCommandSnippets(options: {
  readonly repoRoot: string;
  readonly corpus?: readonly CommandSnippetCorpusEntry[];
  readonly exemptions?: readonly CommandSnippetExemption[];
  readonly diffText?: string;
}): CommandSnippetEvaluation {
  const registries = loadCommandRegistries(options.repoRoot);
  const snippets: CommandSnippet[] = [];
  const findings: CommandSnippetFinding[] = [];
  for (const entry of options.corpus ?? COMMAND_SNIPPET_CORPUS) {
    const abs = join(options.repoRoot, entry.path);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    const result = evaluateMarkdownCommandSnippets({
      text,
      file: entry.path,
      entry,
      registries,
      exemptions: options.exemptions,
    });
    snippets.push(...result.snippets);
    findings.push(...result.findings);
  }
  const diffText =
    options.diffText !== undefined
      ? options.diffText
      : readCommandSnippetCandidateDiff(options.repoRoot);
  if (diffText.trim() === UNRESOLVED_SHALLOW_CANDIDATE_DIFF) {
    findings.push({
      snippet: {
        file: "packages/core/src/deposit/live-procedure-targets.ts",
        line: 0,
        family: "task",
        verb: "candidate-diff",
        raw: "unresolved-shallow candidate-diff: depth-one checkout has no usable base range",
        span: "backtick",
        classification: "current",
        audience: "maintainer",
      },
      resolution: { kind: "absent", publicCurrent: false },
    });
  } else if (diffText.length > 0) {
    for (const violation of sameDiffExemptionViolations(diffText)) {
      findings.push({
        snippet: {
          file: violation.path,
          line: 0,
          family: violation.family,
          verb: violation.verb,
          raw: `same-diff exemption ${violation.family} ${violation.verb}`,
          span: "backtick",
          classification: "current",
          audience: "maintainer",
        },
        resolution: { kind: "absent", publicCurrent: false },
      });
    }
  }
  return { snippets, findings };
}

export interface SameDiffExemptionViolation {
  readonly verb: string;
  readonly path: string;
  readonly family: CommandSnippetFamily;
}

function splitUnifiedDiff(diffText: string): Map<string, string> {
  const files = new Map<string, string>();
  const parts = diffText.split(/^diff --git /m);
  for (const part of parts) {
    const header = /^(?:a\/)?(\S+)\s+b\/(\S+)/.exec(part);
    const path = header?.[2]?.replace(/^b\//, "");
    if (!path) continue;
    const existing = files.get(path);
    files.set(path, existing === undefined ? part : `${existing}\n${part}`);
  }
  return files;
}

function addedLines(fileDiff: string): string[] {
  return fileDiff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

const GIT_LOG_COMMIT_RE = /^commit [0-9a-f]{7,40}\b/;

/** Split `git log -p` into per-commit patches. Range/working diffs stay one chunk. */
function candidateDiffChunks(diffText: string): string[] {
  const lines = diffText.split("\n");
  const hasCommit = lines.some((line) => GIT_LOG_COMMIT_RE.test(line));
  if (!hasCommit) return [diffText];
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (GIT_LOG_COMMIT_RE.test(line) && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

function sameDiffExemptionViolationsOne(diffText: string): readonly SameDiffExemptionViolation[] {
  const files = splitUnifiedDiff(diffText);
  const resolverDiff = files.get("packages/core/src/deposit/live-procedure-targets.ts") ?? "";
  const added = addedLines(resolverDiff).join("\n");
  const verbs = [...added.matchAll(/verb:\s*"([^"]+)"/g)].map((m) => m[1]);
  const paths = [...added.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  const families = [...added.matchAll(/family:\s*"(task|cli)"/g)].map((m) => m[1]);
  const violations: SameDiffExemptionViolation[] = [];
  const count = Math.max(verbs.length, paths.length, families.length);
  for (let i = 0; i < count; i += 1) {
    const verb = verbs[i] ?? verbs[0];
    const path = paths[i] ?? paths[0];
    const family = (families[i] ?? families[0] ?? "task") as CommandSnippetFamily;
    if (!verb || !path) continue;
    const targetDiff = files.get(path) ?? "";
    const snippetAdded = addedLines(targetDiff).some(
      (line) =>
        line.includes(`task ${verb}`) ||
        line.includes(`deft ${verb}`) ||
        line.includes(`directive ${verb}`),
    );
    if (snippetAdded) {
      violations.push({ verb, path, family });
    }
  }
  return violations;
}

/**
 * Same-diff exemption ownership (#4094): adding an allowlist row in the same
 * diff as the snippet it exempts fails. `git log -p` is scored per commit.
 */
export function sameDiffExemptionViolations(
  diffText: string,
): readonly SameDiffExemptionViolation[] {
  const seen = new Set<string>();
  const violations: SameDiffExemptionViolation[] = [];
  for (const chunk of candidateDiffChunks(diffText)) {
    for (const violation of sameDiffExemptionViolationsOne(chunk)) {
      const key = `${violation.family}\0${violation.verb}\0${violation.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push(violation);
    }
  }
  return violations;
}

export function formatCommandSnippetFailure(result: CommandSnippetEvaluation): string {
  const lines = [
    `Command-snippet contract failed: ${result.findings.length} current snippet(s) do not resolve as public commands.`,
  ];
  for (const finding of result.findings.slice(0, 40)) {
    const s = finding.snippet;
    lines.push(
      `  ${s.file}:${s.line} ${s.raw} audience=${s.audience} span=${s.span} -> ${finding.resolution.kind}`,
    );
  }
  if (result.findings.length > 40) {
    lines.push(`  ... ${result.findings.length - 40} more`);
  }
  return lines.join("\n");
}
