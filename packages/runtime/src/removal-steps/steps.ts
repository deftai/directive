/**
 * Shared removal-step primitives for uninstall + WAVE3-V2 upgrade convert.
 * pruneEmptyAncestors / removeSoleAuthorHusks: F-012 / F-013 (C4 / C5).
 * Layout steps (core / deft / hooks / skills / gitmodules / orphan): wave 3f.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { containedRemove } from "@deftai/directive-core/dist/fs/contained-write.js";
import {
  CONSUMER_HEADER_PLACEHOLDER_ONELINER,
  renderConsumerHeader,
  unmanagedHeaderOneLiner,
} from "@deftai/directive-core/dist/platform/agents-consumer-header.js";
import {
  HOOK_BIN_COMMAND,
  RUNTIME_PREFIX,
  SKILL_HOST_ROOTS,
  SKILL_POINTER_INVENTORY,
} from "../setup-wiring.js";

export type RemovalStepId =
  | "removeCopiedCore"
  | "removeDeftFrameworkTree"
  | "clearOwnedHookEntries"
  | "removeOwnedSkillPointers"
  | "pruneEmptyAncestors"
  | "removeSoleAuthorHusks"
  | "stripLegacyLauncherPin"
  | "removeOrphanDeftVersion"
  | "normalizeGitmodules";

export interface StepContext {
  readonly root: string;
  /** Relative path that was just removed; prune walks from its parent. */
  readonly emptiedFrom?: string;
  /** Paths removed by earlier steps in a strategy run (for prune sweep). */
  readonly priorRemoved?: readonly string[];
  /** Shape id when running a convert strategy (normalizeGitmodules fail-closed). */
  readonly shapeId?: string;
}

export interface StepResult {
  readonly stepId: RemovalStepId;
  readonly removed: readonly string[];
  readonly modified: readonly string[];
}

/** Thrown when a step cannot proceed safely (e.g. submodule gitlink). */
export class RemovalStepError extends Error {
  readonly stepId: RemovalStepId;
  constructor(stepId: RemovalStepId, message: string) {
    super(message);
    this.name = "RemovalStepError";
    this.stepId = stepId;
  }
}

/** Host / wiring trees we may prune when emptied (F-012). */
const PRUNE_ROOTS = [
  ".agents",
  ".claude",
  ".cursor",
  ".codex",
  ".grok",
  ".github",
  ".githooks",
  ".deft",
] as const;

const HOST_HOOK_RELS = [
  ".claude/settings.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".grok/hooks/deft.json",
] as const;

const DIRECTIVE_PACKAGE_NAMES = new Set(["@deftai/directive", "@deftai/directive-runtime"]);

const GITIGNORE_SEED_LINES = new Set([
  "node_modules/",
  "node_modules",
  "/node_modules/",
  ".deft/directive/wiring-ready.*.json",
]);

function toPosix(p: string): string {
  return p.split(sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isPruneAllowed(relDir: string): boolean {
  const n = toPosix(relDir);
  if (!n || n === "." || n.includes("..")) return false;
  return PRUNE_ROOTS.some((root) => n === root || n.startsWith(`${root}/`));
}

function safeContainedRemove(root: string, rel: string): boolean {
  try {
    const result = containedRemove({
      root,
      target: rel,
      recursive: true,
    });
    return result.removed;
  } catch {
    return false;
  }
}

/**
 * After Directive removes an owned file/entry, prune empty ancestor dirs it
 * emptied. Stops at non-empty or foreign parents; only under known host trees (C4 / F-012).
 * @returns relative paths removed
 */
export function pruneEmptyAncestors(root: string, emptiedFrom: string): string[] {
  const removed: string[] = [];
  const rel = toPosix(emptiedFrom);
  if (!rel || rel === "." || rel.includes("..")) return removed;

  let dir = dirname(rel);
  while (dir && dir !== "." && dir !== "/") {
    if (!isPruneAllowed(dir)) break;
    const abs = join(root, dir);
    if (!existsSync(abs)) {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      continue;
    }
    let entries: string[];
    try {
      const st = lstatSync(abs);
      if (!st.isDirectory()) break;
      entries = readdirSync(abs);
    } catch {
      break;
    }
    if (entries.length > 0) break;
    if (!safeContainedRemove(root, dir)) break;
    removed.push(toPosix(dir));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return removed;
}

function isEmptyishObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

function depRecordOnlyDirective(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return true;
  return entries.every(([name]) => DIRECTIVE_PACKAGE_NAMES.has(name));
}

/** True when package.json is only Directive greenfield residue (private ± pin). */
export function isSoleAuthorPackageJson(pkg: Record<string, unknown>): boolean {
  if (pkg.private !== true) return false;
  for (const [key, value] of Object.entries(pkg)) {
    if (key === "private") continue;
    if (key === "scripts" && isEmptyishObject(value)) continue;
    if (key === "dependencies" || key === "devDependencies" || key === "peerDependencies") {
      if (isEmptyishObject(value) || depRecordOnlyDirective(value)) continue;
      return false;
    }
    return false;
  }
  return true;
}

function isNearEmptyNpmLock(parsed: Record<string, unknown>): boolean {
  const packages = parsed.packages;
  if (packages === undefined) {
    // lockfileVersion 1 style
    const deps = parsed.dependencies;
    return deps === undefined || isEmptyishObject(deps);
  }
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    return false;
  }
  const entries = Object.entries(packages as Record<string, unknown>);
  if (entries.length === 0) return true;
  if (entries.length === 1 && entries[0]?.[0] === "") {
    const rootPkg = entries[0][1];
    if (isEmptyishObject(rootPkg)) return true;
    if (rootPkg && typeof rootPkg === "object" && !Array.isArray(rootPkg)) {
      const r = rootPkg as Record<string, unknown>;
      const keys = Object.keys(r).filter((k) => k !== "name" && k !== "version");
      if (keys.length === 0) return true;
      return keys.every(
        (k) =>
          (k === "dependencies" || k === "devDependencies") &&
          (isEmptyishObject(r[k]) || depRecordOnlyDirective(r[k])),
      );
    }
  }
  // Only Directive package entries under packages
  return entries.every(([key, value]) => {
    if (key === "") {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const r = value as Record<string, unknown>;
      return ["dependencies", "devDependencies"].every(
        (k) => r[k] === undefined || isEmptyishObject(r[k]) || depRecordOnlyDirective(r[k]),
      );
    }
    return (
      key === "node_modules/@deftai/directive" ||
      key === "node_modules/@deftai/directive-runtime" ||
      key.startsWith("node_modules/@deftai/directive/") ||
      key.startsWith("node_modules/@deftai/directive-runtime/")
    );
  });
}

function isNearEmptyLockfile(abs: string): boolean {
  const body = readText(abs);
  if (body === null) return false;
  const trimmed = body.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 120 && !trimmed.includes("node_modules/")) return true;
  if (abs.endsWith("pnpm-lock.yaml")) {
    // Near-empty pnpm lock: no package snapshots beyond lockfileVersion / settings.
    if (
      !/^\s*[^#\s].*:/m.test(
        trimmed
          .replace(/^lockfileVersion:.*$/m, "")
          .replace(/^settings:[\s\S]*?(?=\n\S|\n*$)/m, ""),
      )
    ) {
      return trimmed.length < 200;
    }
    if (
      /importers:\s*\n\s*\.:\s*\n\s*(?:dependencies|devDependencies):\s*\n\s*\{\s*\}/.test(trimmed)
    ) {
      return !/packages:\s*\n\s*\S/.test(trimmed) || trimmed.length < 400;
    }
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return isNearEmptyNpmLock(parsed as Record<string, unknown>);
  } catch {
    return false;
  }
}

function isEmptyHostHooksFile(abs: string): boolean {
  const cfg = readJsonObject(abs);
  if (cfg === null) return false;
  const keys = Object.keys(cfg);
  if (keys.length === 0) return true;
  if (keys.length === 1 && keys[0] === "hooks" && isEmptyishObject(cfg.hooks)) return true;
  if (
    keys.length === 1 &&
    keys[0] === "version" &&
    (typeof cfg.version === "number" || typeof cfg.version === "string")
  ) {
    return true;
  }
  if (
    keys.length === 2 &&
    keys.includes("version") &&
    keys.includes("hooks") &&
    isEmptyishObject(cfg.hooks)
  ) {
    return true;
  }
  return false;
}

function isInstallSeededAgentsStub(body: string): boolean {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return true;
  if (normalized.includes("<!-- deft:managed-section")) return false;

  const seed = renderConsumerHeader().replace(/\r\n/g, "\n").trim();
  if (normalized === seed) return true;

  const fallback = [
    "# Project",
    "",
    CONSUMER_HEADER_PLACEHOLDER_ONELINER,
    "",
    "## Session orientation",
    "",
    "Scoped work → `xbrief/` lifecycle; ranked queue → `deft triage:queue`; tracked bugs → GitHub issues; identity → `xbrief/PROJECT-DEFINITION.xbrief.json`.",
  ]
    .join("\n")
    .trim();
  if (normalized === fallback) return true;

  if (!/^# Project\s*$/m.test(normalized)) return false;
  if (!/## Session orientation/.test(normalized)) return false;

  const oneLiner = unmanagedHeaderOneLiner(normalized);
  if (oneLiner !== null && oneLiner !== CONSUMER_HEADER_PLACEHOLDER_ONELINER) {
    return false;
  }

  const headings = [...normalized.matchAll(/^## .+$/gm)].map((m) => m[0] ?? "");
  const allowed = new Set(["## Session orientation", "## Local dev"]);
  if (!headings.every((h) => allowed.has(h))) return false;

  // Seed header is ~700–1100 bytes; refuse large custom bodies.
  return normalized.length < 1600;
}

function isSoleAuthorTaskfile(body: string): boolean {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return true;
  if (/^\s*deft\s*:/m.test(normalized)) return false;
  // Residue after stripping includes.deft from our greenfield seed.
  const withoutNoise = normalized
    .replace(/^version:\s*['"]?3['"]?\s*$/m, "")
    .replace(/^# Installed by Directive setup.*$/m, "")
    .replace(/^includes:\s*$/m, "")
    .replace(/^includes:\s*\{\s*\}\s*$/m, "")
    .trim();
  return withoutNoise.length === 0;
}

function isSoleAuthorGitignore(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return true;
  return lines.every((l) => GITIGNORE_SEED_LINES.has(l));
}

/**
 * Remove sole-author Directive residue: `{ "private": true }`-only package.json
 * we created, empty `{}` host hooks we created, install-seeded AGENTS stubs
 * with no user body (C5 / F-013). Callers may also prune via pruneEmptyAncestors.
 * @returns relative paths removed
 */
export function removeSoleAuthorHusks(root: string): string[] {
  const removed: string[] = [];

  const pushRemove = (rel: string): void => {
    if (safeContainedRemove(root, rel)) {
      removed.push(toPosix(rel));
      for (const parent of pruneEmptyAncestors(root, rel)) {
        removed.push(parent);
      }
    }
  };

  const pkgAbs = join(root, "package.json");
  const pkg = existsSync(pkgAbs) ? readJsonObject(pkgAbs) : null;
  const packageWasSoleAuthor = pkg !== null && isSoleAuthorPackageJson(pkg);
  if (packageWasSoleAuthor) {
    pushRemove("package.json");
  }

  for (const lock of ["package-lock.json", "pnpm-lock.yaml"] as const) {
    const abs = join(root, lock);
    if (!existsSync(abs)) continue;
    if (packageWasSoleAuthor) {
      pushRemove(lock);
      continue;
    }
    if (!existsSync(pkgAbs) && isNearEmptyLockfile(abs)) {
      pushRemove(lock);
    }
  }

  for (const rel of HOST_HOOK_RELS) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    if (isEmptyHostHooksFile(abs)) pushRemove(rel);
  }

  const agentsAbs = join(root, "AGENTS.md");
  if (existsSync(agentsAbs)) {
    const body = readText(agentsAbs);
    if (body !== null && isInstallSeededAgentsStub(body)) {
      pushRemove("AGENTS.md");
    }
  }

  const taskAbs = join(root, "Taskfile.yml");
  if (existsSync(taskAbs)) {
    const body = readText(taskAbs);
    if (body !== null && isSoleAuthorTaskfile(body)) {
      pushRemove("Taskfile.yml");
    }
  }

  const giAbs = join(root, ".gitignore");
  if (existsSync(giAbs)) {
    const body = readText(giAbs);
    if (body !== null && isSoleAuthorGitignore(body)) {
      pushRemove(".gitignore");
    }
  }

  return [...new Set(removed)];
}

const GITHOOK_RELS = [
  ".githooks/pre-commit",
  ".githooks/pre-push",
  ".githooks/_directive-run.sh",
] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isManagedHookCommand(command: string): boolean {
  return (
    command.includes(HOOK_BIN_COMMAND) ||
    command.includes("directive-runtime/dist/hook-bin.js") ||
    command.includes(".deft/core/") ||
    /(^|[\s"`'])deft-hook([\s"`']|$)/.test(command) ||
    command.includes("deft hook:dispatch")
  );
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
    if ("version" in rest && Object.keys(rest).length === 1) {
      const { version: _v, ...rest2 } = rest;
      return rest2;
    }
    return rest;
  }
  return { ...cfg, hooks: nextHooks };
}

function isOurSkillPointer(body: string): boolean {
  return (
    body.includes(RUNTIME_PREFIX) ||
    body.includes("npm i -g @deftai/directive") ||
    body.includes(".deft/core/") ||
    body.includes("Read and follow:")
  );
}

function isOurGitHook(rel: string, body: string): boolean {
  if (rel.endsWith("_directive-run.sh")) return true;
  return (
    body.includes("_directive-run.sh") ||
    body.includes(RUNTIME_PREFIX) ||
    body.includes("run_directive") ||
    body.includes(".deft/core/")
  );
}

/** True when parent git index records `deft` as a gitlink (mode 160000). */
export function isUnsafeSubmoduleGitlink(root: string): boolean {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-s", "--", "deft"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split(/\r?\n/)) {
      if (/^160000\s/.test(line.trim())) return true;
    }
  } catch {
    /* no git / not a repo / deft untracked — treat as safe fs-only cleanup */
  }
  return false;
}

/**
 * Remove `.deft/core` (even if edited). Used by vendored-core-go / dual / hybrid.
 */
export function removeCopiedCore(root: string): string[] {
  const removed: string[] = [];
  if (existsSync(join(root, ".deft", "core"))) {
    if (safeContainedRemove(root, ".deft/core")) {
      removed.push(".deft/core");
    }
  }
  return removed;
}

/**
 * Remove framework-marked top-level `deft/` tree when present.
 * Does not touch xbrief/ or user content outside deft/.
 */
export function removeDeftFrameworkTree(root: string): string[] {
  const removed: string[] = [];
  const deftAbs = join(root, "deft");
  if (!existsSync(deftAbs)) return removed;
  if (safeContainedRemove(root, "deft")) {
    removed.push("deft");
  }
  return removed;
}

/** Strip Directive-owned host hook registrations; leave foreign entries. */
export function clearOwnedHookEntries(root: string): StepResult {
  const removed: string[] = [];
  const modified: string[] = [];
  for (const rel of HOST_HOOK_RELS) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const cfg = readJsonObject(abs);
    if (cfg === null) continue;
    const stripped = stripHostHooks(cfg);
    const prior = readText(abs) ?? "";
    const next = `${JSON.stringify(stripped, null, 2)}\n`;
    if (next === prior) continue;
    const keys = Object.keys(stripped);
    const emptyAfterStrip =
      keys.length === 0 ||
      (keys.length === 1 && keys[0] === "hooks" && isEmptyishObject(stripped.hooks)) ||
      (keys.length === 1 && keys[0] === "version") ||
      (keys.length === 2 &&
        keys.includes("version") &&
        keys.includes("hooks") &&
        isEmptyishObject(stripped.hooks));
    if (emptyAfterStrip) {
      if (safeContainedRemove(root, rel)) {
        removed.push(toPosix(rel));
        removed.push(...pruneEmptyAncestors(root, rel));
      }
      continue;
    }
    writeFileSync(abs, next);
    modified.push(`${toPosix(rel)}#hooks`);
  }
  for (const rel of GITHOOK_RELS) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const body = readText(abs);
    if (body === null) continue;
    if (!isOurGitHook(rel, body)) continue;
    if (safeContainedRemove(root, rel)) {
      removed.push(toPosix(rel));
      removed.push(...pruneEmptyAncestors(root, rel));
    }
  }
  return { stepId: "clearOwnedHookEntries", removed, modified };
}

/** Remove wholly-owned skill pointer files (Directive thin wrappers). */
export function removeOwnedSkillPointers(root: string): string[] {
  const removed: string[] = [];
  for (const host of SKILL_HOST_ROOTS) {
    for (const entry of SKILL_POINTER_INVENTORY) {
      const rel = `${host}/${entry.dir}/SKILL.md`;
      const body = readText(join(root, rel));
      if (body === null) continue;
      if (!isOurSkillPointer(body)) continue;
      if (safeContainedRemove(root, rel)) {
        removed.push(toPosix(rel));
        removed.push(...pruneEmptyAncestors(root, rel));
      }
    }
  }
  return removed;
}

/**
 * Strip exact `@deftai/directive` / leftover runtime pins from package.json
 * when converting (hybrid / leftover). Lockfile is refreshed by subsequent PM add.
 */
export function stripLegacyLauncherPin(root: string): StepResult {
  const removed: string[] = [];
  const modified: string[] = [];
  const abs = join(root, "package.json");
  if (!existsSync(abs)) return { stepId: "stripLegacyLauncherPin", removed, modified };
  const pkg = readJsonObject(abs);
  if (pkg === null) return { stepId: "stripLegacyLauncherPin", removed, modified };
  let changed = false;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const block = pkg[key];
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    const deps = block as Record<string, unknown>;
    for (const name of DIRECTIVE_PACKAGE_NAMES) {
      if (name in deps) {
        delete deps[name];
        changed = true;
      }
    }
    if (Object.keys(deps).length === 0) {
      delete pkg[key];
    }
  }
  if (!changed) return { stepId: "stripLegacyLauncherPin", removed, modified };
  writeFileSync(abs, `${JSON.stringify(pkg, null, 2)}\n`);
  modified.push("package.json");
  return { stepId: "stripLegacyLauncherPin", removed, modified };
}

/** Clear sparse `.deft/VERSION` (orphan marker) when safe. Preserves other .deft contents. */
export function removeOrphanDeftVersion(root: string): string[] {
  const removed: string[] = [];
  const rel = ".deft/VERSION";
  if (!existsSync(join(root, ".deft", "VERSION"))) return removed;
  // Refuse if .deft/core still exists — wrong step for that shape.
  if (existsSync(join(root, ".deft", "core"))) return removed;
  if (safeContainedRemove(root, rel)) {
    removed.push(rel);
    removed.push(...pruneEmptyAncestors(root, rel));
  }
  return removed;
}

/**
 * Normalize `.gitmodules` / leftover submodule metadata after deft/ removal.
 * Fail closed when parent index still has a gitlink (mode 160000) — caller must
 * leave unsupported-honest rather than corrupt the index.
 */
export function normalizeGitmodules(root: string): StepResult {
  if (isUnsafeSubmoduleGitlink(root)) {
    throw new RemovalStepError(
      "normalizeGitmodules",
      "submodule-deft: gitlink (mode 160000) for deft/ is still in the git index; " +
        "automatic convert refuses. Run `git submodule deinit -f deft` and `git rm -f deft` " +
        "(or remove the gitlink), then `directive upgrade` / `directive install`.",
    );
  }
  const removed: string[] = [];
  const modified: string[] = [];
  const gmAbs = join(root, ".gitmodules");
  if (existsSync(gmAbs)) {
    const text = readText(gmAbs);
    if (text !== null) {
      // Drop submodule stanzas whose path is deft / .deft or url mentions deftai/directive.
      const next = text.replace(
        /(^|\n)(\[submodule\s+[^\]]+\])([\s\S]*?)(?=\n\[submodule|\n*$)/g,
        (full, lead: string, _header: string, body: string) => {
          const lower = body.toLowerCase();
          const pathDeft = /(^|\n)\s*path\s*=\s*\.?deft(\/|\s|$)/.test(lower);
          const urlDirective = lower.includes("deftai/directive");
          if (pathDeft || urlDirective) return lead === "\n" ? "\n" : "";
          return full;
        },
      );
      const cleaned = next.replace(/\n{3,}/g, "\n\n").trim();
      if (cleaned.length === 0) {
        if (safeContainedRemove(root, ".gitmodules")) {
          removed.push(".gitmodules");
        }
      } else if (cleaned !== text.replace(/\r\n/g, "\n").trim()) {
        writeFileSync(gmAbs, `${cleaned}\n`);
        modified.push(".gitmodules");
      }
    }
  }
  return { stepId: "normalizeGitmodules", removed, modified };
}

/** Dispatch a named removal step. */
export function runStep(stepId: RemovalStepId, ctx: StepContext): StepResult {
  switch (stepId) {
    case "pruneEmptyAncestors": {
      const seeds =
        ctx.emptiedFrom !== undefined ? [ctx.emptiedFrom] : [...(ctx.priorRemoved ?? [])];
      if (seeds.length === 0) {
        // Standalone call still requires a seed (uninstall / unit API).
        throw new Error("pruneEmptyAncestors requires ctx.emptiedFrom or ctx.priorRemoved");
      }
      const removed: string[] = [];
      for (const seed of seeds) {
        removed.push(...pruneEmptyAncestors(ctx.root, seed));
      }
      return { stepId, removed: [...new Set(removed)], modified: [] };
    }
    case "removeSoleAuthorHusks": {
      const removed = removeSoleAuthorHusks(ctx.root);
      return { stepId, removed, modified: [] };
    }
    case "removeCopiedCore": {
      return { stepId, removed: removeCopiedCore(ctx.root), modified: [] };
    }
    case "removeDeftFrameworkTree": {
      return { stepId, removed: removeDeftFrameworkTree(ctx.root), modified: [] };
    }
    case "clearOwnedHookEntries": {
      return clearOwnedHookEntries(ctx.root);
    }
    case "removeOwnedSkillPointers": {
      return { stepId, removed: removeOwnedSkillPointers(ctx.root), modified: [] };
    }
    case "stripLegacyLauncherPin": {
      return stripLegacyLauncherPin(ctx.root);
    }
    case "removeOrphanDeftVersion": {
      return { stepId, removed: removeOrphanDeftVersion(ctx.root), modified: [] };
    }
    case "normalizeGitmodules": {
      return normalizeGitmodules(ctx.root);
    }
    default: {
      const _exhaustive: never = stepId;
      throw new Error(`removal step '${String(_exhaustive)}' not implemented`);
    }
  }
}
