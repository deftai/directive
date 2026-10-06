/**
 * Optional migrate: map unambiguous leading High/Medium/Low Confidence prose
 * to the enum and move residual into ConfidenceNote (#5385 Prefer-A Bound).
 *
 * Default is dry-run. Apply requires --apply. Ambiguous prefixes decline.
 * Historical trees are never rewritten by validate.
 */
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  containedChmod,
  containedRemove,
  containedRename,
  containedWrite,
  fsyncContainedDirectory,
} from "../fs/contained-write.js";
import { assertDirectoryNotSymlink } from "../fs/projection-containment.js";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import {
  CONFIDENCE_MIGRATE_COMMAND,
  CONFIDENCE_VALUES,
  extractLeadingConfidenceToken,
  isCanonicalConfidence,
} from "../vbrief-validate/provenance.js";

type JsonObject = Record<string, unknown>;

export { CONFIDENCE_MIGRATE_COMMAND };

export interface ConfidenceMigrateHit {
  readonly path: string;
  readonly from: string;
  readonly to: string;
  readonly residual: string;
  readonly noteCollision: boolean;
  readonly declined?: string;
}

export interface ConfidenceMigrateResult {
  readonly scanned: number;
  readonly mapped: readonly ConfidenceMigrateHit[];
  readonly declined: readonly ConfidenceMigrateHit[];
  readonly changed: readonly string[];
  readonly dryRun: boolean;
}

export interface ParsedMigrateConfidenceArgs {
  projectRoot: string;
  apply: boolean;
  includeHistorical: boolean;
  error?: string;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CorpusWalk {
  files: string[];
}

function collectVbriefFiles(dir: string, acc: CorpusWalk = { files: [] }): CorpusWalk {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let isLink = entry.isSymbolicLink();
    let info: ReturnType<typeof lstatSync> | undefined;
    if (!isLink) {
      try {
        info = lstatSync(full);
        isLink = info.isSymbolicLink();
      } catch {
        continue;
      }
    }
    if (isLink) {
      continue;
    }
    const isDir = entry.isDirectory() || info?.isDirectory() === true;
    const isFile = entry.isFile() || info?.isFile() === true;
    if (isDir) {
      collectVbriefFiles(full, acc);
    } else if (isFile && hasArtifactSuffix(entry.name)) {
      acc.files.push(full);
    }
  }
  return acc;
}

function selectFallbackCorpusDir(projectRoot: string): string | null {
  const xbriefDir = join(projectRoot, "xbrief");
  const legacyDir = join(projectRoot, "vbrief");
  const xbriefExists = existsSync(xbriefDir);
  // Prefer an inhabited xbrief/ so an empty stub does not hide legacy vbrief/ (#5385 Greptile P2).
  if (xbriefExists && collectVbriefFiles(xbriefDir).files.length > 0) {
    return xbriefDir;
  }
  if (existsSync(legacyDir)) {
    return legacyDir;
  }
  return xbriefExists ? xbriefDir : null;
}

function resolveCorpusDir(projectRoot: string): string | null {
  let corpusDir: string;
  try {
    corpusDir = resolveLifecycleRoot(projectRoot);
  } catch {
    const fallback = selectFallbackCorpusDir(projectRoot);
    if (fallback === null) {
      return null;
    }
    corpusDir = fallback;
  }
  try {
    assertDirectoryNotSymlink(projectRoot, corpusDir, "lifecycle root");
  } catch {
    // Symlink escape must not fall through to reads/prints (Greptile P1).
    return null;
  }
  return corpusDir;
}

function isHistoricalFolder(relPath: string): boolean {
  return (
    relPath.startsWith("completed/") ||
    relPath.startsWith("cancelled/") ||
    relPath.includes("/completed/") ||
    relPath.includes("/cancelled/")
  );
}

function migrateAtomicTempPath(targetPath: string): string {
  return join(dirname(targetPath), `${basename(targetPath)}.deft-${process.pid}.tmp`);
}

/** Contained temp+rename so a failed replace cannot truncate the live brief. */
function containedReplaceAtomic(
  root: string,
  target: string,
  data: string,
): { ok: true } | { ok: false } {
  const temporary = migrateAtomicTempPath(target);
  let preservedMode: number | undefined;
  try {
    preservedMode = lstatSync(target).mode & 0o777;
  } catch {
    preservedMode = undefined;
  }
  // containedWrite opens with 0o644; tighten umask so a 0600 brief is never
  // briefly world-readable between create and chmod (Greptile P1).
  const previousUmask = process.umask(0o077);
  try {
    try {
      containedWrite({
        root,
        target: temporary,
        data,
        mode: "replace",
        mutation: { path: target },
      });
    } finally {
      process.umask(previousUmask);
    }
    if (preservedMode !== undefined) {
      containedChmod({ root, target: temporary, mode: preservedMode, mutation: false });
    }
    containedRename({
      root,
      from: temporary,
      to: target,
      mutation: false,
    });
    if (preservedMode !== undefined) {
      containedChmod({ root, target, mode: preservedMode, mutation: false });
    }
    fsyncContainedDirectory(dirname(target));
    return { ok: true };
  } catch {
    try {
      containedRemove({ root, target: temporary, mutation: false });
    } catch {
      /* best-effort temp cleanup */
    }
    return { ok: false };
  }
}

function mapConfidenceNarratives(
  narratives: JsonObject,
):
  | { kind: "mapped"; from: string; to: string; residual: string; noteCollision: boolean }
  | { kind: "declined"; from: string; reason: string }
  | { kind: "skip" } {
  if (!("Confidence" in narratives)) {
    return { kind: "skip" };
  }
  const confidence = narratives.Confidence;
  if (typeof confidence !== "string") {
    return { kind: "skip" };
  }
  if (isCanonicalConfidence(confidence)) {
    return { kind: "skip" };
  }
  const extracted = extractLeadingConfidenceToken(confidence);
  if (extracted === null) {
    return {
      kind: "declined",
      from: confidence,
      reason: "ambiguous or non-leading-token Confidence; no automatic rewrite",
    };
  }
  const noteCollision =
    extracted.residual.length > 0 &&
    "ConfidenceNote" in narratives &&
    narratives.ConfidenceNote !== extracted.residual;
  return {
    kind: "mapped",
    from: confidence,
    to: extracted.confidence,
    residual: extracted.residual,
    noteCollision,
  };
}

export function migrateConfidenceCorpus(
  projectRoot: string,
  options: { apply?: boolean; includeHistorical?: boolean } = {},
): ConfidenceMigrateResult {
  const root = resolve(projectRoot);
  const dryRun = options.apply !== true;
  const includeHistorical = options.includeHistorical === true;
  const corpusDir = resolveCorpusDir(root);
  if (corpusDir === null) {
    return { scanned: 0, mapped: [], declined: [], changed: [], dryRun };
  }

  const mapped: ConfidenceMigrateHit[] = [];
  const declined: ConfidenceMigrateHit[] = [];
  const changed: string[] = [];
  let scanned = 0;

  for (const file of collectVbriefFiles(corpusDir).files) {
    const relPath = relative(root, file).replace(/\\/g, "/");
    if (!includeHistorical && isHistoricalFolder(relPath)) {
      continue;
    }
    scanned += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.plan)) {
      continue;
    }
    const narratives = parsed.plan.narratives;
    if (!isPlainObject(narratives)) {
      continue;
    }
    const decision = mapConfidenceNarratives(narratives);
    if (decision.kind === "skip") {
      continue;
    }
    if (decision.kind === "declined") {
      declined.push({
        path: relPath,
        from: decision.from,
        to: "",
        residual: "",
        noteCollision: false,
        declined: decision.reason,
      });
      continue;
    }
    if (decision.noteCollision) {
      declined.push({
        path: relPath,
        from: decision.from,
        to: decision.to,
        residual: decision.residual,
        noteCollision: true,
        declined: "ConfidenceNote already set to a different value",
      });
      continue;
    }
    mapped.push({
      path: relPath,
      from: decision.from,
      to: decision.to,
      residual: decision.residual,
      noteCollision: false,
    });
    if (dryRun) {
      continue;
    }
    narratives.Confidence = decision.to;
    if (decision.residual.length > 0) {
      narratives.ConfidenceNote = decision.residual;
    }
    const replaced = containedReplaceAtomic(root, file, `${JSON.stringify(parsed, null, 2)}\n`);
    if (replaced.ok) {
      changed.push(relPath);
    } else {
      declined.push({
        path: relPath,
        from: decision.from,
        to: decision.to,
        residual: decision.residual,
        noteCollision: false,
        declined: "write failed",
      });
    }
  }

  return { scanned, mapped, declined, changed: changed.sort(), dryRun };
}

export function parseArgs(argv: readonly string[]): ParsedMigrateConfidenceArgs {
  let projectRoot = ".";
  let apply = false;
  let includeHistorical = false;
  let dryRunFlag = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          apply,
          includeHistorical,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--include-historical") {
      includeHistorical = true;
    } else if (arg === "--dry-run") {
      dryRunFlag = true;
    } else if (arg !== "--help" && arg !== "-h") {
      return { projectRoot, apply, includeHistorical, error: `unrecognized argument: ${arg}` };
    }
  }
  if (apply && dryRunFlag) {
    return {
      projectRoot,
      apply: false,
      includeHistorical,
      error: "conflicting flags: --apply and --dry-run",
    };
  }
  if (dryRunFlag) {
    apply = false;
  }
  return { projectRoot, apply, includeHistorical };
}

const HELP =
  `Usage: ${CONFIDENCE_MIGRATE_COMMAND} [--project-root <path>] [--apply] [--include-historical]\n` +
  `Map unambiguous leading High/Medium/Low Confidence prose to ${CONFIDENCE_VALUES.join("|")} ` +
  "and move residual text into ConfidenceNote. Default is dry-run; historical folders " +
  "(completed/cancelled) are excluded unless --include-historical.\n";

export function run(argv: readonly string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`migrate:confidence: ${args.error}\n`);
    return 2;
  }

  const result = migrateConfidenceCorpus(args.projectRoot, {
    apply: args.apply,
    includeHistorical: args.includeHistorical,
  });
  const mode = result.dryRun ? "dry-run" : "apply";
  process.stdout.write(
    `migrate:confidence (${mode}): scanned ${result.scanned}; ` +
      `mapped ${result.mapped.length}; declined ${result.declined.length}` +
      (result.dryRun ? "" : `; wrote ${result.changed.length}`) +
      "\n",
  );
  for (const hit of result.mapped) {
    const residual =
      hit.residual.length > 0 ? ` residual→ConfidenceNote ${JSON.stringify(hit.residual)}` : "";
    process.stdout.write(`  map ${hit.path}: ${JSON.stringify(hit.from)} → ${hit.to}${residual}\n`);
  }
  for (const hit of result.declined) {
    process.stdout.write(
      `  decline ${hit.path}: ${JSON.stringify(hit.from)} (${hit.declined ?? "declined"})\n`,
    );
  }
  if (result.dryRun && result.mapped.length > 0) {
    process.stdout.write(
      "  Re-run with --apply to write. Add --include-historical for terminal folders.\n",
    );
  }
  return result.declined.length > 0 && !result.dryRun ? 1 : 0;
}

export function mainEntry(argv: readonly string[]): number {
  return run(argv);
}
