/**
 * Rule-to-verb / rule-to-task parity (#5521).
 *
 * Every concrete `deft <verb>` / `task <name>` named in the pinned templates
 * agents-entry.md and agent-prompt-preamble.md must resolve against CLI
 * registry metadata and the Taskfile graph. Family globs such as
 * `deft scm:body:*` expand (or refuse) against the known eight-member set.
 * Inspects source/metadata only — never executes a scraped command.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTaskfileIncludes, taskDefinedInTaskfileYaml } from "./consumer-gate-integrity.js";

export const RULE_TO_VERB_PARITY_GATE_ID = "verify:rule-to-verb-parity";

export const RULE_TO_VERB_TEMPLATE_RELS = [
  "content/templates/agents-entry.md",
  "content/templates/agent-prompt-preamble.md",
] as const;

/** Eight scm:body:* members the family glob must expand to (#5521 Prefer-A). */
export const SCM_BODY_FAMILY_MEMBERS = [
  "scm:body:issue:create",
  "scm:body:issue:edit",
  "scm:body:issue:fetch",
  "scm:body:issue:lint",
  "scm:body:comment:create",
  "scm:body:comment:edit",
  "scm:body:pr:edit",
  "scm:body:pr:lint",
] as const;

const DEFT_INVOCATION_RE = /`deft ([^`]+)`/g;
const TASK_INVOCATION_RE = /`task ([^`]+)`/g;
const CONSUMER_INCLUDE_PREFIX = "deft:";

export type RuleCitationKind = "deft" | "task";

export interface RuleCitation {
  readonly kind: RuleCitationKind;
  readonly raw: string;
  readonly file: string;
  readonly line: number;
}

export interface ParityFinding {
  readonly kind: RuleCitationKind | "glob";
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

export interface RuleToVerbParityResult {
  readonly ok: boolean;
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly findings: readonly ParityFinding[];
  readonly citations: readonly RuleCitation[];
}

export interface RuleToVerbParitySeams {
  readonly readText?: (absPath: string) => string | null;
  readonly exists?: (absPath: string) => boolean;
  /** Test seam: override discovered CLI verb set. */
  readonly cliVerbs?: ReadonlySet<string>;
  /** Test seam: override task resolver. */
  readonly taskResolves?: (name: string) => boolean;
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
  const block = sliceAssignment(source, name);
  const keys = new Set<string>();
  for (const match of block.matchAll(/"([^"]+)"\s*:/g)) {
    if (match[1]) keys.add(match[1]);
  }
  // Unquoted TS object keys (e.g. VERIFY_VERB_MAP.routing).
  for (const match of block.matchAll(/(?:^|[,{]\s*)([A-Za-z_][\w-]*)\s*:/g)) {
    if (match[1]) keys.add(match[1]);
  }
  return [...keys];
}

/** First token of a backtick invocation (strips flags / ellipsis / placeholders). */
export function firstInvocationToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const token = trimmed.split(/\s+/)[0];
  if (token === undefined || token.length === 0) return null;
  // Flags / meta (`--version`) are not verb citations.
  if (token.startsWith("-")) return null;
  // Drop trailing punctuation leftovers from prose (keep internal colons).
  const cleaned = token.replace(/[.,;]+$/u, "");
  if (cleaned.length === 0) return null;
  return cleaned;
}

/** True when the token is a generic placeholder (`*`, `deft:*`), not a named family. */
export function isNamespaceWildcard(token: string): boolean {
  const stripped = token.startsWith(CONSUMER_INCLUDE_PREFIX)
    ? token.slice(CONSUMER_INCLUDE_PREFIX.length)
    : token;
  // Keep `task deft:*` / bare `*` excluded; named families (e.g. swarm:*) go to expandFamilyGlob.
  return stripped === "*" || stripped === "";
}

/**
 * Expand or refuse a family glob. Known: `scm:body:*` → eight members.
 * Unknown family globs refuse (naive literal-only green is refuse).
 */
export function expandFamilyGlob(
  token: string,
):
  | { readonly ok: true; readonly members: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  if (!token.includes("*")) {
    return { ok: true, members: [token] };
  }
  if (token === "scm:body:*" || token === "scm:body:") {
    return { ok: true, members: SCM_BODY_FAMILY_MEMBERS };
  }
  return {
    ok: false,
    reason: `family glob '${token}' is not expandable; name concrete verbs or a known family`,
  };
}

export function loadRegisteredCliVerbs(
  repoRoot: string,
  seams: RuleToVerbParitySeams = {},
): Set<string> {
  if (seams.cliVerbs !== undefined) {
    return new Set(seams.cliVerbs);
  }
  const readText =
    seams.readText ??
    ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const dispatch = readText(join(repoRoot, "packages/cli/src/dispatch.ts")) ?? "";
  const router = readText(join(repoRoot, "packages/cli/src/cli-router/route-argv.ts")) ?? "";
  const deferredTop = new Set(quotedStrings(sliceAssignment(router, "DEFERRED_TOP_LEVEL_VERBS")));
  const stubbedTop = new Set(quotedStrings(sliceAssignment(router, "STUBBED_TOP_LEVEL_VERBS")));
  const topLevel = parseStringArrayExport(router, "TOP_LEVEL_UX_VERBS").filter(
    (verb) => !deferredTop.has(verb) && !stubbedTop.has(verb),
  );
  const verbs = new Set<string>([
    ...parseStringArrayExport(dispatch, "CLI_MODULE_VERBS"),
    ...parseStringArrayExport(dispatch, "CORE_MODULE_VERBS"),
    ...parseRecordKeys(dispatch, "VERB_ALIASES"),
    ...parseRecordKeys(dispatch, "TRIAGE_ACTION_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "POLICY_ACTION_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "AUTHZ_ACTION_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "ESCALATION_ACTION_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "PLAN_SEQUENCE_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "PRODUCT_SIGNAL_ALIAS_SUBCOMMANDS"),
    ...parseRecordKeys(dispatch, "FRESHNESS_ALIAS_SUBCOMMANDS"),
    ...topLevel,
    ...parseRecordKeys(router, "SUBCOMMAND_ROUTES"),
    ...parseRecordKeys(router, "PR_VERB_MAP").map((v) => `pr:${v}`),
    ...parseRecordKeys(router, "VERIFY_VERB_MAP").map((v) => `verify:${v}`),
    ...parseStringArrayExport(router, "SCOPE_LIFECYCLE_VERBS").map((v) => `scope:${v}`),
  ]);
  // Do not invent policy:<POLICY_SET_COMMANDS> spellings — those are policy-set /
  // `deft policy set <cmd>` only. Real policy:* colon aliases come from
  // POLICY_ACTION_ALIAS_SUBCOMMANDS above.
  // Space-form top-level check/doctor already covered via available TOP_LEVEL_UX_VERBS.
  return verbs;
}

export function taskNameResolves(
  repoRoot: string,
  name: string,
  seams: RuleToVerbParitySeams = {},
): boolean {
  if (seams.taskResolves !== undefined) {
    return seams.taskResolves(name);
  }
  const readText =
    seams.readText ??
    ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const exists = seams.exists ?? ((p: string) => existsSync(p));
  const rootPath = join(repoRoot, "Taskfile.yml");
  if (!exists(rootPath)) return false;
  const rootText = readText(rootPath);
  if (rootText === null) return false;
  if (taskDefinedInTaskfileYaml(rootText, name)) return true;
  const colon = name.indexOf(":");
  if (colon <= 0) return false;
  const namespace = name.slice(0, colon);
  const local = name.slice(colon + 1);
  const includes = parseTaskfileIncludes(rootText);
  const include = includes.get(namespace);
  if (include === undefined) return false;
  const includePath = resolve(repoRoot, include.taskfile);
  if (!exists(includePath)) return false;
  const includeText = readText(includePath);
  return includeText !== null && taskDefinedInTaskfileYaml(includeText, local);
}

function stripConsumerPrefix(name: string): string {
  return name.startsWith(CONSUMER_INCLUDE_PREFIX)
    ? name.slice(CONSUMER_INCLUDE_PREFIX.length)
    : name;
}

function pushCitation(
  out: RuleCitation[],
  kind: RuleCitationKind,
  rawToken: string,
  file: string,
  line: number,
): void {
  const token = firstInvocationToken(rawToken);
  if (token === null) return;
  // Skip pure placeholders like `<verb>` or bare ellipsis / namespace wildcards.
  if (token.startsWith("<") || token === "…" || token === "...") return;
  if (isNamespaceWildcard(token)) return;
  if (kind === "task") {
    // Trailing colon-only after glob truncate (`task deft:<verb>`) — skip.
    const stripped = stripConsumerPrefix(token);
    if (stripped === "" || stripped.endsWith(":")) return;
  }
  out.push({ kind, raw: token, file, line });
}

/** Extract concrete deft/task citations from template prose (metadata only). */
export function extractRuleCitations(file: string, text: string): readonly RuleCitation[] {
  const out: RuleCitation[] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let inFence = false;
  for (const [idx, line] of lines.entries()) {
    const fenceOpen = /^```/.test(line);
    if (fenceOpen) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // Bare command lines inside fenced examples (no surrounding backticks).
      const bare = line.trim();
      if (bare.startsWith("deft ")) {
        pushCitation(out, "deft", bare.slice("deft ".length), file, idx + 1);
      } else if (bare.startsWith("task ")) {
        pushCitation(out, "task", bare.slice("task ".length), file, idx + 1);
      }
      // Fall through: numbered/prose fence lines may still carry inline `deft …` ticks.
    }
    DEFT_INVOCATION_RE.lastIndex = 0;
    for (const match of line.matchAll(DEFT_INVOCATION_RE)) {
      const raw = match[1];
      if (raw === undefined) continue;
      pushCitation(out, "deft", raw, file, idx + 1);
    }
    TASK_INVOCATION_RE.lastIndex = 0;
    for (const match of line.matchAll(TASK_INVOCATION_RE)) {
      const raw = match[1];
      if (raw === undefined) continue;
      pushCitation(out, "task", raw, file, idx + 1);
    }
  }
  return out;
}

function cliVerbResolves(cliVerbs: ReadonlySet<string>, name: string): boolean {
  if (cliVerbs.has(name)) return true;
  // Router hyphenates only the first namespace separator (tryColonNamespaceRoute);
  // replaceAll would green dead spellings like rule:to:verb:parity → rule-to-verb-parity.
  const colon = name.indexOf(":");
  if (colon > 0) {
    const hyphen = `${name.slice(0, colon)}-${name.slice(colon + 1)}`;
    if (cliVerbs.has(hyphen)) return true;
  }
  return false;
}

export function evaluateRuleToVerbParity(
  repoRoot: string,
  seams: RuleToVerbParitySeams = {},
): RuleToVerbParityResult {
  const root = resolve(repoRoot);
  const readText =
    seams.readText ??
    ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const exists = seams.exists ?? ((p: string) => existsSync(p));

  const citations: RuleCitation[] = [];
  for (const rel of RULE_TO_VERB_TEMPLATE_RELS) {
    const abs = join(root, rel);
    if (!exists(abs)) {
      return {
        ok: false,
        code: 2,
        message: `${RULE_TO_VERB_PARITY_GATE_ID}: missing template ${rel}`,
        findings: [
          {
            kind: "glob",
            name: rel,
            file: rel,
            line: 0,
            reason: "template file not found",
          },
        ],
        citations: [],
      };
    }
    const text = readText(abs);
    if (text === null) {
      return {
        ok: false,
        code: 2,
        message: `${RULE_TO_VERB_PARITY_GATE_ID}: cannot read template ${rel}`,
        findings: [
          {
            kind: "glob",
            name: rel,
            file: rel,
            line: 0,
            reason: "template unreadable",
          },
        ],
        citations: [],
      };
    }
    citations.push(...extractRuleCitations(rel, text));
  }

  const cliVerbs = loadRegisteredCliVerbs(root, seams);
  const findings: ParityFinding[] = [];

  for (const citation of citations) {
    if (citation.kind === "deft") {
      const expanded = expandFamilyGlob(citation.raw);
      if (!expanded.ok) {
        findings.push({
          kind: "glob",
          name: citation.raw,
          file: citation.file,
          line: citation.line,
          reason: expanded.reason,
        });
        continue;
      }
      for (const member of expanded.members) {
        if (!cliVerbResolves(cliVerbs, member)) {
          findings.push({
            kind: "deft",
            name: member,
            file: citation.file,
            line: citation.line,
            reason: citation.raw.includes("*")
              ? `family member of '${citation.raw}' is not registered in the CLI router`
              : "not registered in the CLI router (modules, aliases, or SUBCOMMAND_ROUTES)",
          });
        }
      }
      continue;
    }

    // task citations
    const expanded = expandFamilyGlob(stripConsumerPrefix(citation.raw));
    if (!expanded.ok) {
      findings.push({
        kind: "glob",
        name: citation.raw,
        file: citation.file,
        line: citation.line,
        reason: expanded.reason,
      });
      continue;
    }
    for (const member of expanded.members) {
      const taskName = citation.raw.startsWith(CONSUMER_INCLUDE_PREFIX)
        ? member
        : stripConsumerPrefix(member);
      // Consumer include form `task deft:X` resolves as framework task X.
      const resolveAs = citation.raw.startsWith(CONSUMER_INCLUDE_PREFIX)
        ? stripConsumerPrefix(citation.raw.includes("*") ? member : citation.raw)
        : taskName;
      if (!taskNameResolves(root, resolveAs, seams)) {
        findings.push({
          kind: "task",
          name: resolveAs,
          file: citation.file,
          line: citation.line,
          reason: "not defined in Taskfile.yml includes / tasks/<ns>.yml",
        });
      }
    }
  }

  if (findings.length > 0) {
    const detail = findings
      .map((f) => `  ${f.file}:${f.line} ${f.kind} \`${f.name}\` — ${f.reason}`)
      .join("\n");
    return {
      ok: false,
      code: 1,
      message:
        `${RULE_TO_VERB_PARITY_GATE_ID}: ${findings.length} unresolved citation(s)\n${detail}\n` +
        "Register the verb in the CLI router / Taskfile, or correct the template prose (#5521).",
      findings,
      citations,
    };
  }

  return {
    ok: true,
    code: 0,
    message: `${RULE_TO_VERB_PARITY_GATE_ID}: ${citations.length} citation(s) resolve`,
    findings: [],
    citations,
  };
}

function parseArgs(argv: readonly string[]): {
  projectRoot: string | null;
  error?: string;
} {
  let projectRoot: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined)
        return { projectRoot, error: "argument --project-root: expected value" };
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--help" || arg === "-h") {
      return { projectRoot, error: undefined };
    } else {
      return { projectRoot, error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot };
}

/** CLI entry for `deft verify:rule-to-verb-parity` / CORE_MODULE dispatch. */
export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: deft verify:rule-to-verb-parity [--project-root <path>]\n" +
        "Fail closed when pinned templates name unregistered deft/task verbs (#5521).\n",
    );
    return 0;
  }
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    process.stderr.write(`${RULE_TO_VERB_PARITY_GATE_ID}: ${parsed.error}\n`);
    return 2;
  }
  const root = resolve(parsed.projectRoot ?? process.cwd());
  const result = evaluateRuleToVerbParity(root);
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}
