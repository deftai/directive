/**
 * Read-only API for what Directive owns in a project (#6615 / AC11.10).
 *
 * One answer to "which changes are Directive's own", for uninstall, doctor,
 * the commit gate and the `.gitattributes` cleanup:
 *
 * - {@link listDirectiveOwnedPaths}: the committed ownership record
 *   (`.deft/GENERATION.json`) joined with the known Directive path classes.
 * - {@link classifyDirectiveOwnedChange}: is one file's change made only of
 *   Directive-owned material?
 *
 * Both are pure reads: no file writes, no `git` calls (AC12.1, so doctor can
 * call them). The record is bounded cleanup information, never authority for
 * arbitrary paths (AC11.10): a record entry outside the known path classes is
 * ignored and reported by {@link inspectDirectiveOwnedPaths}.
 *
 * `managed-lines`, `dependency-entry` and `retired` exist only in this API,
 * from code knowledge. They are never written to GENERATION.json: the record
 * parser rejects unknown kinds, so an older runtime would lose the whole record.
 * This is not a generic installer registry (AC8.10 / §A6.1).
 *
 * Consumers: the commit gate (P4-U1), uninstall-class checks (P2-U14), doctor.
 * Keep the exported names and result values stable.
 */

import {
  GROK_PRETOOLUSE_WRAPPER_REL_PATH,
  hostHookEntryText,
} from "../init-deposit/agent-hooks.js";
import {
  isDirectiveDependencyKey,
  isUpgradePinPathContentAllowed,
  PACKAGE_JSON_DEP_FIELDS,
} from "../init-deposit/hygiene.js";
import {
  isRetiredGitattributesLine,
  PRETTIERIGNORE_HOOK_FILES_LINE,
  PRETTIERIGNORE_MANAGED_HEADER,
  RETIRED_PRETTIERIGNORE_HEADER,
  RETIRED_PRETTIERIGNORE_LINES,
} from "../init-deposit/retired-copy-model-lines.js";
import {
  DESIRED_GITATTRIBUTES_LINES,
  gitattributesDepositComment,
} from "../init-deposit/scaffold.js";
import { CONSUMER_SKILL_DISCOVERY_INVENTORY } from "../init-deposit/skill-discovery-deposit.js";
import { slashCommandManagedExactPaths } from "../init-deposit/slash-deposit.js";
import { renderConsumerHeader } from "../platform/agents-consumer-header.js";
import { GENERATION_REL, READINESS_DIR_REL, RUNTIME_PACKAGE_PATH_PREFIX } from "./constants.js";
import {
  inspectOwnershipRecord,
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_OPEN_PREFIX,
  type OwnershipKind,
} from "./ownership.js";

/**
 * How Directive owns a path. `whole-file`, `marked-section`,
 * `structured-entry` and `retained` match the GENERATION.json kinds;
 * `managed-lines`, `dependency-entry` and `retired` exist only in this API.
 */
export type DirectiveOwnershipKind =
  /** Wholly owned: `.mjs` outers, `.githooks/*`, skill pointers, slash wrappers, GENERATION.json, data-schema.json, readiness markers. */
  | "whole-file"
  /** Directive marked section in a shared file: `AGENTS.md`. */
  | "marked-section"
  /** Directive entries in a shared structured file: host hook configs, `Taskfile.yml` `includes.deft`. */
  | "structured-entry"
  /** Directive lines in a shared line file: `.gitignore`, `.gitattributes`, `.prettierignore`. */
  | "managed-lines"
  /** Directive dependency entry: `package.json` and the lockfiles. */
  | "dependency-entry"
  /** Old Directive file that may only be deleted. */
  | "retired"
  /** Settings/data that survive uninstall; never "owned" for commit purposes. */
  | "retained";

export interface DirectiveOwnedPath {
  /**
   * Project-relative POSIX path. When {@link pattern} is set, this is a
   * display template (for example `.claude/deft-hook-<sha8>.mjs`); match with
   * the pattern instead.
   */
  readonly path: string;
  /** Set for path families: `deft-hook-<sha8>.mjs` outers and readiness markers. */
  readonly pattern?: RegExp;
  readonly kind: DirectiveOwnershipKind;
  /** False only for per-clone readiness markers. */
  readonly mustCommit: boolean;
  /** `record` = listed in GENERATION.json (and inside a known class); `known` = runtime code knowledge. */
  readonly source: "record" | "known";
}

/** A GENERATION.json entry the API did not trust, with the reason. */
export interface IgnoredOwnershipRecordEntry {
  readonly path: string;
  readonly kind: OwnershipKind;
  readonly reason: "outside-known-classes" | "kind-mismatch";
}

export interface DirectiveOwnedPathsInspection {
  readonly paths: readonly DirectiveOwnedPath[];
  /** Ownership record state; an unreadable record contributes no entries. */
  readonly record: "valid" | "absent" | "unreadable";
  /** Record entries ignored because they fall outside the known classes (AC11.10). */
  readonly ignoredRecordEntries: readonly IgnoredOwnershipRecordEntry[];
}

export type DirectiveOwnedChange = "directive-only" | "mixed" | "not-owned";

/**
 * `.gitignore` lines setup adds (AC8.5, v261118): the package folder, the
 * readiness markers, and the named per-checkout runtime files (one holds the
 * pre-PR signing secret). Setup, doctor and this API share this one copy.
 * Adding a path here is a requirements change (AC8.5).
 *
 * #6795: after the named lines, `.deft/*` ignores the rest of Directive's
 * runtime state, and the `!` lines that follow keep the records a project
 * commits trackable. Order matters: each `!` line must come after `.deft/*`,
 * and each temp-file ignore after the `!` line for its folder. Setup appends
 * the block in this order; doctor checks the order.
 *
 * #6842: `.deft/directive/` holds committed Directive files
 * (`data-schema.json`), so it is kept trackable; its readiness markers are
 * ignored again after its `!` lines. These lines close the block, so a
 * 0.130.1 `.gitignore` gets only them appended on repair.
 */
export const DIRECTIVE_GITIGNORE_LINES = [
  "node_modules/",
  ".deft/pre-pr-execution-private/",
  ".deft/plan-sequence.json.generation",
  ".deft/plan-sequence.json.lock",
  ".deft/plan-sequence.json.lock.claim-*",
  ".deft/orientation-state.json",
  ".deft/*",
  "!.deft/plan-sequence.json",
  "!.deft/GENERATION.json",
  "!.deft/approved-scope/",
  "!.deft/approved-scope/**",
  "!.deft/intent-constraint/",
  "!.deft/intent-constraint/**",
  "!.deft/observable-scope/",
  "!.deft/observable-scope/**",
  "!.deft/observable-ui.policy.json",
  "!.deft/presentation-ceiling.json",
  "!.deft/test-boundary.policy.json",
  ".deft/approved-scope/*.bak",
  ".deft/approved-scope/*.next.tmp",
  ".deft/approved-scope/.*.pair.lock.tmp",
  ".deft/approved-scope/.*.pair.lock.tmp.stale",
  ".deft/approved-scope/.*.publishing.bak",
  ".deft/intent-constraint/*.bak",
  ".deft/intent-constraint/*.next.tmp",
  "!.deft/directive/",
  "!.deft/directive/**",
  ".deft/directive/wiring-ready.*.json",
  ".deft-cache/",
] as const;

/** First line of the order-sensitive `.deft/` block in {@link DIRECTIVE_GITIGNORE_LINES} (#6795). */
export const DIRECTIVE_GITIGNORE_DEFT_BLOCK_START = ".deft/*" as const;

/**
 * The order-sensitive tail of {@link DIRECTIVE_GITIGNORE_LINES}: `.deft/*`, the
 * `!` lines, and the temp-file ignores under the kept folders (#6795).
 */
export function directiveGitignoreOrderedBlock(): readonly string[] {
  const lines = DIRECTIVE_GITIGNORE_LINES as readonly string[];
  const start = lines.indexOf(DIRECTIVE_GITIGNORE_DEFT_BLOCK_START);
  const end = lines.indexOf(".deft-cache/");
  return lines.slice(start, end);
}

/**
 * Length of the longest prefix of `block` that appears in `lines` in order
 * (an ordered subsequence, other lines allowed between). Lines from the
 * returned index on are missing or out of order and must be re-appended after
 * every existing line for git to apply them as intended (#6795).
 */
export function gitignoreOrderedPrefixLength(
  lines: readonly string[],
  block: readonly string[],
): number {
  let matched = 0;
  for (const line of lines) {
    if (matched < block.length && line === block[matched]) matched += 1;
  }
  return matched;
}

/** `Taskfile.yml` that setup writes when the project has none. */
export const MINIMAL_TASKFILE = `version: '3'

# Installed by Directive setup (Wave 2c). Framework tasks under deft:.
includes:
  deft:
    taskfile: ./${RUNTIME_PACKAGE_PATH_PREFIX}Taskfile.yml
    optional: true
`;

/** Comment setup writes above an `includes:` key it appends to an existing Taskfile. */
const TASKFILE_APPENDED_INCLUDES_COMMENT = "# Added by Directive setup (Wave 2c)";

/** Host hook config files that hold Directive hook registrations. */
export const HOST_HOOK_CONFIG_RELS = [
  ".claude/settings.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".grok/hooks/deft.json",
] as const;

/** Host directories that hold the committed `deft-hook-<sha8>.mjs` outers (AC9.1). */
export const HOST_HOOK_OUTER_DIRS = [".claude", ".codex", ".cursor/hooks", ".grok/hooks"] as const;

/** Wholly owned git hook files setup writes. */
export const DIRECTIVE_GITHOOK_RELS = [
  ".githooks/pre-commit",
  ".githooks/pre-push",
  ".githooks/_directive-run.sh",
] as const;

/** Host roots that hold thin skill pointers (`<root>/<skill>/SKILL.md`). */
export const SKILL_POINTER_HOST_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codex/skills",
  ".github/skills",
] as const;

export const DATA_SCHEMA_MARKER_REL = ".deft/directive/data-schema.json";

const DEPENDENCY_ENTRY_RELS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

const MANAGED_LINE_RELS = [".gitignore", ".gitattributes", ".prettierignore"] as const;
type ManagedLineRel = (typeof MANAGED_LINE_RELS)[number];

/** Old Directive files: a change to one is Directive-only only when it deletes it. */
const RETIRED_RELS = [
  GROK_PRETOOLUSE_WRAPPER_REL_PATH,
  ".githooks/_deft-run.sh",
  ".deft-version",
  "vbrief/.deft-version",
  "xbrief/.deft-version",
] as const;

const RETAINED_RELS = ["xbrief", ".deft/settings.json"] as const;

const OUTER_FILE_RE = "deft-hook-[a-f0-9]{8}\\.mjs";

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pattern for one host's committed `.mjs` outer (any sha8). */
export function hostHookOuterPathPattern(dir: string): RegExp {
  return new RegExp(`^${escapeRe(dir)}/${OUTER_FILE_RE}$`);
}

const READINESS_PATTERN = new RegExp(
  `^${escapeRe(READINESS_DIR_REL)}/wiring-ready\\.[^/]+\\.json$`,
);

const SKILL_POINTER_PATTERN = new RegExp(
  `^(?:${SKILL_POINTER_HOST_ROOTS.map(escapeRe).join("|")})/deft(?:-[a-z0-9-]+)?/SKILL\\.md$`,
);

/** The `.mjs` outer path token in a registered command (AC9.1). */
const OUTER_PATH_TOKEN_RE = new RegExp(
  `^(?:\\./)?(?:${HOST_HOOK_OUTER_DIRS.map(escapeRe).join("|")})/${OUTER_FILE_RE}$`,
);

const HOOK_BIN_PATH_TOKEN = `${RUNTIME_PACKAGE_PATH_PREFIX}dist/hook-bin.js`;

/** Retired Grok `.sh` wrapper path token (`./deft-pretooluse-wrapper.sh` or the full deposit path). */
const GROK_WRAPPER_TOKEN_RE = /^(?:\.\/)?(?:\.grok\/hooks\/)?deft-pretooluse-wrapper\.sh$/;

/** A plain argument token: flags and values only, no shell syntax (`&&`, `;`, `|`, quotes, `$`). */
const PLAIN_ARG_TOKEN_RE = /^[A-Za-z0-9_.:=-]+$/;

/** Taskfile include targets Directive writes or wrote (`includes.deft`). */
const DIRECTIVE_TASKFILE_TARGETS: ReadonlySet<string> = new Set([
  `./${RUNTIME_PACKAGE_PATH_PREFIX}Taskfile.yml`,
  `${RUNTIME_PACKAGE_PATH_PREFIX}Taskfile.yml`,
  "./.deft/core/Taskfile.yml",
  ".deft/core/Taskfile.yml",
]);

function known(
  path: string,
  kind: DirectiveOwnershipKind,
  extra: { pattern?: RegExp; mustCommit?: boolean } = {},
): DirectiveOwnedPath {
  return {
    path,
    kind,
    mustCommit: extra.mustCommit ?? true,
    source: "known",
    ...(extra.pattern !== undefined ? { pattern: extra.pattern } : {}),
  };
}

let knownCache: readonly DirectiveOwnedPath[] | null = null;

/** The runtime's known Directive path classes (static code knowledge). */
function knownDirectivePaths(): readonly DirectiveOwnedPath[] {
  if (knownCache !== null) return knownCache;
  const out: DirectiveOwnedPath[] = [];
  for (const dir of HOST_HOOK_OUTER_DIRS) {
    out.push(
      known(`${dir}/deft-hook-<sha8>.mjs`, "whole-file", {
        pattern: hostHookOuterPathPattern(dir),
      }),
    );
  }
  for (const rel of DIRECTIVE_GITHOOK_RELS) out.push(known(rel, "whole-file"));
  out.push(known(GENERATION_REL, "whole-file"));
  out.push(known(DATA_SCHEMA_MARKER_REL, "whole-file"));
  for (const root of SKILL_POINTER_HOST_ROOTS) {
    for (const skill of CONSUMER_SKILL_DISCOVERY_INVENTORY) {
      out.push(known(`${root}/${skill.dir}/SKILL.md`, "whole-file"));
    }
  }
  for (const rel of slashCommandManagedExactPaths()) out.push(known(rel, "whole-file"));
  out.push(
    known(`${READINESS_DIR_REL}/wiring-ready.<version>.json`, "whole-file", {
      pattern: READINESS_PATTERN,
      mustCommit: false,
    }),
  );
  out.push(known("AGENTS.md", "marked-section"));
  for (const rel of HOST_HOOK_CONFIG_RELS) out.push(known(rel, "structured-entry"));
  out.push(known("Taskfile.yml", "structured-entry"));
  for (const rel of MANAGED_LINE_RELS) out.push(known(rel, "managed-lines"));
  for (const rel of DEPENDENCY_ENTRY_RELS) out.push(known(rel, "dependency-entry"));
  for (const rel of RETIRED_RELS) out.push(known(rel, "retired"));
  for (const rel of RETAINED_RELS) out.push(known(rel, "retained"));
  knownCache = out;
  return out;
}

/** Project-relative POSIX form (backslashes to `/`, no leading `./`). */
function toPosixRel(relPath: string): string {
  return relPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "");
}

/** True when `relPath` is the entry's path, or matches its pattern. */
export function directiveOwnedPathMatches(entry: DirectiveOwnedPath, relPath: string): boolean {
  const rel = toPosixRel(relPath);
  return entry.pattern !== undefined ? entry.pattern.test(rel) : entry.path === rel;
}

/**
 * The known Directive class for one path, or null. Skill pointers also match
 * by shape (`<host root>/deft…/SKILL.md`) so a newer runtime's pointer set
 * stays inside the class.
 */
function knownClassFor(relPath: string): DirectiveOwnedPath | null {
  const rel = toPosixRel(relPath);
  for (const entry of knownDirectivePaths()) {
    if (directiveOwnedPathMatches(entry, rel)) return entry;
  }
  if (SKILL_POINTER_PATTERN.test(rel)) return known(rel, "whole-file");
  return null;
}

/**
 * Read-only. Committed record ∪ the runtime's known Directive path classes,
 * with the record entries the API ignored (AC11.10). No writes.
 */
export function inspectDirectiveOwnedPaths(projectRoot: string): DirectiveOwnedPathsInspection {
  const inspection = inspectOwnershipRecord(projectRoot);
  const fromRecord: DirectiveOwnedPath[] = [];
  const ignored: IgnoredOwnershipRecordEntry[] = [];
  if (inspection.kind === "valid") {
    for (const art of inspection.record.ownership) {
      const cls = knownClassFor(art.path);
      if (cls === null) {
        ignored.push({ path: art.path, kind: art.kind, reason: "outside-known-classes" });
        continue;
      }
      if (cls.kind !== art.kind) {
        ignored.push({ path: art.path, kind: art.kind, reason: "kind-mismatch" });
        continue;
      }
      if (fromRecord.some((p) => p.path === art.path)) continue;
      fromRecord.push({
        path: art.path,
        kind: art.kind,
        mustCommit: cls.mustCommit,
        source: "record",
      });
    }
  }
  const recordPaths = new Set(fromRecord.map((p) => p.path));
  const knownPaths = knownDirectivePaths().filter(
    (p) => p.pattern !== undefined || !recordPaths.has(p.path),
  );
  return {
    paths: [...fromRecord, ...knownPaths],
    record: inspection.kind,
    ignoredRecordEntries: ignored,
  };
}

/** Read-only. Committed record ∪ the runtime's known Directive path classes. */
export function listDirectiveOwnedPaths(projectRoot: string): readonly DirectiveOwnedPath[] {
  return inspectDirectiveOwnedPaths(projectRoot).paths;
}

// ---------------------------------------------------------------------------
// classifyDirectiveOwnedChange
// ---------------------------------------------------------------------------

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * True when a registered host hook command is one Directive writes or wrote:
 * the `.mjs` outer in a host directory, pin `hook-bin.js`, bare `deft-hook`,
 * `deft hook:dispatch`, or the retired Grok `.sh` wrapper, followed only by
 * plain flag/value arguments. A command that only mentions these, or chains
 * another command (`&&`, `;`, `|`), does not count.
 */
export function isDirectiveHookCommand(command: string): boolean {
  // A newline starts another shell command.
  if (/[\r\n]/.test(command)) return false;
  const tokens = command.trim().split(/[ \t]+/);
  let args: string[];
  if (
    tokens[0] === "node" &&
    tokens[1] === "-e" &&
    tokens[2] === "<locator>" &&
    tokens[3] === "--"
  ) {
    // No-shell locator entry (AC9.1 v261119), read through `hostHookEntryText`.
    if (!OUTER_PATH_TOKEN_RE.test(tokens[4] ?? "")) return false;
    args = tokens.slice(5);
  } else if (tokens[0] === "node" && tokens[1] !== undefined) {
    const target = tokens[1];
    const bin = target.startsWith("./") ? target.slice(2) : target;
    if (!OUTER_PATH_TOKEN_RE.test(target) && bin !== HOOK_BIN_PATH_TOKEN) return false;
    args = tokens.slice(2);
  } else if (tokens[0] === "deft-hook") {
    args = tokens.slice(1);
  } else if (tokens[0] === "deft" && tokens[1] === "hook:dispatch") {
    args = tokens.slice(2);
  } else if (
    tokens[0] === "sh" &&
    tokens[1] !== undefined &&
    GROK_WRAPPER_TOKEN_RE.test(tokens[1])
  ) {
    args = tokens.slice(2);
  } else if (tokens[0] !== undefined && GROK_WRAPPER_TOKEN_RE.test(tokens[0])) {
    args = tokens.slice(1);
  } else {
    return false;
  }
  // Only `--flag` or `--flag value` pairs: a bare word would be another command.
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] ?? "";
    if (!flag.startsWith("--") || !PLAIN_ARG_TOKEN_RE.test(flag)) return false;
    const value = args[i + 1];
    if (value !== undefined && !value.startsWith("-")) {
      if (!PLAIN_ARG_TOKEN_RE.test(value)) return false;
      i++;
    }
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDirectiveHookEntry(entry: unknown): boolean {
  const text = hostHookEntryText(entry);
  return text !== null && isDirectiveHookCommand(text);
}

/**
 * Remove Directive hook entries from a host hook config. Nested `hooks[]`
 * groups lose only their Directive commands; a group left with no hooks is
 * dropped. Empty event arrays, an empty `hooks` map and a lone Cursor
 * `version` key are dropped too.
 */
function stripDirectiveHooks(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  if (isPlainObject(cfg.hooks)) {
    const nextHooks: Record<string, unknown> = {};
    for (const [event, value] of Object.entries(cfg.hooks)) {
      if (!Array.isArray(value)) {
        nextHooks[event] = value;
        continue;
      }
      const kept: unknown[] = [];
      for (const entry of value) {
        if (isDirectiveHookEntry(entry)) continue;
        if (isPlainObject(entry) && Array.isArray(entry.hooks)) {
          const nested = entry.hooks.filter((h) => !isDirectiveHookEntry(h));
          if (nested.length === 0 && entry.hooks.length > 0) continue;
          kept.push({ ...entry, hooks: nested });
          continue;
        }
        kept.push(entry);
      }
      if (kept.length > 0) nextHooks[event] = kept;
    }
    if (Object.keys(nextHooks).length > 0) out.hooks = nextHooks;
    else delete out.hooks;
  }
  if (out.hooks === undefined && Object.keys(out).length === 1 && "version" in out) {
    delete out.version;
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Parse a JSON object; a `null` side is an absent file (`{}`); invalid → undefined. */
function parseJsonObjectOrEmpty(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function classifyHostHookConfig(before: string | null, after: string | null): DirectiveOwnedChange {
  const b = parseJsonObjectOrEmpty(before);
  const a = parseJsonObjectOrEmpty(after);
  if (b === undefined || a === undefined) return "mixed";
  return deepEqual(stripDirectiveHooks(b), stripDirectiveHooks(a)) ? "directive-only" : "mixed";
}

/** Remove the Directive marked section (open prefix … close marker). */
function stripManagedSection(body: string): string {
  const start = body.indexOf(MANAGED_SECTION_OPEN_PREFIX);
  if (start < 0) return body;
  const openEnd = body.indexOf("-->", start);
  if (openEnd < 0) return body;
  const end = body.indexOf(MANAGED_SECTION_CLOSE, openEnd);
  if (end < 0) return body;
  return body.slice(0, start) + body.slice(end + MANAGED_SECTION_CLOSE.length);
}

function collapseBlankRuns(text: string): string {
  return normalizeEol(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Unmanaged header setup writes into a new AGENTS.md (template, or the built-in fallback). */
function agentsScaffoldHeaders(): string[] {
  const headers: string[] = [];
  const readers = [
    () => renderConsumerHeader(),
    () => renderConsumerHeader({ readTemplate: () => null }),
  ];
  for (const read of readers) {
    try {
      headers.push(collapseBlankRuns(read()));
    } catch {
      /* template unreadable: use the other form */
    }
  }
  return headers;
}

function isAgentsScaffoldRemainder(remainder: string): boolean {
  const rest = collapseBlankRuns(remainder);
  return rest === "" || agentsScaffoldHeaders().includes(rest);
}

function classifyAgentsMd(before: string | null, after: string | null): DirectiveOwnedChange {
  if (before === null || after === null) {
    const present = (before ?? after) as string;
    return isAgentsScaffoldRemainder(stripManagedSection(normalizeEol(present)))
      ? "directive-only"
      : "mixed";
  }
  const b = collapseBlankRuns(stripManagedSection(normalizeEol(before)));
  const a = collapseBlankRuns(stripManagedSection(normalizeEol(after)));
  return a === b ? "directive-only" : "mixed";
}

function leadingWhitespace(line: string): number {
  return line.length - line.trimStart().length;
}

/** `key:` with an optional trailing `# comment`, nothing else. */
function isBareYamlKey(trimmed: string, key: string): boolean {
  if (!trimmed.startsWith(`${key}:`)) return false;
  const rest = trimmed.slice(key.length + 1).trim();
  return rest === "" || rest.startsWith("#");
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Remove Directive's `deft:` child of the top-level `includes:` map: only when
 * its `taskfile:` points at Directive's Taskfile (runtime package, or the
 * retired `.deft/core` copy). A user `tasks.deft` or a custom `includes.deft`
 * target stays. Line-based (no backtracking regex). Exported so the runtime
 * uninstaller and this API share one copy.
 */
export function stripTaskfileDeftInclude(body: string): { next: string; removed: boolean } {
  const lines = body.split("\n");
  let inIncludes = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const indent = leadingWhitespace(line);
    if (indent === 0 && trimmed !== "" && !trimmed.startsWith("#")) {
      inIncludes = isBareYamlKey(trimmed, "includes");
      continue;
    }
    if (!inIncludes || indent === 0 || !isBareYamlKey(trimmed, "deft")) continue;
    let end = i + 1;
    let directiveTarget = false;
    while (end < lines.length) {
      const child = lines[end] ?? "";
      if (child.trim() === "" || leadingWhitespace(child) <= indent) break;
      const childTrimmed = child.trim();
      if (childTrimmed.startsWith("taskfile:")) {
        const value = unquote(childTrimmed.slice("taskfile:".length).split(" #")[0] ?? "");
        directiveTarget = DIRECTIVE_TASKFILE_TARGETS.has(value);
      }
      end++;
    }
    if (!directiveTarget) continue;
    lines.splice(i, end - i);
    const next = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    return { next, removed: true };
  }
  return { next: body, removed: false };
}

/** Taskfile text without Directive material: the `deft:` block and a setup-appended empty `includes:`. */
function taskfileWithoutDirective(body: string): string {
  let next = stripTaskfileDeftInclude(normalizeEol(body)).next;
  const appended = `\n${TASKFILE_APPENDED_INCLUDES_COMMENT}\nincludes:\n`;
  if (next.endsWith(appended)) next = next.slice(0, next.length - appended.length + 1);
  return collapseBlankRuns(next);
}

function classifyTaskfile(before: string | null, after: string | null): DirectiveOwnedChange {
  if (before === null || after === null) {
    const present = normalizeEol((before ?? after) as string);
    if (present === MINIMAL_TASKFILE) return "directive-only";
    return taskfileWithoutDirective(present) === "" ? "directive-only" : "mixed";
  }
  return taskfileWithoutDirective(before) === taskfileWithoutDirective(after)
    ? "directive-only"
    : "mixed";
}

/**
 * True for a Directive line (or deposit comment) in a managed-lines file.
 * Includes the retired `.deft/core` lines, so removing them is Directive-only.
 */
function isDirectiveLine(rel: ManagedLineRel, line: string): boolean {
  switch (rel) {
    case ".gitignore":
      return (DIRECTIVE_GITIGNORE_LINES as readonly string[]).includes(line);
    case ".gitattributes":
      return (
        DESIRED_GITATTRIBUTES_LINES.includes(line) ||
        gitattributesDepositComment().split("\n").includes(line) ||
        isRetiredGitattributesLine(line)
      );
    case ".prettierignore":
      return (
        line === PRETTIERIGNORE_HOOK_FILES_LINE ||
        line === PRETTIERIGNORE_MANAGED_HEADER ||
        RETIRED_PRETTIERIGNORE_LINES.includes(line) ||
        line === RETIRED_PRETTIERIGNORE_HEADER
      );
  }
}

/** Non-blank lines that are not Directive's, in file order. */
function userLines(text: string | null, isDirective: (line: string) => boolean): string[] {
  if (text === null) return [];
  // Keep the user's order: ignore and attribute rules depend on it (`!` negation, later lines win).
  return normalizeEol(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isDirective(l));
}

function classifyManagedLines(
  rel: ManagedLineRel,
  before: string | null,
  after: string | null,
): DirectiveOwnedChange {
  const isDirective = (line: string): boolean => isDirectiveLine(rel, line);
  const b = userLines(before, isDirective);
  const a = userLines(after, isDirective);
  return b.length === a.length && b.every((l, i) => l === a[i]) ? "directive-only" : "mixed";
}

/** package.json without Directive dependency keys or the dependency maps they leave empty. */
function packageJsonWithoutDirective(pkg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pkg)) {
    if ((PACKAGE_JSON_DEP_FIELDS as readonly string[]).includes(key) && isPlainObject(value)) {
      const kept = Object.fromEntries(
        Object.entries(value).filter(([dep]) => !isDirectiveDependencyKey(dep)),
      );
      if (Object.keys(kept).length > 0) out[key] = kept;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Empty, or exactly the `{ "private": true }` the launcher creates (AC6.12). */
function isPackageJsonScaffold(pkg: Record<string, unknown>): boolean {
  const rest = packageJsonWithoutDirective(pkg);
  const keys = Object.keys(rest);
  return keys.length === 0 || (keys.length === 1 && rest.private === true);
}

function classifyPackageJson(before: string | null, after: string | null): DirectiveOwnedChange {
  const b = parseJsonObjectOrEmpty(before);
  const a = parseJsonObjectOrEmpty(after);
  if (b === undefined || a === undefined) return "mixed";
  if (before === null || after === null) {
    return isPackageJsonScaffold(before === null ? a : b) ? "directive-only" : "mixed";
  }
  if (isUpgradePinPathContentAllowed("package.json", before, after)) return "directive-only";
  return deepEqual(packageJsonWithoutDirective(b), packageJsonWithoutDirective(a))
    ? "directive-only"
    : "mixed";
}

function classifyLockfile(
  rel: "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock",
  before: string | null,
  after: string | null,
): DirectiveOwnedChange {
  const empty = rel === "package-lock.json" ? "{}" : "";
  if (!isUpgradePinPathContentAllowed(rel, before ?? empty, after ?? empty)) return "mixed";
  if (rel === "package-lock.json" && before !== null && after !== null) {
    return npmLockAppMetadataEqual(before, after) ? "directive-only" : "mixed";
  }
  return "directive-only";
}

/** Dependency maps in a package-lock root entry; everything else there is app metadata. */
const NPM_LOCK_ROOT_DEP_FIELDS: ReadonlySet<string> = new Set([
  ...PACKAGE_JSON_DEP_FIELDS,
  "bundleDependencies",
  "bundledDependencies",
]);

/** Root `packages[""]` object, when this lockfile has one. */
function npmLockRootPackagesEntry(
  lock: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const root = isPlainObject(lock.packages) ? lock.packages[""] : undefined;
  return isPlainObject(root) ? root : undefined;
}

/**
 * True when the root entry records `package.json`'s `name`. npm writes that
 * field only when the manifest declares one (lockfileVersion 2+).
 */
function npmLockRootCarriesName(lock: Record<string, unknown>): boolean {
  const root = npmLockRootPackagesEntry(lock);
  return root !== undefined && Object.hasOwn(root, "name");
}

/**
 * The pin follow-through check looks only at dependencies. The app's own
 * fields (top-level `name` / `version`, and the root `packages[""]` entry
 * apart from its dependency maps) must also be unchanged. `lockfileVersion`
 * and `requires` may move with the package manager.
 *
 * When both locks have a root entry and neither carries `name`, npm derived
 * the top-level `name` from the folder (#7233). That label is package-manager
 * metadata too. A root entry that carries `name` is the app's declared name,
 * so a change stays mixed. A missing root entry (lockfileVersion 1) keeps the
 * top-level `name` as app metadata.
 */
function npmLockAppMetadataEqual(beforeRaw: string, afterRaw: string): boolean {
  const b = parseJsonObjectOrEmpty(beforeRaw);
  const a = parseJsonObjectOrEmpty(afterRaw);
  if (b === undefined || a === undefined) return false;
  const folderDerivedName =
    npmLockRootPackagesEntry(b) !== undefined &&
    npmLockRootPackagesEntry(a) !== undefined &&
    !npmLockRootCarriesName(b) &&
    !npmLockRootCarriesName(a);
  const ignoredTop = new Set<string>(["packages", "dependencies", "lockfileVersion", "requires"]);
  if (folderDerivedName) ignoredTop.add("name");
  const topLevel = (lock: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(lock).filter(([k]) => !ignoredTop.has(k)));
  const rootEntry = (lock: Record<string, unknown>): Record<string, unknown> => {
    const root = npmLockRootPackagesEntry(lock);
    if (root === undefined) return {};
    return Object.fromEntries(
      Object.entries(root).filter(([k]) => !NPM_LOCK_ROOT_DEP_FIELDS.has(k)),
    );
  };
  return deepEqual(topLevel(b), topLevel(a)) && deepEqual(rootEntry(b), rootEntry(a));
}

/**
 * Read-only. Is this one file's change made only of Directive-owned material?
 *
 * - `directive-only`: every difference is Directive's own.
 * - `mixed`: a Directive path (or one holding Directive material) whose change
 *   also holds something else, or is not a change Directive makes.
 * - `not-owned`: not a Directive path. Retained data (`xbrief/`,
 *   `.deft/settings.json`) is never owned for commit purposes.
 *
 * Whole Directive files pass on path alone (v1). `before` is the HEAD blob, or
 * null for a new file; `after` is the staged blob, or null for a deletion.
 */
export function classifyDirectiveOwnedChange(
  relPath: string,
  before: string | null,
  after: string | null,
): DirectiveOwnedChange {
  const rel = toPosixRel(relPath);
  const cls = knownClassFor(rel);
  if (cls === null || cls.kind === "retained") return "not-owned";
  switch (cls.kind) {
    case "whole-file":
      return "directive-only";
    case "retired":
      return after === null ? "directive-only" : "mixed";
    case "marked-section":
      return classifyAgentsMd(before, after);
    case "structured-entry":
      return rel === "Taskfile.yml"
        ? classifyTaskfile(before, after)
        : classifyHostHookConfig(before, after);
    case "managed-lines":
      return classifyManagedLines(rel as ManagedLineRel, before, after);
    case "dependency-entry":
      return rel === "package.json"
        ? classifyPackageJson(before, after)
        : classifyLockfile(
            rel as "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock",
            before,
            after,
          );
  }
}
