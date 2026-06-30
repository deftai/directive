import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { checkGitClean } from "../migrate-preflight/index.js";
import { agentsRefreshPlan } from "../platform/agents-md.js";
import {
  LEGACY_ARTIFACT_DIR,
  LEGACY_ARTIFACT_SUFFIX,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
} from "./constants.js";
import { detectLegacyVbriefLayout } from "./detect.js";
import { renderXbriefMigrationLine, xbriefMigrationGuidance } from "./signpost.js";
import type { JsonObject } from "./transforms.js";
import { rewriteEmbeddedTokens, transformArtifactV06ToV08Transactional } from "./transforms.js";

export interface XbriefMigrationArgs {
  readonly projectRoot: string;
  readonly frameworkRoot?: string;
  readonly force?: boolean;
}

export interface XbriefMigrationIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

export type XbriefMigrationOutcome =
  | { readonly kind: "noop"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "migrated"; readonly backupDir: string; readonly files: number }
  | { readonly kind: "config"; readonly message: string };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectFiles(root: string, acc: string[] = []): string[] {
  if (!isDirectory(root)) {
    return acc;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

function mapRelativePath(relativePath: string): string {
  return relativePath
    .split(/[/\\]/)
    .map((segment) =>
      segment.endsWith(LEGACY_ARTIFACT_SUFFIX)
        ? segment.slice(0, -LEGACY_ARTIFACT_SUFFIX.length) + MIGRATED_ARTIFACT_SUFFIX
        : segment,
    )
    .join("/");
}

function writeMigratedFile(srcPath: string, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true });
  if (srcPath.endsWith(LEGACY_ARTIFACT_SUFFIX)) {
    const parsed = JSON.parse(readFileSync(srcPath, "utf8")) as JsonObject;
    const result = transformArtifactV06ToV08Transactional(parsed);
    if (!result.ok) {
      throw new Error(result.error);
    }
    writeFileSync(destPath, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");
    return;
  }

  const raw = readFileSync(srcPath, "utf8");
  writeFileSync(destPath, rewriteEmbeddedTokens(raw), "utf8");
}

function backupLegacyTree(projectRoot: string, legacyDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(projectRoot, ".deft", `xbrief-migrate-backup-${stamp}`);
  mkdirSync(backupRoot, { recursive: true });
  cpSync(legacyDir, join(backupRoot, LEGACY_ARTIFACT_DIR), { recursive: true });
  return backupRoot;
}

function migrateLegacyTree(
  projectRoot: string,
  legacyDir: string,
): { backupDir: string; files: number } {
  const migratedDir = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  if (existsSync(migratedDir)) {
    throw new Error(
      `refusing to migrate: '${MIGRATED_ARTIFACT_DIR}/' already exists alongside '${LEGACY_ARTIFACT_DIR}/'`,
    );
  }

  const backupDir = backupLegacyTree(projectRoot, legacyDir);
  const stagedDir = join(projectRoot, `.${MIGRATED_ARTIFACT_DIR}.migrate-staging`);
  if (existsSync(stagedDir)) {
    rmSync(stagedDir, { recursive: true, force: true });
  }
  mkdirSync(stagedDir, { recursive: true });

  const files = collectFiles(legacyDir);
  try {
    for (const srcPath of files) {
      const rel = relative(legacyDir, srcPath);
      const destPath = join(stagedDir, mapRelativePath(rel));
      writeMigratedFile(srcPath, destPath);
    }
    renameOrReplace(stagedDir, migratedDir);
    rmSync(legacyDir, { recursive: true, force: true });
    return { backupDir, files: files.length };
  } catch (err) {
    rmSync(stagedDir, { recursive: true, force: true });
    throw err;
  }
}

function renameOrReplace(src: string, dest: string): void {
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  cpSync(src, dest, { recursive: true });
  rmSync(src, { recursive: true, force: true });
}

function runAgentsRefresh(
  projectRoot: string,
  frameworkRoot: string | undefined,
  io: XbriefMigrationIo,
): number {
  const plan = agentsRefreshPlan(projectRoot, { frameworkRoot }) as Record<string, unknown>;
  const state = String(plan.state ?? "unknown");
  if (state === "current") {
    io.writeOut("AGENTS.md managed section is current — no changes.\n");
    return 0;
  }
  if (state === "template-missing" || state === "template-malformed" || state === "unreadable") {
    io.writeErr(`agents:refresh failed: ${state}\n`);
    return 2;
  }
  const newContent = plan.new_content;
  if (typeof newContent !== "string") {
    io.writeErr("agents:refresh failed: plan produced no new_content\n");
    return 2;
  }
  const path = String(plan.path ?? join(projectRoot, "AGENTS.md"));
  writeFileSync(path, newContent, "utf8");
  io.writeOut(`AGENTS.md updated (state=${state}).\n`);
  return 0;
}

/** Core orchestrator for the consumer xbrief rename (#2110). */
export function runXbriefMigration(
  args: XbriefMigrationArgs,
  _io: XbriefMigrationIo,
): XbriefMigrationOutcome {
  const projectRoot = resolve(args.projectRoot);
  const detection = detectLegacyVbriefLayout(projectRoot);
  if (!detection.legacyLayout) {
    return {
      kind: "noop",
      message: "Project is already on the xbrief layout — nothing to migrate.",
    };
  }

  const legacyDir = join(projectRoot, LEGACY_ARTIFACT_DIR);
  if (!isDirectory(legacyDir)) {
    return {
      kind: "config",
      message: `Legacy markers detected but '${LEGACY_ARTIFACT_DIR}/' directory is missing.`,
    };
  }

  if (!args.force) {
    const git = checkGitClean(projectRoot);
    if (git.status === "WARN") {
      return {
        kind: "refused",
        message: `${git.message} ${xbriefMigrationGuidance()} Pass --force to override.`,
      };
    }
  }

  try {
    const { backupDir, files } = migrateLegacyTree(projectRoot, legacyDir);
    return { kind: "migrated", backupDir, files };
  } catch (err) {
    return {
      kind: "config",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Map a migration outcome to a process exit code and emit operator guidance. */
export function emitXbriefMigration(
  outcome: XbriefMigrationOutcome,
  io: XbriefMigrationIo,
  options: { signpostOnly?: boolean; projectRoot?: string } = {},
): number {
  if (options.signpostOnly) {
    const root = options.projectRoot ?? process.cwd();
    io.writeOut(`${renderXbriefMigrationLine(root)}\n`);
    return 0;
  }

  switch (outcome.kind) {
    case "noop":
      io.writeOut(`${outcome.message}\n`);
      return 0;
    case "refused":
      io.writeErr(`migrate:xbrief refused: ${outcome.message}\n`);
      return 1;
    case "config":
      io.writeErr(`migrate:xbrief: ${outcome.message}\n`);
      return 2;
    case "migrated":
      io.writeOut(
        `Migrated ${outcome.files} file(s) from ${LEGACY_ARTIFACT_DIR}/ to ${MIGRATED_ARTIFACT_DIR}/.\n` +
          `Backup written to ${outcome.backupDir}.\n`,
      );
      return 0;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/** End-to-end migrate:xbrief handler including optional agents:refresh (#2110). */
export function runXbriefMigrationCli(args: XbriefMigrationArgs, io: XbriefMigrationIo): number {
  const outcome = runXbriefMigration(args, io);
  const code = emitXbriefMigration(outcome, io);
  if (code !== 0 || outcome.kind !== "migrated") {
    return code;
  }
  return runAgentsRefresh(resolve(args.projectRoot), args.frameworkRoot, io);
}
