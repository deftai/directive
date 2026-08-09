#!/usr/bin/env node
/**
 * CLI for scope:record-approved-scope (#3205).
 *
 * Deposits a human-origin approved-scope digest under
 * `.deft/approved-scope/<plan-id>.json` so verify:scope-provenance can
 * authorize pending→active and operator-approved expansion without same-PR
 * self-authorization.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { scopeProvenance } from "@deftai/directive-core";
import { isDirectEntrypoint } from "./entrypoint.js";

const { buildApprovedScopeRecord, isHumanApprovalStamp, writeApprovedScopeRecord } =
  scopeProvenance;

export interface ParsedArgs {
  projectRoot: string;
  xbriefPath: string;
  actor: string;
  kind: string;
  /** Optional override for recorded xbriefRelPath (defaults: pending→active map). */
  xbriefRelPath: string;
  quiet: boolean;
  error?: string;
}

function usage(): string {
  return (
    "usage: scope:record-approved-scope -- <xbrief-path> --actor <name> " +
    "[--kind operator] [--project-root <dir>] [--xbrief-rel-path <posix>] [--quiet]\n" +
    "  Writes .deft/approved-scope/<plan-id>.json with a humanApproval stamp (#3205).\n" +
    "  Agent-shaped stamps are refused. Path-binds to xbrief/active/ by default when " +
    "the source is under pending/ or active/."
  );
}

/** Map pending/ → active/ for path-bound approval records. */
export function resolveApprovalXbriefRelPath(
  sourceRelOrAbs: string,
  projectRoot: string,
  override?: string,
): string {
  if (override !== undefined && override.trim().length > 0) {
    return override.replace(/\\/g, "/").replace(/^\.\//, "");
  }
  const root = resolve(projectRoot);
  const abs = resolve(sourceRelOrAbs);
  let rel = abs.startsWith(root)
    ? abs.slice(root.length).replace(/\\/g, "/").replace(/^\//, "")
    : sourceRelOrAbs.replace(/\\/g, "/").replace(/^\.\//, "");
  // Normalize pending → active for future-active binding (issue #3205 multi-PR).
  if (rel.startsWith("xbrief/pending/")) {
    rel = `xbrief/active/${basename(rel)}`;
  } else if (rel.startsWith("vbrief/pending/")) {
    rel = `vbrief/active/${basename(rel)}`;
  }
  return rel;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    xbriefPath: "",
    actor: "",
    kind: "operator",
    xbriefRelPath: "",
    quiet: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { ...parsed, error: usage() };
    }
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--actor") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --actor: expected one argument" };
      }
      parsed.actor = value;
      i += 1;
    } else if (arg?.startsWith("--actor=")) {
      parsed.actor = arg.slice("--actor=".length);
    } else if (arg === "--kind") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --kind: expected one argument" };
      }
      parsed.kind = value;
      i += 1;
    } else if (arg?.startsWith("--kind=")) {
      parsed.kind = arg.slice("--kind=".length);
    } else if (arg === "--xbrief-rel-path") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --xbrief-rel-path: expected one argument" };
      }
      parsed.xbriefRelPath = value;
      i += 1;
    } else if (arg?.startsWith("--xbrief-rel-path=")) {
      parsed.xbriefRelPath = arg.slice("--xbrief-rel-path=".length);
    } else if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }
  if (positionals.length === 0) {
    return { ...parsed, error: `missing xBRIEF path\n${usage()}` };
  }
  if (positionals.length > 1) {
    return { ...parsed, error: `unexpected extra args: ${positionals.slice(1).join(" ")}` };
  }
  parsed.xbriefPath = positionals[0] ?? "";
  if (parsed.actor.trim().length === 0) {
    return {
      ...parsed,
      error: `argument --actor is required (human operator identity)\n${usage()}`,
    };
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`scope_record_approved_scope: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const xbriefAbs = resolve(projectRoot, args.xbriefPath);
  if (!existsSync(xbriefAbs)) {
    // Also try absolute path as given
    const alt = resolve(args.xbriefPath);
    if (!existsSync(alt)) {
      process.stderr.write(`scope_record_approved_scope: xBRIEF not found: ${args.xbriefPath}\n`);
      return 2;
    }
  }
  const fullPath = existsSync(xbriefAbs) ? xbriefAbs : resolve(args.xbriefPath);
  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf8");
  } catch (err: unknown) {
    process.stderr.write(`scope_record_approved_scope: failed to read xBRIEF: ${String(err)}\n`);
    return 2;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    process.stderr.write("scope_record_approved_scope: xBRIEF is not valid JSON\n");
    return 2;
  }

  const stamp = {
    kind: args.kind.trim(),
    actor: args.actor.trim(),
    mintedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    mintedVia: "scope:record-approved-scope",
  };
  if (!isHumanApprovalStamp(stamp)) {
    process.stderr.write(
      "scope_record_approved_scope: refused agent/non-human stamp " +
        `(kind=${stamp.kind}, actor=${stamp.actor}). Use a human operator actor ` +
        "and kind in {operator,human,user,cli,github-user,interactive,renewed-approval} (#3205).\n",
    );
    return 1;
  }

  const xbriefRelPath = resolveApprovalXbriefRelPath(
    fullPath,
    projectRoot,
    args.xbriefRelPath.length > 0 ? args.xbriefRelPath : undefined,
  );
  // Prefer project-relative path for binding even when source is absolute outside root.
  const record = buildApprovedScopeRecord({
    xbriefRelPath,
    payload,
    humanApproval: stamp,
    xbriefRawText: raw,
  });
  const outPath = writeApprovedScopeRecord(projectRoot, record);
  if (!args.quiet) {
    process.stdout.write(
      `scope_record_approved_scope: wrote ${outPath}\n` +
        `  planId: ${record.planId}\n` +
        `  xbriefRelPath: ${record.xbriefRelPath}\n` +
        `  fileScopeDigest: ${record.fileScopeDigest}\n` +
        `  paths: ${record.fileScope.length}\n` +
        `  humanApproval: ${stamp.kind}/${stamp.actor}\n` +
        "  Next: commit this file on the merge base (or a prior PR) before " +
        "activation/expansion in the implementation change set (#3205).\n",
    );
  }
  return 0;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
