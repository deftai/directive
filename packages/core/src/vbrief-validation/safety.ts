import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type {
  BackupRecord,
  FileModification,
  JsonObject,
  RenameRecord,
  RollbackOptions,
  SafetyManifestData,
} from "./types.js";

export const PREMIGRATE_SUFFIX = ".premigrate";
export const SAFETY_MANIFEST_NAME = "safety-manifest.json";
export const MIGRATION_DIR = "migration";
export const LEGACY_DIR = "legacy";

const ROOT_MD_INPUTS = ["SPECIFICATION.md", "PROJECT.md", "ROADMAP.md", "PRD.md"] as const;
const VBRIEF_JSON_INPUTS = ["specification.vbrief.json", "plan.vbrief.json"] as const;
const DEPRECATION_SENTINEL_DEFAULT = "<!-- deft:deprecated-redirect -->";

export class SafetyManifest {
  version: string;
  migration_timestamp: string;
  backups: BackupRecord[];
  created_files: string[];
  created_dirs: string[];
  post_migration_stub_hashes: Record<string, string>;
  renames: RenameRecord[];
  file_modifications: FileModification[];

  constructor(data: Partial<SafetyManifestData> = {}) {
    this.version = data.version ?? "1";
    this.migration_timestamp = data.migration_timestamp ?? "";
    this.backups = data.backups ?? [];
    this.created_files = data.created_files ?? [];
    this.created_dirs = data.created_dirs ?? [];
    this.post_migration_stub_hashes = data.post_migration_stub_hashes ?? {};
    this.renames = data.renames ?? [];
    this.file_modifications = data.file_modifications ?? [];
  }

  toJson(): string {
    const payload = {
      version: this.version,
      migration_timestamp: this.migration_timestamp,
      backups: this.backups,
      created_files: [...this.created_files],
      created_dirs: [...this.created_dirs],
      post_migration_stub_hashes: { ...this.post_migration_stub_hashes },
      renames: this.renames,
      file_modifications: this.file_modifications,
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  static fromJson(raw: string): SafetyManifest {
    const data = JSON.parse(raw) as JsonObject;
    const backups = ((data.backups as unknown[]) ?? []).map((b) => b as BackupRecord);
    const renames = ((data.renames as unknown[]) ?? []).map((r) => r as RenameRecord);
    const fileMods = ((data.file_modifications as unknown[]) ?? []).map(
      (m) => m as FileModification,
    );
    return new SafetyManifest({
      version: String(data.version ?? "1"),
      migration_timestamp: String(data.migration_timestamp ?? ""),
      backups,
      created_files: (data.created_files as string[]) ?? [],
      created_dirs: (data.created_dirs as string[]) ?? [],
      post_migration_stub_hashes: (data.post_migration_stub_hashes as Record<string, string>) ?? {},
      renames,
      file_modifications: fileMods,
    });
  }

  currentPathFor(original: string): string {
    let resolved = original;
    for (let hop = 0; hop < this.renames.length + 1; hop += 1) {
      let target = resolved;
      for (const record of this.renames) {
        if (record.original === resolved) {
          target = record.current;
        }
      }
      if (target === resolved) {
        break;
      }
      resolved = target;
    }
    return resolved;
  }
}

export function premigrateSibling(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? path;
  const dir = dirname(path);
  if (name.includes(".")) {
    const dot = name.indexOf(".");
    const stem = name.slice(0, dot);
    const rest = name.slice(dot + 1);
    return join(dir, `${stem}${PREMIGRATE_SUFFIX}.${rest}`);
  }
  return join(dir, `${name}${PREMIGRATE_SUFFIX}`);
}

function isDeprecationStub(path: string, sentinel = DEPRECATION_SENTINEL_DEFAULT): boolean {
  try {
    const head = readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, 4096);
    return head.includes(sentinel);
  } catch {
    return false;
  }
}

function rel(projectRoot: string, target: string): string {
  try {
    return relative(projectRoot, target).split("\\").join("/");
  } catch {
    return target.split("\\").join("/");
  }
}

export function planBackups(
  projectRoot: string,
  options: { deprecationSentinel?: string } = {},
): readonly [string, string][] {
  const sentinel = options.deprecationSentinel ?? DEPRECATION_SENTINEL_DEFAULT;
  const pairs: [string, string][] = [];
  for (const name of ROOT_MD_INPUTS) {
    const src = join(projectRoot, name);
    try {
      if (statSync(src).isFile() && !isDeprecationStub(src, sentinel)) {
        pairs.push([src, premigrateSibling(src)]);
      }
    } catch {
      // skip missing
    }
  }
  const vbriefDir = join(projectRoot, "vbrief");
  for (const name of VBRIEF_JSON_INPUTS) {
    const src = join(vbriefDir, name);
    try {
      if (statSync(src).isFile() && !isDeprecationStub(src, sentinel)) {
        pairs.push([src, premigrateSibling(src)]);
      }
    } catch {
      // skip missing
    }
  }
  return pairs;
}

export function writeBackups(
  projectRoot: string,
  pairs: readonly [string, string][],
  options: { dryRun: boolean },
): readonly [BackupRecord[], string[]] {
  const records: BackupRecord[] = [];
  const actions: string[] = [];
  for (const [src, dst] of pairs) {
    const raw = readFileSync(src);
    const digest = createHash("sha256").update(raw).digest("hex");
    const size = raw.length;
    const relSrc = rel(projectRoot, src);
    const relDst = rel(projectRoot, dst);
    if (!options.dryRun) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
    records.push({
      source: relSrc,
      backup: relDst,
      source_sha256: digest,
      size_bytes: size,
    });
    const tag = options.dryRun ? "DRYRUN BACKUP" : "BACKUP";
    actions.push(`${tag} ${relSrc} -> ${relDst} (${size} bytes)`);
  }
  return [records, actions];
}

export function isTreeDirty(projectRoot: string): boolean {
  try {
    const result = spawnSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error || result.status !== 0) {
      return false;
    }
    return Boolean(String(result.stdout ?? "").trim());
  } catch {
    return false;
  }
}

export function dirtyTreeRefusalMessage(): string {
  return (
    "ERROR: Working tree is not clean. Migration is destructive; commit " +
    "or stash your changes first, then re-run.\n" +
    "       Bypass with: task migrate:vbrief -- --force (not recommended)"
  );
}

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, "vbrief", MIGRATION_DIR, SAFETY_MANIFEST_NAME);
}

export function writeSafetyManifest(
  projectRoot: string,
  manifest: SafetyManifest,
  options: { dryRun: boolean },
): string {
  const target = manifestPath(projectRoot);
  const relTarget = rel(projectRoot, target);
  if (options.dryRun) {
    return `DRYRUN WRITE ${relTarget} (safety manifest)`;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, manifest.toJson(), "utf8");
  return `WRITE ${relTarget} (safety manifest, ${manifest.backups.length} backup(s))`;
}

export function loadSafetyManifest(projectRoot: string): SafetyManifest | null {
  const path = manifestPath(projectRoot);
  try {
    if (!statSync(path).isFile()) {
      return null;
    }
    return SafetyManifest.fromJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function sha256Of(path: string): string {
  try {
    if (!statSync(path).isFile()) {
      return "";
    }
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

function defaultConfirm(prompt: string): boolean {
  try {
    process.stdout.write(`${prompt} [yes/NO]: `);
    return false;
  } catch {
    return false;
  }
}

export function nowUtcIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function rollback(
  projectRoot: string,
  options: RollbackOptions = {},
): readonly [boolean, string[]] {
  const force = options.force ?? false;
  const actions: string[] = [];
  const manifest = loadSafetyManifest(projectRoot);
  if (manifest === null) {
    return [
      false,
      [
        "ERROR: No safety manifest found. Either migration has not run, or rollback has already completed. Expected " +
          `${rel(projectRoot, manifestPath(projectRoot))}.`,
      ],
    ];
  }

  const editedStubs: [string, string, string][] = [];
  for (const [relPathKey, expectedHash] of Object.entries(manifest.post_migration_stub_hashes)) {
    const current = sha256Of(join(projectRoot, relPathKey));
    if (current && current !== expectedHash) {
      editedStubs.push([relPathKey, expectedHash, current]);
    }
  }
  if (editedStubs.length > 0 && !force) {
    const lines = ["ERROR: Redirect stubs have been edited since migration:"];
    for (const [relPathKey, expected, current] of editedStubs) {
      lines.push(
        `  - ${relPathKey} (expected sha256 ${expected.slice(0, 12)}..., got ${current.slice(0, 12)}...)`,
      );
    }
    lines.push(
      "Rollback would overwrite your edits. Re-run with --force to proceed anyway, or commit the stubs before rolling back.",
    );
    return [false, lines];
  }

  const editedModifications: [string, string, string, string][] = [];
  for (const mod of manifest.file_modifications) {
    const current = sha256Of(join(projectRoot, mod.path));
    if (!current) {
      continue;
    }
    if (current === mod.pre_hash || current === mod.post_hash) {
      continue;
    }
    editedModifications.push([mod.path, mod.pre_hash, mod.post_hash, current]);
  }
  if (editedModifications.length > 0 && !force) {
    const lines = ["ERROR: Migrator-modified file(s) have been edited since migration:"];
    for (const [relPathKey, pre, post, current] of editedModifications) {
      lines.push(
        `  - ${relPathKey} (expected sha256 ${post.slice(0, 12)}... or ${pre.slice(0, 12)}..., got ${current.slice(0, 12)}...)`,
      );
    }
    lines.push(
      "Rollback would overwrite your edits. Re-run with --force to proceed anyway, or commit the file(s) before rolling back.",
    );
    return [false, lines];
  }

  if (!force) {
    const promptFn = options.confirmFn ?? defaultConfirm;
    const summary =
      `Rollback will restore ${manifest.backups.length} backup(s) and ` +
      `remove ${manifest.created_files.length} migrator-created file(s). Proceed?`;
    if (!promptFn(summary)) {
      return [false, ["Rollback aborted by operator."]];
    }
  }

  const missingBackups = manifest.backups
    .map((record) => record.backup)
    .filter((backupRel) => !existsSync(join(projectRoot, backupRel)));
  if (missingBackups.length > 0) {
    const lines = [
      "ERROR: Backup file(s) missing -- cannot restore all sources:",
      ...missingBackups.map((p) => `  - ${p}`),
      "Manifest preserved for investigation. Resolve the missing .premigrate.* file(s) (or restore from VCS) and retry `task migrate:vbrief -- --rollback`.",
    ];
    return [false, [...actions, ...lines]];
  }

  for (const record of manifest.backups) {
    const backupPath = join(projectRoot, record.backup);
    const sourcePath = join(projectRoot, record.source);
    mkdirSync(dirname(sourcePath), { recursive: true });
    copyFileSync(backupPath, sourcePath);
    actions.push(`RESTORE ${record.source} <- ${record.backup} (${record.size_bytes} bytes)`);
  }

  const sortedCreated = [...manifest.created_files].sort(
    (a, b) => b.split("/").length - a.split("/").length,
  );
  for (const relFile of sortedCreated) {
    const currentRel = manifest.currentPathFor(relFile);
    const path = join(projectRoot, currentRel);
    try {
      if (statSync(path).isFile()) {
        unlinkSync(path);
        if (currentRel !== relFile) {
          actions.push(`REMOVE ${currentRel} (renamed from ${relFile})`);
        } else {
          actions.push(`REMOVE ${relFile}`);
        }
      } else if (currentRel !== relFile) {
        actions.push(`SKIP   ${currentRel} (already absent; renamed from ${relFile})`);
      } else {
        actions.push(`SKIP   ${relFile} (already absent)`);
      }
    } catch {
      if (currentRel !== relFile) {
        actions.push(`SKIP   ${currentRel} (already absent; renamed from ${relFile})`);
      } else {
        actions.push(`SKIP   ${relFile} (already absent)`);
      }
    }
  }

  const sortedDirs = [...manifest.created_dirs].sort(
    (a, b) => b.split("/").length - a.split("/").length,
  );
  for (const relDir of sortedDirs) {
    const path = join(projectRoot, relDir);
    try {
      if (statSync(path).isDirectory()) {
        rmSync(path, { recursive: false });
        actions.push(`RMDIR  ${relDir}`);
      }
    } catch {
      actions.push(`SKIP   rmdir ${relDir} (not empty)`);
    }
  }

  for (const mod of manifest.file_modifications) {
    const target = join(projectRoot, mod.path);
    const current = sha256Of(target);
    if (mod.operation === "create") {
      try {
        if (current && statSync(target).isFile()) {
          unlinkSync(target);
          actions.push(`REMOVE ${mod.path} (created by migrator)`);
        } else {
          actions.push(`SKIP   ${mod.path} (already absent)`);
        }
      } catch {
        actions.push(`SKIP   ${mod.path} (already absent)`);
      }
      continue;
    }
    if (mod.operation === "append") {
      if (!current) {
        actions.push(`SKIP   ${mod.path} (file no longer exists; nothing to strip)`);
        continue;
      }
      if (current === mod.pre_hash) {
        actions.push(`SKIP   ${mod.path} (already at pre-migration hash)`);
        continue;
      }
      try {
        const body = readFileSync(target, "utf8");
        if (body.endsWith(mod.appended_content)) {
          writeFileSync(target, body.slice(0, -mod.appended_content.length), "utf8");
          actions.push(
            `REVERT ${mod.path} (stripped ${mod.appended_content.length} appended byte(s))`,
          );
        } else {
          actions.push(
            `SKIP   ${mod.path} (content shape drifted; cannot strip append cleanly -- restore manually)`,
          );
        }
      } catch {
        actions.push(`SKIP   ${mod.path} (unreadable; cannot strip append)`);
      }
      continue;
    }
    actions.push(`SKIP   ${mod.path} (unknown operation '${mod.operation}')`);
  }

  for (const record of manifest.backups) {
    const backupPath = join(projectRoot, record.backup);
    try {
      if (statSync(backupPath).isFile()) {
        unlinkSync(backupPath);
        actions.push(`REMOVE ${record.backup}`);
      }
    } catch {
      // skip
    }
  }

  const mPath = manifestPath(projectRoot);
  try {
    if (statSync(mPath).isFile()) {
      unlinkSync(mPath);
      actions.push(`REMOVE ${rel(projectRoot, mPath)}`);
    }
  } catch {
    // skip
  }
  for (const parent of [dirname(mPath), dirname(dirname(mPath))]) {
    try {
      if (statSync(parent).isDirectory() && readdirSync(parent).length === 0) {
        rmSync(parent, { recursive: false });
        actions.push(`RMDIR  ${rel(projectRoot, parent)}`);
      }
    } catch {
      // non-empty
    }
  }

  actions.push("Rollback completed successfully.");
  return [true, actions];
}

export type { BackupRecord, FileModification, RenameRecord };
