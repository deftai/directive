/**
 * Contract 1 setup for --operation install|repair|upgrade (Wave 2a–2c / R8 / R9).
 * Writes GENERATION.json, readiness marker, package-relative wiring (AGENTS,
 * skills, host hooks, git hooks, Taskfile), gitignore entries; install-only
 * seed placeholders. Never deposits .deft/core (AC13.1).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContainedWriteError,
  containedRemove,
  containedWrite,
} from "@deftai/directive-core/dist/fs/contained-write.js";
import {
  buildOwnershipRecord,
  fingerprintContent,
  ownershipRecordsEqual,
  readOwnershipRecord,
  writeOwnershipRecord,
  type OwnedArtifact,
  type PackageManagerFact,
} from "@deftai/directive-core/dist/install-health/index.js";
import {
  ensureAgentsManagedSection,
  ensureGitHooks,
  ensureHostHooks,
  ensureSkillPointers,
  ensureTaskfileInclude,
  RUNTIME_PREFIX,
} from "./setup-wiring.js";

export type SetupOperation = "install" | "repair" | "upgrade";

export interface SetupResult {
  readonly contract: 1;
  readonly entry: "setup";
  readonly stub: false;
  readonly operation: SetupOperation;
  readonly from: string;
  readonly root: string;
  readonly runtimeVersion: string;
  readonly created: string[];
  readonly modified: string[];
  readonly removed: string[];
  readonly conflicts: string[];
  readonly message: string;
}

const SEED_PLACEHOLDER_REL = "xbrief/.directive-seed-placeholder";
const GEN_REL = ".deft/GENERATION.json";
const WIRING_READY_DIR_REL = ".deft/directive";

function readOwnRuntimeVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

function detectPmFact(projectRoot: string): PackageManagerFact {
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Contained write under projectRoot; refuses symlink escape. */
function writeContained(
  projectRoot: string,
  relPath: string,
  body: string,
): void {
  containedWrite({
    root: projectRoot,
    target: relPath,
    data: body,
    mode: "replace",
    mkdir: true,
  });
}

function relPosix(...parts: string[]): string {
  return join(...parts).replace(/\\/g, "/");
}

function track(
  created: string[],
  modified: string[],
  rel: string,
  change: { created: boolean; modified: boolean },
): void {
  if (change.created) created.push(rel);
  else if (change.modified) modified.push(rel);
}

function wiringReadyRel(runtimeVersion: string): string {
  return relPosix(WIRING_READY_DIR_REL, `wiring-ready.${runtimeVersion}.json`);
}

/** Remove readiness markers so a failed/conflicted setup cannot look ready. */
function invalidateReadinessMarkers(projectRoot: string, removed: string[]): void {
  const dir = join(projectRoot, WIRING_READY_DIR_REL);
  if (!existsSync(dir)) return;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("wiring-ready.") || !name.endsWith(".json")) continue;
    const rel = relPosix(WIRING_READY_DIR_REL, name);
    try {
      const result = containedRemove({ root: projectRoot, target: rel });
      if (result.removed) removed.push(rel);
    } catch {
      /* best-effort invalidation */
    }
  }
}

/** Ensure .gitignore has node_modules and wiring-ready ignore entries (AC8.5). */
function ensureGitignore(projectRoot: string): { created: boolean; modified: boolean } {
  const rel = ".gitignore";
  const needed = ["node_modules/", ".deft/directive/wiring-ready.*.json"];
  const existing = readText(join(projectRoot, rel));
  if (existing === null) {
    writeContained(projectRoot, rel, `${needed.join("\n")}\n`);
    return { created: true, modified: false };
  }
  const lines = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const missing = needed.filter((n) => {
    if (lines.has(n)) return false;
    if (n === "node_modules/" && (lines.has("node_modules") || lines.has("/node_modules/"))) {
      return false;
    }
    return true;
  });
  if (missing.length === 0) return { created: false, modified: false };
  const suffix = existing.endsWith("\n") ? "" : "\n";
  writeContained(projectRoot, rel, `${existing}${suffix}${missing.join("\n")}\n`);
  return { created: false, modified: true };
}

function writeReadiness(
  projectRoot: string,
  runtimeVersion: string,
): { path: string; created: boolean; modified: boolean } {
  const rel = wiringReadyRel(runtimeVersion);
  const body = `${JSON.stringify({ runtimeVersion }, null, 2)}\n`;
  const prior = readText(join(projectRoot, rel));
  if (prior === body) {
    return { path: rel, created: false, modified: false };
  }
  const created = prior === null;
  writeContained(projectRoot, rel, body);
  return { path: rel, created, modified: !created };
}

function createSeedPlaceholder(projectRoot: string): string | null {
  if (existsSync(join(projectRoot, SEED_PLACEHOLDER_REL))) return null;
  writeContained(
    projectRoot,
    SEED_PLACEHOLDER_REL,
    "# Directive initial seed placeholder (install only; repair must not create this).\n",
  );
  return SEED_PLACEHOLDER_REL;
}

function buildOwnershipArtifacts(projectRoot: string): OwnedArtifact[] {
  const artifacts: OwnedArtifact[] = [];
  const agentsBody = readText(join(projectRoot, "AGENTS.md"));
  if (agentsBody !== null) {
    artifacts.push({
      path: "AGENTS.md",
      kind: "marked-section",
      fingerprint: fingerprintContent(agentsBody),
      markerId: "deft:managed-section",
    });
  }
  for (const rel of [
    ".claude/settings.json",
    ".cursor/hooks.json",
    ".codex/hooks.json",
    ".grok/hooks/deft.json",
    "Taskfile.yml",
    ".githooks/pre-commit",
    ".githooks/pre-push",
    ".githooks/_directive-run.sh",
  ]) {
    const body = readText(join(projectRoot, rel));
    if (body !== null) {
      artifacts.push({
        path: rel,
        kind: "whole-file",
        fingerprint: fingerprintContent(body),
      });
    }
  }
  const seedAbs = join(projectRoot, SEED_PLACEHOLDER_REL);
  if (existsSync(seedAbs)) {
    artifacts.push({
      path: "xbrief",
      kind: "retained",
      fingerprint: fingerprintContent("xbrief-retain"),
    });
  }
  return artifacts;
}

/**
 * Run setup for install, repair, or upgrade.
 * Upgrade refreshes GENERATION/wiring like repair; never creates install seeds.
 * Never writes `.deft/core` (AC13.1).
 */
export function runSetup(options: {
  readonly operation: SetupOperation;
  readonly from: string;
  readonly root: string;
}): SetupResult {
  const { operation, from, root } = options;
  const created: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const conflicts: string[] = [];

  const runtimeVersion = readOwnRuntimeVersion();
  const pm = detectPmFact(root);
  const genExisted = existsSync(join(root, GEN_REL));
  const priorRecord = readOwnershipRecord(root);

  try {
    track(created, modified, ".gitignore", ensureGitignore(root));

    const agents = ensureAgentsManagedSection(root);
    track(created, modified, "AGENTS.md", agents);
    if (agents.conflict) {
      conflicts.push(agents.conflictReason ?? "AGENTS.md: managed section conflict");
    }

    const skills = ensureSkillPointers(root);
    created.push(...skills.created);
    modified.push(...skills.modified);

    const hooks = ensureHostHooks(root);
    created.push(...hooks.created);
    modified.push(...hooks.modified);

    const githooks = ensureGitHooks(root);
    created.push(...githooks.created);
    modified.push(...githooks.modified);

    track(created, modified, "Taskfile.yml", ensureTaskfileInclude(root));

    // Seeds only on first-time install (AC8.4); repair/upgrade never create them.
    if (operation === "install" && conflicts.length === 0) {
      const seed = createSeedPlaceholder(root);
      if (seed !== null) created.push(seed);
    }

    // AC13.1: never materialize a content copy under .deft/core.
    if (existsSync(join(root, ".deft", "core"))) {
      // Do not create; leave historical removal to 2f conversion.
    }

    const desired = buildOwnershipRecord({
      runtimeVersion,
      packageManager: pm,
      ownership: buildOwnershipArtifacts(root),
    });
    const unchanged = priorRecord !== null && ownershipRecordsEqual(priorRecord, desired);

    writeOwnershipRecord(root, desired);
    if (!genExisted) created.push(GEN_REL);
    else if (!unchanged) modified.push(GEN_REL);

    if (conflicts.length > 0) {
      // Never publish readiness after conflict; invalidate any existing marker (AC8.6).
      invalidateReadinessMarkers(root, removed);
      return {
        contract: 1,
        entry: "setup",
        stub: false,
        operation,
        from,
        root,
        runtimeVersion,
        created,
        modified,
        removed,
        conflicts,
        message: "setup completed with conflicts",
      };
    }

    const ready = writeReadiness(root, runtimeVersion);
    track(created, modified, ready.path, ready);

    return {
      contract: 1,
      entry: "setup",
      stub: false,
      operation,
      from,
      root,
      runtimeVersion,
      created,
      modified,
      removed,
      conflicts,
      message: `setup ${operation} completed for ${runtimeVersion} (${RUNTIME_PREFIX})`,
    };
  } catch (err) {
    const msg =
      err instanceof ContainedWriteError
        ? `setup write refused: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    conflicts.push(msg);
    invalidateReadinessMarkers(root, removed);
    return {
      contract: 1,
      entry: "setup",
      stub: false,
      operation,
      from,
      root,
      runtimeVersion,
      created,
      modified,
      removed,
      conflicts,
      message: "setup failed",
    };
  }
}

export function setupChangeCount(result: SetupResult): number {
  return result.created.length + result.modified.length + result.removed.length;
}
