/**
 * Launcher ownership/removal map for uninstall (R11 / AC11.*).
 * Node builtins only — no runtime/core dependency (AC3.1).
 *
 * Discovery merges the persistent GENERATION ownership record with the
 * launcher's known-artifact map for current and latest-legacy layouts.
 * Bounded cleanup: never treat a recorded path as authority to delete
 * arbitrary user content.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { LAUNCHER_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from "./constants.js";

export type UninstallOwnershipKind =
  | "whole-file"
  | "marked-section"
  | "structured-entry"
  | "retained";

export interface DiscoveredArtifact {
  readonly path: string;
  readonly kind: UninstallOwnershipKind;
  readonly entryKey?: string;
  readonly markerId?: string;
  /** Where the claim came from. */
  readonly source: "ownership-record" | "known-map";
}

export interface UninstallDiscovery {
  readonly artifacts: readonly DiscoveredArtifact[];
  readonly ownershipInspection: "valid" | "absent" | "unreadable";
  /** Ownership paths rejected as unsafe (absolute / `..` / escape). */
  readonly rejectedOwnershipPaths: readonly string[];
  readonly hasRuntimePin: boolean;
  readonly hasLegacyLauncherPin: boolean;
  readonly hasLegacyCore: boolean;
  /** True when any removable Directive footprint exists. */
  readonly hasFootprint: boolean;
}

export interface CleanupReport {
  readonly removed: string[];
  readonly modified: string[];
  readonly preserved: string[];
  readonly leftovers: string[];
  readonly uncertainty: string[];
  readonly hooksPath: "unset" | "preserved-sibling" | "preserved-foreign" | "absent" | "unchanged";
}

const MANAGED_OPEN = "<!-- deft:managed-section";
const MANAGED_CLOSE = "<!-- /deft:managed-section -->";
const RUNTIME_PREFIX = "node_modules/@deftai/directive-runtime/";

const SKILL_HOST_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codex/skills",
  ".github/skills",
] as const;

const SKILL_DIRS = [
  "deft",
  "deft-directive-setup",
  "deft-directive-build",
  "deft-directive-swarm",
  "deft-directive-sync",
] as const;

const GITHOOK_RELS = [
  ".githooks/pre-commit",
  ".githooks/pre-push",
  ".githooks/_directive-run.sh",
  ".githooks/_deft-run.sh",
] as const;

const HOST_HOOK_RELS = [
  ".claude/settings.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".grok/hooks/deft.json",
] as const;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pkgHasDep(projectRoot: string, name: string): boolean {
  const pkg = readJsonObject(join(projectRoot, "package.json"));
  if (pkg === null) return false;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const block = pkg[key];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      if (name in (block as Record<string, unknown>)) return true;
    }
  }
  return false;
}

/**
 * Ownership paths are bounded cleanup hints only (AC11.10 / D4.15).
 * Reject absolute paths, any `..` segment (before normalize), and paths that
 * resolve to the project root itself (`.` / `subdir/..`).
 */
export function isSafeOwnershipRelPath(rel: string): boolean {
  if (typeof rel !== "string" || !rel.trim()) return false;
  const trimmed = rel.trim();
  if (isAbsolute(trimmed)) return false;
  // Windows drive / UNC even when path.isAbsolute is false on POSIX hosts.
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) return false;
  // Inspect raw segments before normalize collapses `subdir/..` → `.`.
  const rawParts = trimmed.replace(/\\/g, "/").split("/");
  if (rawParts.some((p) => p === "..")) return false;
  const norm = normalize(trimmed).replace(/\\/g, "/");
  if (norm === "" || norm === "." || norm === "..") return false;
  if (norm.startsWith("../") || norm.split("/").includes("..")) return false;
  if (norm.startsWith("/")) return false;
  return true;
}

/**
 * True when `absCandidate` is a strict descendant of `projectRoot`.
 * The project root itself is refused (never delete/rewrite the checkout).
 */
function isPathInsideProjectRoot(projectRoot: string, absCandidate: string): boolean {
  const rootAbs = resolve(projectRoot);
  const candAbs = resolve(absCandidate);
  const rel = relative(rootAbs, candAbs);
  // Empty rel → candidate IS the root; refuse. `..` / absolute → escape.
  if (rel === "" || rel === "." || rel.startsWith("..") || isAbsolute(rel)) return false;
  try {
    const rootReal = realpathSync(rootAbs);
    let candReal: string;
    try {
      candReal = realpathSync(candAbs);
    } catch {
      // Target may not exist yet — fall back to lexical strict-descendant check.
      return true;
    }
    const relReal = relative(rootReal, candReal);
    if (relReal === "" || relReal === "." || relReal.startsWith("..") || isAbsolute(relReal)) {
      return false;
    }
    const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
    if (!candReal.startsWith(rootPrefix)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Contained write for cleanup mutations (same root check as deletes). */
function safeWriteText(projectRoot: string, rel: string, body: string): boolean {
  if (!isSafeOwnershipRelPath(rel)) return false;
  const abs = resolve(projectRoot, rel);
  if (!isPathInsideProjectRoot(projectRoot, abs)) return false;
  try {
    writeFileSync(abs, body);
    return true;
  } catch {
    return false;
  }
}

function parseOwnershipArtifacts(
  projectRoot: string,
): {
  inspection: "valid" | "absent" | "unreadable";
  artifacts: DiscoveredArtifact[];
  rejected: string[];
} {
  const path = join(projectRoot, ".deft", "GENERATION.json");
  if (!existsSync(path)) return { inspection: "absent", artifacts: [], rejected: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { inspection: "unreadable", artifacts: [], rejected: [] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { inspection: "unreadable", artifacts: [], rejected: [] };
  }
  const ownership = (parsed as { ownership?: unknown }).ownership;
  if (!Array.isArray(ownership)) {
    return { inspection: "unreadable", artifacts: [], rejected: [] };
  }
  const artifacts: DiscoveredArtifact[] = [];
  const rejected: string[] = [];
  for (const entry of ownership) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.path !== "string" || !rec.path.trim()) continue;
    const kind = rec.kind;
    if (
      kind !== "whole-file" &&
      kind !== "marked-section" &&
      kind !== "structured-entry" &&
      kind !== "retained"
    ) {
      continue;
    }
    const normalized = rec.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!isSafeOwnershipRelPath(normalized)) {
      rejected.push(normalized);
      continue;
    }
    const art: DiscoveredArtifact = {
      path: normalized,
      kind,
      source: "ownership-record",
      ...(typeof rec.entryKey === "string" && rec.entryKey.trim()
        ? { entryKey: rec.entryKey.trim() }
        : {}),
      ...(typeof rec.markerId === "string" && rec.markerId.trim()
        ? { markerId: rec.markerId.trim() }
        : kind === "marked-section"
          ? { markerId: "deft:managed-section" }
          : {}),
    };
    artifacts.push(art);
  }
  return { inspection: "valid", artifacts, rejected };
}

function skillPointerRels(): string[] {
  const out: string[] = [];
  for (const host of SKILL_HOST_ROOTS) {
    for (const dir of SKILL_DIRS) {
      out.push(`${host}/${dir}/SKILL.md`);
    }
  }
  return out;
}

function isOurSkillPointer(body: string): boolean {
  return (
    body.includes(RUNTIME_PREFIX) ||
    body.includes("npm i -g @deftai/directive") ||
    body.includes(".deft/core/")
  );
}

function isOurGitHook(rel: string, body: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  if (base === "_directive-run.sh" || base === "_deft-run.sh") {
    return (
      body.includes(RUNTIME_PREFIX) ||
      body.includes("run_directive") ||
      body.includes("run_deft") ||
      body.includes(".deft/core") ||
      body.includes("packages/cli/dist/bin.js")
    );
  }
  return (
    body.includes("_directive-run.sh") ||
    body.includes("_deft-run.sh") ||
    body.includes("run_deft") ||
    body.includes(RUNTIME_PREFIX) ||
    body.includes(".deft/core")
  );
}

function listWiringReady(projectRoot: string): string[] {
  const dir = join(projectRoot, ".deft", "directive");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith("wiring-ready.") && n.endsWith(".json"))
      .map((n) => `.deft/directive/${n}`);
  } catch {
    return [];
  }
}

/**
 * Known-artifact map for current + latest-legacy layouts (AC11.1 / AC11.2).
 * Used when the ownership record is missing/damaged and to supplement discovery.
 */
export function discoverKnownArtifacts(projectRoot: string): DiscoveredArtifact[] {
  const out: DiscoveredArtifact[] = [];
  const push = (art: DiscoveredArtifact) => {
    if (!out.some((a) => a.path === art.path && a.kind === art.kind && a.entryKey === art.entryKey)) {
      out.push(art);
    }
  };

  if (existsSync(join(projectRoot, ".deft", "GENERATION.json"))) {
    push({ path: ".deft/GENERATION.json", kind: "whole-file", source: "known-map" });
  }
  for (const rel of listWiringReady(projectRoot)) {
    push({ path: rel, kind: "whole-file", source: "known-map" });
  }
  if (existsSync(join(projectRoot, ".deft", "directive", "data-schema.json"))) {
    push({
      path: ".deft/directive/data-schema.json",
      kind: "whole-file",
      source: "known-map",
    });
  }
  if (existsSync(join(projectRoot, ".deft", "core"))) {
    push({ path: ".deft/core", kind: "whole-file", source: "known-map" });
  }

  for (const rel of GITHOOK_RELS) {
    const body = readText(join(projectRoot, rel));
    if (body !== null && isOurGitHook(rel, body)) {
      push({ path: rel, kind: "whole-file", source: "known-map" });
    }
  }

  for (const rel of skillPointerRels()) {
    const body = readText(join(projectRoot, rel));
    if (body !== null && isOurSkillPointer(body)) {
      push({ path: rel, kind: "whole-file", source: "known-map" });
    }
  }

  const agents = readText(join(projectRoot, "AGENTS.md"));
  if (agents !== null && agents.includes(MANAGED_OPEN)) {
    push({
      path: "AGENTS.md",
      kind: "marked-section",
      markerId: "deft:managed-section",
      source: "known-map",
    });
  }

  for (const rel of HOST_HOOK_RELS) {
    if (existsSync(join(projectRoot, rel))) {
      push({
        path: rel,
        kind: "structured-entry",
        entryKey: "hooks",
        source: "known-map",
      });
    }
  }

  const taskfile = readText(join(projectRoot, "Taskfile.yml"));
  if (
    taskfile !== null &&
    (taskfile.includes(`${RUNTIME_PREFIX}Taskfile.yml`) ||
      taskfile.includes(".deft/core/Taskfile.yml") ||
      /(^|\n)[ \t]*deft:\s*(\n|$)/.test(taskfile))
  ) {
    push({
      path: "Taskfile.yml",
      kind: "structured-entry",
      entryKey: "includes.deft",
      source: "known-map",
    });
  }

  if (existsSync(join(projectRoot, "xbrief"))) {
    push({ path: "xbrief", kind: "retained", source: "known-map" });
  }
  if (existsSync(join(projectRoot, ".deft", "settings.json"))) {
    push({ path: ".deft/settings.json", kind: "retained", source: "known-map" });
  }

  return out;
}

function mergeArtifacts(
  fromRecord: readonly DiscoveredArtifact[],
  fromKnown: readonly DiscoveredArtifact[],
): DiscoveredArtifact[] {
  const out: DiscoveredArtifact[] = [...fromRecord];
  for (const art of fromKnown) {
    const overlap = out.find(
      (a) => a.path === art.path && (a.kind === art.kind || art.kind === "retained"),
    );
    if (overlap) continue;
    // Prefer record kinds for shared paths; known-map fills gaps.
    const samePath = out.find((a) => a.path === art.path);
    if (samePath) continue;
    out.push(art);
  }
  return out;
}

/** Discover Directive footprint for uninstall planning (AC11.2). */
export function discoverUninstallFootprint(projectRoot: string): UninstallDiscovery {
  const {
    inspection,
    artifacts: fromRecord,
    rejected,
  } = parseOwnershipArtifacts(projectRoot);
  const fromKnown = discoverKnownArtifacts(projectRoot);
  const artifacts = mergeArtifacts(fromRecord, fromKnown);
  const hasRuntimePin = pkgHasDep(projectRoot, RUNTIME_PACKAGE_NAME);
  const hasLegacyLauncherPin = pkgHasDep(projectRoot, LAUNCHER_PACKAGE_NAME);
  const hasLegacyCore = existsSync(join(projectRoot, ".deft", "core"));
  const removable = artifacts.some((a) => a.kind !== "retained");
  const hasFootprint =
    removable ||
    hasRuntimePin ||
    hasLegacyLauncherPin ||
    hasLegacyCore ||
    existsSync(join(projectRoot, ".deft", "GENERATION.json"));
  return {
    artifacts,
    ownershipInspection: inspection,
    rejectedOwnershipPaths: rejected,
    hasRuntimePin,
    hasLegacyLauncherPin,
    hasLegacyCore,
    hasFootprint,
  };
}

function removeManagedSection(body: string): { next: string; removed: boolean } {
  const start = body.indexOf(MANAGED_OPEN);
  if (start < 0) return { next: body, removed: false };
  const openEnd = body.indexOf("-->", start);
  if (openEnd < 0) return { next: body, removed: false };
  const end = body.indexOf(MANAGED_CLOSE, openEnd);
  if (end < 0) return { next: body, removed: false };
  const closeEnd = end + MANAGED_CLOSE.length;
  let next = body.slice(0, start) + body.slice(closeEnd);
  // Collapse excess blank lines left by section removal.
  next = next.replace(/\n{3,}/g, "\n\n");
  if (next.trim().length === 0) next = "";
  return { next, removed: true };
}

function isManagedHookCommand(command: string): boolean {
  return (
    command.includes("directive-runtime/dist/hook-bin.js") ||
    command.includes(".deft/core/") ||
    /(^|[\s"`'])deft-hook([\s"`']|$)/.test(command) ||
    command.includes("deft hook:dispatch")
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stripHostHooks(cfg: Record<string, unknown>): Record<string, unknown> {
  const hooks = object(cfg.hooks);
  if (hooks === null) return cfg;
  const nextHooks: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      nextHooks[key] = value;
      continue;
    }
    const filtered = value.filter((entry) => {
      const e = object(entry);
      if (e === null) return true;
      if (typeof e.command === "string" && isManagedHookCommand(e.command)) return false;
      if (Array.isArray(e.hooks)) {
        const nestedManaged = e.hooks.some((h) => {
          const hook = object(h);
          return typeof hook?.command === "string" && isManagedHookCommand(hook.command);
        });
        if (nestedManaged) return false;
      }
      return true;
    });
    if (filtered.length > 0) nextHooks[key] = filtered;
  }
  if (Object.keys(nextHooks).length === 0) {
    const { hooks: _h, ...rest } = cfg;
    // Drop Cursor-only version stamp when hooks emptied.
    if ("version" in rest && Object.keys(rest).length === 1) {
      const { version: _v, ...rest2 } = rest;
      return rest2;
    }
    return rest;
  }
  return { ...cfg, hooks: nextHooks };
}

function stripTaskfileDeftInclude(body: string): { next: string; removed: boolean } {
  // Remove a block-style `deft:` child under includes (2-space indent).
  const blockRe =
    /(^|\n)([ \t]*)deft:\s*(?:#.*)?\n(?:\2[ \t]+[^\n]*\n)*/;
  if (blockRe.test(body)) {
    const next = body.replace(blockRe, "$1");
    return { next: next.replace(/\n{3,}/g, "\n\n"), removed: next !== body };
  }
  return { next: body, removed: false };
}

function safeUnlink(projectRoot: string, rel: string): boolean {
  // Defense in depth: never delete outside the project even if a caller bypasses parse (AC3.4).
  if (!isSafeOwnershipRelPath(rel)) return false;
  const abs = resolve(projectRoot, rel);
  if (!isPathInsideProjectRoot(projectRoot, abs)) return false;
  if (!existsSync(abs)) return false;
  try {
    // Re-check after existence: refuse symlink escape of the leaf.
    if (!isPathInsideProjectRoot(projectRoot, abs)) return false;
    rmSync(abs, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function maybeRemoveEmptyParents(projectRoot: string, relFile: string): string[] {
  const removed: string[] = [];
  let dir = dirname(relFile);
  while (dir && dir !== "." && dir !== "/") {
    const abs = join(projectRoot, dir);
    if (!existsSync(abs)) break;
    try {
      const entries = readdirSync(abs);
      if (entries.length > 0) break;
      rmSync(abs, { recursive: false, force: true });
      removed.push(dir);
    } catch {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return removed;
}

/**
 * Apply launcher fallback cleanup from a retained discovery snapshot (AC11.5).
 * Idempotent. Does not touch retained artifacts or PM deps / hooksPath.
 */
export function applyLauncherCleanup(
  projectRoot: string,
  discovery: UninstallDiscovery,
): CleanupReport {
  const removed: string[] = [];
  const modified: string[] = [];
  const preserved: string[] = [];
  const leftovers: string[] = [];
  const uncertainty: string[] = [];

  if (discovery.ownershipInspection === "unreadable") {
    uncertainty.push("GENERATION.json ownership record was unreadable; used known-artifact map");
  } else if (discovery.ownershipInspection === "absent") {
    uncertainty.push("GENERATION.json absent; used known-artifact map");
  }
  for (const bad of discovery.rejectedOwnershipPaths) {
    uncertainty.push(
      `rejected unsafe ownership path (escape/absolute): ${bad}`,
    );
  }

  // AC11.4: strip hook registrations (structured-entry) before deleting targets.
  const ordered = [...discovery.artifacts].sort((a, b) => {
    const rank = (k: UninstallOwnershipKind) =>
      k === "structured-entry" ? 0 : k === "marked-section" ? 1 : k === "whole-file" ? 2 : 3;
    return rank(a.kind) - rank(b.kind);
  });

  for (const art of ordered) {
    if (art.kind === "retained") {
      if (existsSync(join(projectRoot, art.path))) preserved.push(art.path);
      continue;
    }

    if (art.kind === "marked-section") {
      const abs = resolve(projectRoot, art.path);
      if (!isPathInsideProjectRoot(projectRoot, abs)) {
        uncertainty.push(`skipped marked-section outside project: ${art.path}`);
        continue;
      }
      const body = readText(abs);
      if (body === null) continue;
      const { next, removed: did } = removeManagedSection(body);
      if (!did) {
        if (body.includes(MANAGED_OPEN)) {
          leftovers.push(`${art.path} (managed section markers incomplete)`);
          uncertainty.push(`could not safely remove marked section from ${art.path}`);
        }
        continue;
      }
      if (next.trim().length === 0) {
        if (safeUnlink(projectRoot, art.path)) removed.push(art.path);
        else leftovers.push(art.path);
      } else if (safeWriteText(projectRoot, art.path, next.endsWith("\n") ? next : `${next}\n`)) {
        modified.push(`${art.path}#marked-section`);
      } else {
        leftovers.push(art.path);
        uncertainty.push(`refused write outside project: ${art.path}`);
      }
      continue;
    }

    if (art.kind === "structured-entry") {
      const abs = resolve(projectRoot, art.path);
      if (!isPathInsideProjectRoot(projectRoot, abs) || !existsSync(abs)) {
        if (existsSync(abs)) {
          uncertainty.push(`skipped structured-entry outside project: ${art.path}`);
        }
        continue;
      }
      if (art.path === "Taskfile.yml" || art.entryKey === "includes.deft") {
        const body = readText(abs);
        if (body === null) continue;
        const { next, removed: did } = stripTaskfileDeftInclude(body);
        if (did) {
          if (safeWriteText(projectRoot, art.path, next.endsWith("\n") ? next : `${next}\n`)) {
            modified.push(`${art.path}#${art.entryKey ?? "includes.deft"}`);
          } else {
            uncertainty.push(`refused write outside project: ${art.path}`);
          }
        }
        continue;
      }
      // Host hook JSON structured entries.
      const cfg = readJsonObject(abs);
      if (cfg === null) {
        uncertainty.push(`${art.path} is not valid JSON; left untouched`);
        leftovers.push(art.path);
        continue;
      }
      const stripped = stripHostHooks(cfg);
      const prior = readText(abs) ?? "";
      const next = `${JSON.stringify(stripped, null, 2)}\n`;
      if (next !== prior) {
        if (safeWriteText(projectRoot, art.path, next)) {
          modified.push(`${art.path}#${art.entryKey ?? "hooks"}`);
        } else {
          uncertainty.push(`refused write outside project: ${art.path}`);
        }
      }
      continue;
    }

    // whole-file — never delete shared Taskfile/host configs wholesale (AC11.5).
    if (art.path === "Taskfile.yml") {
      const body = readText(join(projectRoot, art.path));
      if (body !== null) {
        const { next, removed: did } = stripTaskfileDeftInclude(body);
        if (did) {
          if (
            safeWriteText(
              projectRoot,
              art.path,
              next.endsWith("\n") ? next : `${next}\n`,
            )
          ) {
            modified.push(`${art.path}#includes.deft`);
          } else {
            uncertainty.push(`refused write outside project: ${art.path}`);
          }
        }
      }
      continue;
    }
    if (HOST_HOOK_RELS.includes(art.path as (typeof HOST_HOOK_RELS)[number])) {
      const abs = resolve(projectRoot, art.path);
      if (!isPathInsideProjectRoot(projectRoot, abs)) {
        uncertainty.push(`skipped host-hook rewrite outside project: ${art.path}`);
        continue;
      }
      const cfg = readJsonObject(abs);
      if (cfg !== null) {
        const stripped = stripHostHooks(cfg);
        const prior = readText(abs) ?? "";
        const next = `${JSON.stringify(stripped, null, 2)}\n`;
        if (next !== prior) {
          if (safeWriteText(projectRoot, art.path, next)) {
            modified.push(`${art.path}#hooks`);
          } else {
            uncertainty.push(`refused write outside project: ${art.path}`);
          }
        }
      } else {
        uncertainty.push(`${art.path} is not valid JSON; left untouched`);
        leftovers.push(art.path);
      }
      continue;
    }

    if (safeUnlink(projectRoot, art.path)) {
      removed.push(art.path);
      if (art.path.includes("/")) {
        removed.push(...maybeRemoveEmptyParents(projectRoot, art.path));
      }
    }
  }

  // Always attempt known skill pointers / githooks / readiness even if record omitted them.
  for (const rel of [...GITHOOK_RELS, ...skillPointerRels(), ...listWiringReady(projectRoot)]) {
    if (removed.includes(rel)) continue;
    const body = rel.includes("SKILL.md")
      ? readText(join(projectRoot, rel))
      : rel.startsWith(".githooks/")
        ? readText(join(projectRoot, rel))
        : existsSync(join(projectRoot, rel))
          ? "yes"
          : null;
    if (body === null) continue;
    if (rel.includes("SKILL.md") && !isOurSkillPointer(body)) continue;
    if (rel.startsWith(".githooks/") && !isOurGitHook(rel, body)) continue;
    if (safeUnlink(projectRoot, rel)) {
      removed.push(rel);
      removed.push(...maybeRemoveEmptyParents(projectRoot, rel));
    }
  }

  if (existsSync(join(projectRoot, ".deft", "core"))) {
    if (safeUnlink(projectRoot, ".deft/core")) removed.push(".deft/core");
    else leftovers.push(".deft/core");
  }
  if (existsSync(join(projectRoot, ".deft", "directive", "data-schema.json"))) {
    if (safeUnlink(projectRoot, ".deft/directive/data-schema.json")) {
      removed.push(".deft/directive/data-schema.json");
    }
  }
  // Remove .deft/directive only when empty / only known contents cleared.
  const directiveDir = join(projectRoot, ".deft", "directive");
  if (existsSync(directiveDir)) {
    try {
      const left = readdirSync(directiveDir);
      if (left.length === 0) {
        if (safeUnlink(projectRoot, ".deft/directive")) removed.push(".deft/directive");
      } else {
        leftovers.push(
          ...left.map((n) => `.deft/directive/${n}`),
        );
        uncertainty.push(
          `.deft/directive retains unrecognized entries; not removed wholesale`,
        );
      }
    } catch {
      /* ignore */
    }
  }
  if (existsSync(join(projectRoot, ".deft", "GENERATION.json"))) {
    if (safeUnlink(projectRoot, ".deft/GENERATION.json")) removed.push(".deft/GENERATION.json");
  }

  // Preserved settings/data even when not listed.
  if (existsSync(join(projectRoot, "xbrief")) && !preserved.includes("xbrief")) {
    preserved.push("xbrief");
  }
  if (
    existsSync(join(projectRoot, ".deft", "settings.json")) &&
    !preserved.includes(".deft/settings.json")
  ) {
    preserved.push(".deft/settings.json");
  }

  return {
    removed: [...new Set(removed)],
    modified: [...new Set(modified)],
    preserved: [...new Set(preserved)],
    leftovers: [...new Set(leftovers)],
    uncertainty: [...new Set(uncertainty)],
    hooksPath: "unchanged",
  };
}

function listLinkedWorktreePaths(projectRoot: string): string[] {
  try {
    const out = execFileSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    const paths: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
    }
    return paths;
  } catch {
    return [];
  }
}

function siblingNeedsHooksPath(projectRoot: string): boolean {
  const rootResolved = join(projectRoot);
  for (const wt of listLinkedWorktreePaths(projectRoot)) {
    if (join(wt) === rootResolved) continue;
    // Sibling still has Directive git-hook helper → shared hooksPath must stay.
    if (existsSync(join(wt, ".githooks", "_directive-run.sh"))) return true;
    if (existsSync(join(wt, ".deft", "GENERATION.json"))) return true;
  }
  return false;
}

/**
 * Unset core.hooksPath only when it still points at Directive-owned `.githooks`
 * and clearing it would not disable a sibling worktree (AC11.6 / §A9).
 */
export function cleanupHooksPath(projectRoot: string): CleanupReport["hooksPath"] {
  let current: string | null = null;
  try {
    current = execFileSync("git", ["-C", projectRoot, "config", "--get", "core.hooksPath"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "absent";
  }
  if (current === null || current === "") return "absent";
  if (current !== ".githooks" && current !== ".githooks/") {
    return "preserved-foreign";
  }
  if (siblingNeedsHooksPath(projectRoot)) {
    return "preserved-sibling";
  }
  try {
    execFileSync("git", ["-C", projectRoot, "config", "--unset", "core.hooksPath"], {
      encoding: "utf8",
    });
    return "unset";
  } catch {
    return "unchanged";
  }
}

/** Verify owned wiring targets are gone after cleanup (for complete vs partial). */
export function verifyUninstallComplete(projectRoot: string): {
  complete: boolean;
  leftovers: string[];
} {
  const leftovers: string[] = [];
  if (existsSync(join(projectRoot, ".deft", "GENERATION.json"))) {
    leftovers.push(".deft/GENERATION.json");
  }
  if (existsSync(join(projectRoot, ".deft", "core"))) {
    leftovers.push(".deft/core");
  }
  for (const rel of GITHOOK_RELS) {
    const body = readText(join(projectRoot, rel));
    if (body !== null && isOurGitHook(rel, body)) leftovers.push(rel);
  }
  const agents = readText(join(projectRoot, "AGENTS.md"));
  if (agents !== null && agents.includes(MANAGED_OPEN)) {
    leftovers.push("AGENTS.md#marked-section");
  }
  if (pkgHasDep(projectRoot, RUNTIME_PACKAGE_NAME)) {
    leftovers.push(`package.json#${RUNTIME_PACKAGE_NAME}`);
  }
  if (pkgHasDep(projectRoot, LAUNCHER_PACKAGE_NAME)) {
    // Legacy pin only counts when old-style evidence remains; still report if present.
    leftovers.push(`package.json#${LAUNCHER_PACKAGE_NAME}`);
  }
  for (const rel of listWiringReady(projectRoot)) leftovers.push(rel);
  return { complete: leftovers.length === 0, leftovers };
}
