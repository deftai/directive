#!/usr/bin/env node
/**
 * CLI for scope:record-approved-scope (#3205).
 *
 * Deposits a human-origin approved-scope digest under
 * `.deft/approved-scope/<plan-id>.json` so verify:scope-provenance can
 * authorize pending→active and operator-approved expansion without same-PR
 * self-authorization.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { scopeProvenance, slice } from "@deftai/directive-core";
import { isDirectEntrypoint } from "./entrypoint.js";
import {
  type HumanPresenceMintSeams,
  refuseMintWhileUatActive,
  refuseNonInteractiveMint,
  resolveHumanPresenceMintSeams,
} from "./human-presence-mint.js";

/** True when `candidate` is the same as or a descendant of `root` after realpath. */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  let rootReal: string;
  let candReal: string;
  try {
    rootReal = realpathSync(root);
    // realpathSync fails if path does not exist; fall back to resolve for missing targets
    candReal = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
  } catch {
    return false;
  }
  const rel = relative(rootReal, candReal);
  if (rel === "") return true;
  if (
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\")
  ) {
    return false;
  }
  // Absolute relative() means different drive/root (win32)
  if (resolve(rel) === rel && rel.includes(":")) return false;
  return !rel.startsWith("..");
}

const { isHumanApprovalStamp, mintApprovedScopeArtifacts } = scopeProvenance;

export interface ParsedArgs {
  projectRoot: string;
  xbriefPath: string;
  actor: string;
  kind: string;
  /** Optional override for recorded xbriefRelPath (defaults: pending→active map). */
  xbriefRelPath: string;
  quiet: boolean;
  /** Explicit operator confirm for the #3110 human-presence mint (#3384). */
  confirm: boolean;
  /** Optional owner/name seed for preimage approvedRepos (#3385 R5). */
  repo: string;
  error?: string;
}

function usage(): string {
  return (
    "usage: scope:record-approved-scope -- <xbrief-path> --actor <name> --confirm " +
    "[--kind operator] [--project-root <dir>] [--xbrief-rel-path <posix>] [--repo owner/name] [--quiet]\n" +
    "  Writes .deft/approved-scope/<plan-id>.json and <plan-id>.intent.json (#3205 / #3384 / #3385).\n" +
    "  --actor is display only and never authorizes mint. Mint requires a real TTY, " +
    "controlling terminal, --confirm, and typed phrase mint (#3110). Agent/CI shells refuse."
  );
}

/**
 * Map pending/ → active/ for path-bound approval records.
 * Returns null when the source cannot be expressed as a repo-relative path under projectRoot
 * (absolute outside-root paths must not be stamped into xbriefRelPath — #3205 Greptile).
 */
export function resolveApprovalXbriefRelPath(
  sourceRelOrAbs: string,
  projectRoot: string,
  override?: string,
): string | null {
  if (override !== undefined && override.trim().length > 0) {
    const o = override.replace(/\\/g, "/").replace(/^\.\//, "");
    if (o.startsWith("/") || /^[A-Za-z]:\//.test(o)) return null;
    return o;
  }
  const root = resolve(projectRoot);
  const abs = resolve(
    sourceRelOrAbs.includes(":") ||
      sourceRelOrAbs.startsWith("/") ||
      sourceRelOrAbs.startsWith("\\")
      ? sourceRelOrAbs
      : join(root, sourceRelOrAbs),
  );
  // Lexical + realpath containment (symlink to outside root must fail closed — #3205 Greptile).
  if (!isPathInsideRoot(root, abs)) {
    return null;
  }
  let rel = relative(root, abs).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("../") || rel === "..") {
    return null;
  }
  try {
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink() && !isPathInsideRoot(root, abs)) {
      return null;
    }
  } catch {
    return null;
  }
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
    confirm: false,
    repo: "",
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { ...parsed, error: usage() };
    }
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--confirm") {
      parsed.confirm = true;
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
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --repo: expected one argument" };
      }
      parsed.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
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

export function run(argv: string[], seams: HumanPresenceMintSeams = {}): number {
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
  if (!isPathInsideRoot(projectRoot, fullPath)) {
    process.stderr.write(
      "scope_record_approved_scope: xBRIEF path escapes --project-root " +
        "(symlink or absolute outside-root targets refused) (#3205).\n",
    );
    return 2;
  }
  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf8");
  } catch (err: unknown) {
    process.stderr.write(`scope_record_approved_scope: failed to read xBRIEF: ${String(err)}\n`);
    return 2;
  }
  const parsed = scopeProvenance.parseJsonRejectingDuplicateKeys(raw);
  if (!parsed.ok) {
    process.stderr.write(`scope_record_approved_scope: ${parsed.error}\n`);
    return 2;
  }
  const payload = parsed.value;

  const verb = "scope:record-approved-scope";
  const uatBlocked = refuseMintWhileUatActive(verb, projectRoot);
  if (uatBlocked !== null) return uatBlocked;
  const resolved = resolveHumanPresenceMintSeams(seams);
  const mintBlocked = refuseNonInteractiveMint({
    verb,
    confirm: args.confirm,
    isTty: resolved.isTty,
    environ: resolved.environ,
    hasControllingTerminal: resolved.hasControllingTerminal,
    readInteractiveConfirm: resolved.readInteractiveConfirm,
  });
  if (mintBlocked !== null) return mintBlocked;

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
  if (xbriefRelPath === null) {
    process.stderr.write(
      "scope_record_approved_scope: xBRIEF path must resolve under --project-root " +
        "(repo-relative path required for approval binding) (#3205).\n",
    );
    return 2;
  }
  const repoSeed = slice.resolveProjectRepo(
    args.repo.trim().length > 0 ? args.repo.trim() : undefined,
    projectRoot,
  );
  // Mint writes record + preimage as one fail-closed pair. A dest-write
  // failure restores the prior pair or leaves neither dest (#3385 residual).
  let minted: ReturnType<typeof mintApprovedScopeArtifacts>;
  try {
    minted = mintApprovedScopeArtifacts({
      xbriefRelPath,
      payload,
      rawText: raw,
      projectRoot,
      humanApproval: stamp,
      extract: {
        projectRoot,
        approvedReposSeed: repoSeed !== null ? [repoSeed] : [],
      },
    });
  } catch (err: unknown) {
    process.stderr.write(`scope_record_approved_scope: ${String(err)}\n`);
    return 1;
  }
  const { record, recordPath, intentPath } = minted;
  if (!args.quiet) {
    process.stdout.write(
      `scope_record_approved_scope: wrote ${recordPath}\n` +
        `  preimage: ${intentPath}\n` +
        `  planId: ${record.planId}\n` +
        `  xbriefRelPath: ${record.xbriefRelPath}\n` +
        `  fileScopeDigest: ${record.fileScopeDigest}\n` +
        `  intentDigest: ${record.intentDigest ?? ""}\n` +
        `  paths: ${record.fileScope.length}\n` +
        `  humanApproval: ${stamp.kind}/${stamp.actor}\n` +
        "  Read the preimage before you commit. That file is the approved intent (#3385).\n" +
        "  Next: commit record + preimage on the merge base (or a prior PR) before " +
        "activation/expansion in the implementation change set (#3205 / #3385).\n",
    );
  }
  return 0;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
