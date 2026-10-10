/**
 * Contract 1 setup for --operation install|repair (Wave 2a / R8).
 * Writes GENERATION.json, readiness marker, minimal AGENTS wiring, gitignore
 * entries; install-only seed placeholders. Upgrade body lands in 2b; full
 * host wiring inventory in 2c.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOwnershipRecord,
  fingerprintContent,
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_OPEN_PREFIX,
  ownershipRecordsEqual,
  readOwnershipRecord,
  writeOwnershipRecord,
  type OwnedArtifact,
  type PackageManagerFact,
} from "@deftai/directive-core/dist/install-health/index.js";

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

const RUNTIME_PREFIX = "node_modules/@deftai/directive-runtime/";
const SEED_PLACEHOLDER_REL = "xbrief/.directive-seed-placeholder";
const GEN_REL = ".deft/GENERATION.json";

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

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeText(path: string, body: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, body);
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

/** Ensure .gitignore has node_modules and wiring-ready ignore entries (AC8.5). */
function ensureGitignore(projectRoot: string): { created: boolean; modified: boolean } {
  const path = join(projectRoot, ".gitignore");
  const needed = ["node_modules/", ".deft/directive/wiring-ready.*.json"];
  const existing = readText(path);
  if (existing === null) {
    writeText(path, `${needed.join("\n")}\n`);
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
  writeText(path, `${existing}${suffix}${missing.join("\n")}\n`);
  return { created: false, modified: true };
}

function ensureAgentsManagedSection(projectRoot: string): {
  created: boolean;
  modified: boolean;
  conflict: boolean;
} {
  const path = join(projectRoot, "AGENTS.md");
  const section = [
    `${MANAGED_SECTION_OPEN_PREFIX} v3 -->`,
    `Directive runtime: ${RUNTIME_PREFIX}`,
    `See ${RUNTIME_PREFIX} (package-relative; no .deft/core copy).`,
    "Recovery: npm i -g @deftai/directive, then directive install --repair",
    MANAGED_SECTION_CLOSE,
    "",
  ].join("\n");

  const existing = readText(path);
  if (existing === null) {
    writeText(path, `${section}\n`);
    return { created: true, modified: false, conflict: false };
  }

  const start = existing.indexOf(MANAGED_SECTION_OPEN_PREFIX);
  if (start < 0) {
    const suffix = existing.endsWith("\n") ? "" : "\n";
    writeText(path, `${existing}${suffix}\n${section}\n`);
    return { created: false, modified: true, conflict: false };
  }
  const openEnd = existing.indexOf("-->", start);
  const end = openEnd >= 0 ? existing.indexOf(MANAGED_SECTION_CLOSE, openEnd) : -1;
  if (end < 0) {
    return { created: false, modified: false, conflict: true };
  }
  const closeEnd = end + MANAGED_SECTION_CLOSE.length;
  const current = existing.slice(start, closeEnd);
  if (current.includes(RUNTIME_PREFIX) && !current.includes(".deft/core/")) {
    return { created: false, modified: false, conflict: false };
  }
  const next = existing.slice(0, start) + section.trimEnd() + existing.slice(closeEnd);
  writeText(path, next.endsWith("\n") ? next : `${next}\n`);
  return { created: false, modified: true, conflict: false };
}

function writeReadiness(
  projectRoot: string,
  runtimeVersion: string,
): { path: string; created: boolean; modified: boolean } {
  const rel = relPosix(".deft", "directive", `wiring-ready.${runtimeVersion}.json`);
  const abs = join(projectRoot, rel);
  const body = `${JSON.stringify({ runtimeVersion }, null, 2)}\n`;
  const prior = readText(abs);
  if (prior === body) {
    return { path: rel, created: false, modified: false };
  }
  const created = prior === null;
  writeText(abs, body);
  return { path: rel, created, modified: !created };
}

function createSeedPlaceholder(projectRoot: string): string | null {
  const abs = join(projectRoot, SEED_PLACEHOLDER_REL);
  if (existsSync(abs)) return null;
  writeText(
    abs,
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
 * Run setup for install or repair. Upgrade returns a deferred message (wave 2b).
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

  if (operation === "upgrade") {
    return {
      contract: 1,
      entry: "setup",
      stub: false,
      operation,
      from,
      root,
      runtimeVersion: readOwnRuntimeVersion(),
      created,
      modified,
      removed,
      conflicts,
      message: "setup --operation upgrade deferred to wave 2b",
    };
  }

  const runtimeVersion = readOwnRuntimeVersion();
  const pm = detectPmFact(root);
  const genExisted = existsSync(join(root, GEN_REL));
  const priorRecord = readOwnershipRecord(root);

  track(created, modified, ".gitignore", ensureGitignore(root));

  const agents = ensureAgentsManagedSection(root);
  track(created, modified, "AGENTS.md", agents);
  if (agents.conflict) {
    conflicts.push("AGENTS.md: managed section open without close marker");
  }

  if (operation === "install") {
    const seed = createSeedPlaceholder(root);
    if (seed !== null) created.push(seed);
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
    message:
      conflicts.length > 0
        ? "setup completed with conflicts"
        : `setup ${operation} completed for ${runtimeVersion}`,
  };
}

export function setupChangeCount(result: SetupResult): number {
  return result.created.length + result.modified.length + result.removed.length;
}
