/**
 * decision:list — find structured decision records (#1396).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveProjectRoot } from "../scope/project-context.js";
import {
  DECISION_FILE_SUFFIX,
  DECISIONS_DIR_REL,
  type DecisionRecord,
  sanitizeForTerminal,
  validateDecisionRecord,
} from "./schema.js";

export interface DecisionListOptions {
  readonly projectRoot?: string | null;
  /** Filter by substring match on id, decision text, or tags. */
  readonly query?: string | null;
  /** Filter by scope path substring. */
  readonly scope?: string | null;
  /** Filter by related issue number. */
  readonly issue?: number | null;
  /** Max rows (default unlimited). */
  readonly limit?: number | null;
  readonly json?: boolean;
}

export interface DecisionListEntry {
  readonly path: string;
  readonly id: string;
  readonly decision: string;
  readonly confidence: string;
  readonly timestamp: string;
  readonly revisitTrigger: string;
  readonly activeScopeRefs: readonly string[];
  readonly tags: readonly string[];
  readonly relatedIssues: readonly number[];
}

export interface DecisionListResult {
  readonly exitCode: 0 | 1 | 2;
  readonly entries: readonly DecisionListEntry[];
  readonly message: string;
}

function isDecisionFile(name: string): boolean {
  return name.endsWith(DECISION_FILE_SUFFIX);
}

function loadRecord(absPath: string, relPath: string): DecisionListEntry | null {
  try {
    const raw = readFileSync(absPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const validated = validateDecisionRecord(parsed);
    if (!validated.ok || validated.record === undefined) {
      return {
        path: relPath,
        id: "(invalid)",
        decision: `unparseable: ${validated.errors.map((e) => e.message).join("; ")}`,
        confidence: "?",
        timestamp: "",
        revisitTrigger: "",
        activeScopeRefs: [],
        tags: [],
        relatedIssues: [],
      };
    }
    const r: DecisionRecord = validated.record;
    return {
      path: relPath,
      id: r.id,
      decision: r.decision,
      confidence: r.confidence,
      timestamp: r.timestamp,
      revisitTrigger: r.revisitTrigger,
      activeScopeRefs: r.activeScopeRefs,
      tags: r.tags ?? [],
      relatedIssues: r.relatedIssues ?? [],
    };
  } catch (err) {
    return {
      path: relPath,
      id: "(error)",
      decision: err instanceof Error ? err.message : String(err),
      confidence: "?",
      timestamp: "",
      revisitTrigger: "",
      activeScopeRefs: [],
      tags: [],
      relatedIssues: [],
    };
  }
}

function scanDecisionsDir(projectRoot: string): DecisionListEntry[] {
  const dir = resolve(projectRoot, DECISIONS_DIR_REL);
  if (!existsSync(dir)) {
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(dir).filter(isDecisionFile);
  } catch {
    return [];
  }

  const entries: DecisionListEntry[] = [];
  for (const name of names) {
    const abs = join(dir, name);
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    const rel = `${DECISIONS_DIR_REL}/${name}`.replace(/\\/g, "/");
    const entry = loadRecord(abs, rel);
    if (entry !== null) entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.timestamp === b.timestamp) return a.path.localeCompare(b.path);
    return a.timestamp < b.timestamp ? 1 : -1;
  });
  return entries;
}

function matchesFilters(entry: DecisionListEntry, options: DecisionListOptions): boolean {
  if (options.query !== undefined && options.query !== null && options.query.trim().length > 0) {
    const q = options.query.trim().toLowerCase();
    const hay = [
      entry.id,
      entry.decision,
      entry.revisitTrigger,
      ...entry.tags,
      ...entry.activeScopeRefs,
    ]
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (options.scope !== undefined && options.scope !== null && options.scope.trim().length > 0) {
    const s = options.scope.trim().replace(/\\/g, "/").toLowerCase();
    if (!entry.activeScopeRefs.some((r) => r.toLowerCase().includes(s))) return false;
  }
  if (options.issue !== undefined && options.issue !== null) {
    if (!entry.relatedIssues.includes(options.issue)) return false;
  }
  return true;
}

/** List decision records under xbrief/decisions/. */
export function runDecisionList(options: DecisionListOptions = {}): DecisionListResult {
  const projectRootRaw = resolveProjectRoot(options.projectRoot ?? undefined);
  if (projectRootRaw === null) {
    return {
      exitCode: 2,
      entries: [],
      message:
        "Error: could not resolve project root. Pass --project-root or run from a directive repo.\n",
    };
  }
  const projectRoot = resolve(projectRootRaw);
  let entries = scanDecisionsDir(projectRoot).filter((e) => matchesFilters(e, options));

  if (options.limit !== undefined && options.limit !== null && options.limit > 0) {
    entries = entries.slice(0, options.limit);
  }

  if (entries.length === 0) {
    return {
      exitCode: 0,
      entries: [],
      message: `No decision records under ${DECISIONS_DIR_REL}/.\n`,
    };
  }

  const lines = entries.map((e) => {
    const scopes =
      e.activeScopeRefs.length > 0
        ? ` scope=${sanitizeForTerminal(e.activeScopeRefs.join(","))}`
        : "";
    const tags = e.tags.length > 0 ? ` tags=${sanitizeForTerminal(e.tags.join(","))}` : "";
    return (
      `${sanitizeForTerminal(e.path)}\n` +
      `  ${sanitizeForTerminal(e.decision)}\n` +
      `  confidence=${sanitizeForTerminal(e.confidence)} ts=${sanitizeForTerminal(e.timestamp)}` +
      `${scopes}${tags}\n` +
      `  revisit: ${sanitizeForTerminal(e.revisitTrigger)}`
    );
  });

  return {
    exitCode: 0,
    entries,
    message: `${lines.join("\n\n")}\n`,
  };
}

export interface DecisionListCliArgs {
  query?: string;
  scope?: string;
  issue?: number;
  limit?: number;
  json?: boolean;
  projectRoot?: string;
  error?: string;
}

/** Parse argv for decision:list. */
export function parseDecisionListArgs(argv: readonly string[]): DecisionListCliArgs {
  const out: DecisionListCliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") out.json = true;
    else if (arg === "--query" || arg.startsWith("--query=")) {
      if (arg === "--query") out.query = argv[++i];
      else out.query = arg.slice("--query=".length);
    } else if (arg === "--scope" || arg.startsWith("--scope=")) {
      if (arg === "--scope") out.scope = argv[++i];
      else out.scope = arg.slice("--scope=".length);
    } else if (arg === "--issue" || arg.startsWith("--issue=")) {
      const raw = arg === "--issue" ? argv[++i] : arg.slice("--issue=".length);
      if (raw === undefined || raw.trim().length === 0 || raw.startsWith("-")) {
        return { ...out, error: "--issue requires a positive integer" };
      }
      if (!/^\d+$/.test(raw.trim())) {
        return { ...out, error: `--issue must be a positive integer, got: ${raw}` };
      }
      out.issue = Number(raw.trim());
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = arg === "--limit" ? argv[++i] : arg.slice("--limit=".length);
      if (raw === undefined || raw.trim().length === 0 || raw.startsWith("-")) {
        return { ...out, error: "--limit requires a positive integer" };
      }
      if (!/^\d+$/.test(raw.trim()) || Number(raw.trim()) <= 0) {
        return { ...out, error: `--limit must be a positive integer, got: ${raw}` };
      }
      out.limit = Number(raw.trim());
    } else if (arg === "--project-root" || arg.startsWith("--project-root=")) {
      if (arg === "--project-root") out.projectRoot = argv[++i];
      else out.projectRoot = arg.slice("--project-root=".length);
    } else if (arg.startsWith("-")) {
      return { ...out, error: `unrecognized argument: ${arg}` };
    } else if (out.query === undefined) {
      out.query = arg;
    }
  }
  return out;
}

/** CLI entry for decision:list. */
export function decisionListMain(argv: readonly string[]): number {
  const args = parseDecisionListArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`decision:list: ${args.error}\n`);
    return 2;
  }

  const result = runDecisionList({
    projectRoot: args.projectRoot,
    query: args.query,
    scope: args.scope,
    issue: args.issue,
    limit: args.limit,
    json: args.json,
  });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          exit_code: result.exitCode,
          count: result.entries.length,
          entries: result.entries,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(result.message);
  }

  return result.exitCode;
}
