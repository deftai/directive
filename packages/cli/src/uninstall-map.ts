/**
 * Launcher ownership/removal map for uninstall (R11 / AC11.*).
 * Node builtins only — no runtime/core dependency (AC3.1).
 *
 * Discovery merges the persistent GENERATION ownership record with the
 * launcher's known-artifact map for current and latest-legacy layouts.
 * Bounded cleanup: never treat a recorded path as authority to delete
 * arbitrary user content.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { LAUNCHER_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from "./constants.js";
import { filesWithDirectiveLines, removeDirectiveWrittenLines } from "./retired-lines.js";

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

/** Mirrors core `CONSUMER_SKILL_DISCOVERY_INVENTORY` dirs (drift test in uninstall-bookend.test.ts). */
const SKILL_DIRS = [
  "deft",
  "deft-directive-setup",
  "deft-directive-build",
  "deft-directive-review-cycle",
  "deft-directive-refinement",
  "deft-directive-swarm",
  "deft-directive-interview",
  "deft-directive-portfolio-priority",
  "deft-directive-pre-pr",
  "deft-directive-sync",
  "deft-directive-tutorial",
  "deft-directive-feedback",
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
  ".agents/hooks.json",
] as const;

/** agy hook file: shared with the user's hooks, so Directive owns only its named entry (#7438). */
const AGY_HOOK_REL = ".agents/hooks.json";
const AGY_ENTRY_KEY = "zzzz-directive";

/**
 * Host dirs for the v261027 committed `deft-hook-<sha8>.mjs` outers (AC9.1).
 * Mirrors core `HOST_HOOK_OUTER_DIRS`; the launcher cannot import core (AC3.1).
 */
export const HOST_HOOK_OUTER_DIRS = [
  ".claude",
  ".codex",
  ".cursor/hooks",
  ".grok/hooks",
  ".agents",
] as const;

const HOST_HOOK_OUTER_FILE_RE = /^deft-hook-[a-f0-9]{8}\.mjs$/;

/** Any mention of an outer file name inside a host config's text. */
const HOST_HOOK_OUTER_TEXT_RE = /deft-hook-[a-f0-9]{8}\.mjs/;

/** True for `<host dir>/deft-hook-<sha8>.mjs` in one of the four host dirs. */
function isHostHookOuterRel(rel: string): boolean {
  const slash = rel.lastIndexOf("/");
  if (slash < 0) return false;
  const dir = rel.slice(0, slash);
  return (
    (HOST_HOOK_OUTER_DIRS as readonly string[]).includes(dir) &&
    HOST_HOOK_OUTER_FILE_RE.test(rel.slice(slash + 1))
  );
}

/** A plain argument token: flags and values only, no shell syntax. */
const PLAIN_ARG_TOKEN_RE = /^[A-Za-z0-9_.:=-]+$/;

/**
 * True when the whole command is the v261027 `.mjs` outer form
 * (`node <host dir>/deft-hook-<sha8>.mjs [--flag value]…`). A user command
 * chained after it (`&&`, `;`, newline, extra words) does not count, so
 * uninstall keeps that entry. Mirrors the outer branch of core
 * `isDirectiveHookCommand` (AC3.1: no core import).
 */
function isHostHookOuterCommand(command: string): boolean {
  if (/[\r\n]/.test(command)) return false;
  const tokens = command.trim().split(/[ \t]+/);
  const target = tokens[1] ?? "";
  if (tokens[0] !== "node" || !isHostHookOuterRel(target.replace(/^\.\//, ""))) return false;
  return hasOnlyPlainFlags(tokens.slice(2));
}

/** Only `--flag` or `--flag value` pairs of plain tokens: a bare word would be another command. */
function hasOnlyPlainFlags(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] ?? "";
    if (!flag.startsWith("--") || !PLAIN_ARG_TOKEN_RE.test(flag)) return false;
    const value = args[i + 1];
    if (value !== undefined && !value.startsWith("-")) {
      if (!PLAIN_ARG_TOKEN_RE.test(value)) return false;
      i++;
    }
  }
  return true;
}

/**
 * True when the whole command is Directive's agy outer: agy runs hooks from `.agents/`,
 * so the command names the bare file (`node deft-hook-<sha8>.mjs --host agy --event …`).
 * Mirrors core `isManagedAgyHookEntry` per command (AC3.1: no core import).
 */
function isAgyOuterCommand(command: string): boolean {
  if (/[\r\n]/.test(command)) return false;
  const tokens = command.trim().split(/[ \t]+/);
  const target = (tokens[1] ?? "").replace(/^\.\//, "");
  if (tokens[0] !== "node" || !HOST_HOOK_OUTER_FILE_RE.test(target)) return false;
  const args = tokens.slice(2);
  const host = args.indexOf("--host");
  return host >= 0 && args[host + 1] === "agy" && hasOnlyPlainFlags(args);
}

/** Every command text of the named agy entry, in grouped or flat hook lists. */
function agyEntryCommandTexts(entry: unknown): string[] {
  const record = object(entry);
  if (record === null) return [];
  const texts: string[] = [];
  for (const list of Object.values(record)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const group = object(item);
      const hooks = group !== null && Array.isArray(group.hooks) ? group.hooks : [item];
      for (const hook of hooks) {
        const text = hookEntryCommandText(hook);
        if (text !== null) texts.push(text);
      }
    }
  }
  return texts;
}

/** Drop Directive's named entry from an agy hook file; foreign entries stay byte for byte. */
function stripAgyEntry(cfg: Record<string, unknown>): Record<string, unknown> {
  const texts = agyEntryCommandTexts(cfg[AGY_ENTRY_KEY]);
  if (texts.length === 0 || !texts.every(isAgyOuterCommand)) return cfg;
  const { [AGY_ENTRY_KEY]: _managed, ...rest } = cfg;
  return rest;
}

/** Committed `.mjs` outers on disk (any sha8) in the four host dirs. */
function listHostHookOuters(projectRoot: string): string[] {
  const out: string[] = [];
  for (const dir of HOST_HOOK_OUTER_DIRS) {
    let names: string[] = [];
    try {
      names = readdirSync(join(projectRoot, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (HOST_HOOK_OUTER_FILE_RE.test(name)) out.push(`${dir}/${name}`);
    }
  }
  return out;
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

function parseOwnershipArtifacts(projectRoot: string): {
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
  // Match setup-wiring: managed shape only (not bare `.deft/core`).
  return (
    body.includes("_directive-run.sh") ||
    body.includes("_deft-run.sh") ||
    body.includes(RUNTIME_PREFIX) ||
    /\brun_deft\s+(verify:|preflight)/.test(body)
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
    if (
      !out.some((a) => a.path === art.path && a.kind === art.kind && a.entryKey === art.entryKey)
    ) {
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

  // v261027 host `.mjs` outers; removed after registrations (AC11.4 ordering).
  for (const rel of listHostHookOuters(projectRoot)) {
    push({ path: rel, kind: "whole-file", source: "known-map" });
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
  const { inspection, artifacts: fromRecord, rejected } = parseOwnershipArtifacts(projectRoot);
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
    existsSync(join(projectRoot, ".deft", "GENERATION.json")) ||
    // Lines left by an earlier partial uninstall still count, so a retry removes them.
    filesWithDirectiveLines(projectRoot).length > 0;
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
    isHostHookOuterCommand(command) ||
    /(^|[\s"`'])deft-hook([\s"`']|$)/.test(command) ||
    command.includes("deft hook:dispatch")
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * SHA-256 of Directive's no-shell hook locator source (AC9.1 v261119), core
 * `HOST_HOOK_LOCATOR_SOURCE`. The launcher keeps only the hash (AC3.1: no
 * core import; the bundle stays free of the locator's code); a test keeps it
 * equal to core's.
 */
export const DIRECTIVE_HOOK_LOCATOR_SHA256 =
  "e3b58aa1a0311f26d8c74ff56ceb335f4653cabc09c979ef7b13403f12fd5d66";

function isDirectiveHookLocator(source: string): boolean {
  return (
    createHash("sha256").update(source, "utf8").digest("hex") === DIRECTIVE_HOOK_LOCATOR_SHA256
  );
}

/**
 * Command text of one hook entry. Directive's locator entry
 * (`"command": "node", "args": ["-e", <locator>, "--", <outer rel>, …]`,
 * AC9.1 v261119) reads as `node <outer rel> …`, so it matches like the outer
 * form. Any other `node -e` script keeps its own text and is never taken for
 * Directive's. Mirrors core `hostHookEntryText` (AC3.1: no core import).
 */
function hookEntryCommandText(value: unknown): string | null {
  const hook = object(value);
  if (hook === null || typeof hook.command !== "string") return null;
  const { command, args } = hook;
  if (args === undefined) return command;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return null;
  if (
    command === "node" &&
    args[0] === "-e" &&
    isDirectiveHookLocator(args[1] ?? "") &&
    args[2] === "--"
  ) {
    return ["node", ...args.slice(3)].join(" ");
  }
  return [command, ...args].join(" ");
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
    const filtered: unknown[] = [];
    for (const entry of value) {
      const e = object(entry);
      if (e === null) {
        filtered.push(entry);
        continue;
      }
      const entryText = hookEntryCommandText(e);
      if (entryText !== null && isManagedHookCommand(entryText)) continue;
      if (Array.isArray(e.hooks)) {
        // Drop only Directive commands; keep a group that still holds user commands.
        const kept = e.hooks.filter((h) => {
          const text = hookEntryCommandText(h);
          return !(text !== null && isManagedHookCommand(text));
        });
        if (kept.length === e.hooks.length) filtered.push(entry);
        else if (kept.length > 0) filtered.push({ ...e, hooks: kept });
        continue;
      }
      filtered.push(entry);
    }
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
  const blockRe = /(^|\n)([ \t]*)deft:\s*(?:#.*)?\n(?:\2[ \t]+[^\n]*\n)*/;
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
 * Strip Directive's entry from `.agents/hooks.json` (entry-owned, #7438): a file with only
 * foreign hooks keeps its bytes, and the file goes only when nothing else is left in it.
 */
function stripAgyHookFile(
  projectRoot: string,
  cfg: Record<string, unknown>,
  modified: string[],
  removed: string[],
  leftovers: string[],
  uncertainty: string[],
): void {
  const stripped = stripAgyEntry(cfg);
  if (stripped === cfg) return;
  if (Object.keys(stripped).length === 0) {
    if (safeUnlink(projectRoot, AGY_HOOK_REL)) {
      removed.push(AGY_HOOK_REL);
      removed.push(...maybeRemoveEmptyParents(projectRoot, AGY_HOOK_REL));
    } else {
      leftovers.push(AGY_HOOK_REL);
    }
    return;
  }
  if (safeWriteText(projectRoot, AGY_HOOK_REL, `${JSON.stringify(stripped, null, 2)}\n`)) {
    modified.push(`${AGY_HOOK_REL}#${AGY_ENTRY_KEY}`);
  } else {
    uncertainty.push(`refused write outside project: ${AGY_HOOK_REL}`);
  }
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
    uncertainty.push(`rejected unsafe ownership path (escape/absolute): ${bad}`);
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
      if (art.path === AGY_HOOK_REL) {
        stripAgyHookFile(projectRoot, cfg, modified, removed, leftovers, uncertainty);
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
          if (safeWriteText(projectRoot, art.path, next.endsWith("\n") ? next : `${next}\n`)) {
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
      if (cfg !== null && art.path === AGY_HOOK_REL) {
        stripAgyHookFile(projectRoot, cfg, modified, removed, leftovers, uncertainty);
      } else if (cfg !== null) {
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

    // AC11.4: hook `.mjs` files wait until registrations are confirmed gone (below).
    if (isHostHookOuterRel(art.path)) continue;
    if (safeUnlink(projectRoot, art.path)) {
      removed.push(art.path);
      if (art.path.includes("/")) {
        removed.push(...maybeRemoveEmptyParents(projectRoot, art.path));
      }
    }
  }

  // Remove the `.mjs` hook files only when no host config still registers one.
  // A config that could not be cleaned keeps its files, reported as leftovers.
  const outers = [
    ...new Set([
      ...discovery.artifacts.map((a) => a.path).filter(isHostHookOuterRel),
      ...listHostHookOuters(projectRoot),
    ]),
  ].filter((rel) => existsSync(join(projectRoot, rel)));
  const stillRegistered = HOST_HOOK_RELS.filter((rel) =>
    HOST_HOOK_OUTER_TEXT_RE.test(readText(join(projectRoot, rel)) ?? ""),
  );
  if (stillRegistered.length > 0 && outers.length > 0) {
    leftovers.push(...stillRegistered.map((rel) => `${rel}#hooks`), ...outers);
    uncertainty.push(
      `kept ${outers.length} hook .mjs file(s): ${stillRegistered.join(", ")} still register them`,
    );
  } else {
    for (const rel of outers) {
      if (safeUnlink(projectRoot, rel)) {
        removed.push(rel);
        removed.push(...maybeRemoveEmptyParents(projectRoot, rel));
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
        leftovers.push(...left.map((n) => `.deft/directive/${n}`));
        uncertainty.push(`.deft/directive retains unrecognized entries; not removed wholesale`);
      }
    } catch {
      /* ignore */
    }
  }
  if (existsSync(join(projectRoot, ".deft", "GENERATION.json"))) {
    if (safeUnlink(projectRoot, ".deft/GENERATION.json")) removed.push(".deft/GENERATION.json");
  }

  // Directive-written lines in shared files (AC8.10 / AC13.3); the files stay.
  const lines = removeDirectiveWrittenLines(projectRoot, (rel, body) =>
    safeWriteText(projectRoot, rel, body),
  );
  modified.push(...lines.modified);
  leftovers.push(...lines.leftovers);
  uncertainty.push(...lines.uncertainty);

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
      stdio: ["ignore", "pipe", "ignore"],
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

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when two paths name the same folder (symlinks and `C:/` vs `C:\\` resolved). */
function samePath(a: string, b: string): boolean {
  return relative(realOrResolved(a), realOrResolved(b)) === "";
}

/**
 * Other worktrees of this repository that still use Directive git hooks, so
 * the shared `core.hooksPath` must stay (AC11.6 / §A9).
 */
export function siblingWorktreesNeedingHooksPath(projectRoot: string): string[] {
  const out: string[] = [];
  for (const wt of listLinkedWorktreePaths(projectRoot)) {
    if (samePath(wt, projectRoot)) continue;
    if (
      existsSync(join(wt, ".githooks", "_directive-run.sh")) ||
      existsSync(join(wt, ".deft", "GENERATION.json"))
    ) {
      out.push(wt);
    }
  }
  return out;
}

/**
 * Registered git worktrees inside the project folder, as project-relative
 * POSIX paths (#6007 / D-025). Uninstall never touches them; it names them.
 */
export function registeredWorktreesInsideProject(projectRoot: string): string[] {
  const root = realOrResolved(projectRoot);
  const out: string[] = [];
  for (const wt of listLinkedWorktreePaths(projectRoot)) {
    const rel = relative(root, realOrResolved(wt));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    out.push(rel.replace(/\\/g, "/"));
  }
  return out.sort();
}

/** `.gitignore` lines setup seeds; mirrors the runtime's sole-author rule (F-013). */
const GITIGNORE_SEED_LINES: ReadonlySet<string> = new Set([
  "node_modules/",
  "node_modules",
  "/node_modules/",
  ".deft/directive/wiring-ready.*.json",
]);

/** Directive housekeeping at the project root that uninstall keeps (D-025). */
const KEPT_ROOT_ENTRIES = [".deft-cache", ".deft-scratch", ".deft-run-summary.json"] as const;

/** `.deft/` entries uninstall removes itself, or reports as leftovers. */
const DEFT_DIR_REMOVED = new Set(["GENERATION.json", "core", "directive"]);

function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Directive data that uninstall keeps and lists (D-025 / AC11.2 / AC11.7):
 * `.deft/` policy and state files, `.deft-cache/`, `.deft-scratch/`,
 * `.deft-run-summary.json`, and Directive lines left in `.gitignore`.
 * `xbrief/` is reported separately as preserved project data.
 */
export function listKeptDirectiveData(projectRoot: string): string[] {
  const out: string[] = [];
  const deftDir = join(projectRoot, ".deft");
  if (isDirectory(deftDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(deftDir).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      if (DEFT_DIR_REMOVED.has(name)) continue;
      out.push(isDirectory(join(deftDir, name)) ? `.deft/${name}/` : `.deft/${name}`);
    }
  }
  for (const rel of KEPT_ROOT_ENTRIES) {
    const abs = join(projectRoot, rel);
    if (existsSync(abs)) out.push(isDirectory(abs) ? `${rel}/` : rel);
  }
  const gitignore = readText(join(projectRoot, ".gitignore"));
  const ignoreLines = (gitignore ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  // A `.gitignore` holding only setup's seed lines is removed with the rest (F-013).
  const soleAuthor = ignoreLines.every((l) => GITIGNORE_SEED_LINES.has(l));
  if (!soleAuthor && ignoreLines.some((l) => /^\/?\.deft([/-]|$)/.test(l))) {
    out.push(".gitignore (Directive lines)");
  }
  return out;
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
  if (siblingWorktreesNeedingHooksPath(projectRoot).length > 0) {
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
  for (const rel of listHostHookOuters(projectRoot)) leftovers.push(rel);
  for (const rel of HOST_HOOK_RELS) {
    const body = readText(join(projectRoot, rel));
    if (body !== null && HOST_HOOK_OUTER_TEXT_RE.test(body)) leftovers.push(`${rel}#hooks`);
  }
  for (const rel of filesWithDirectiveLines(projectRoot))
    leftovers.push(`${rel} (Directive lines)`);
  return { complete: leftovers.length === 0, leftovers };
}

/** Manifest and lockfiles the package manager needs for its remove (#5999). */
export const MANIFEST_RELS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

/** Bytes of the manifest and lockfiles before the repository uninstaller runs. */
export function snapshotManifestFiles(projectRoot: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  for (const rel of MANIFEST_RELS) {
    try {
      snap.set(rel, readFileSync(join(projectRoot, rel)));
    } catch {
      /* absent */
    }
  }
  return snap;
}

/**
 * Write back manifest files an older repository uninstaller deleted before the
 * package manager ran (#5999). Restores the pre-uninstall bytes exactly.
 * @returns the restored paths
 */
export function restoreManifestFiles(projectRoot: string, snap: Map<string, Buffer>): string[] {
  const restored: string[] = [];
  for (const [rel, bytes] of snap) {
    const abs = join(projectRoot, rel);
    try {
      // Anything at the path (even a dangling symlink) means: leave it alone.
      lstatSync(abs);
      continue;
    } catch {
      /* absent: restore */
    }
    try {
      // Create only: O_EXCL fails if anything appeared at the path, and
      // O_NOFOLLOW (where the platform has it) refuses a symlink leaf.
      const fd = openSync(
        abs,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
      );
      try {
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      restored.push(rel);
    } catch {
      /* reported by the completion check */
    }
  }
  return restored;
}

const DIRECTIVE_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  LAUNCHER_PACKAGE_NAME,
  RUNTIME_PACKAGE_NAME,
]);

function isEmptyObject(value: unknown): boolean {
  const o = object(value);
  return o !== null && Object.keys(o).length === 0;
}

/**
 * True when package.json is only Directive greenfield residue: `"private": true`
 * plus at most empty `scripts` and Directive-only dependency maps. Launcher copy
 * of the runtime's `isSoleAuthorPackageJson` (drift test in uninstall-bookend.test.ts).
 */
export function isSoleAuthorPackageJson(pkg: Record<string, unknown>): boolean {
  if (pkg.private !== true) return false;
  for (const [key, value] of Object.entries(pkg)) {
    if (key === "private") continue;
    if (key === "scripts" && isEmptyObject(value)) continue;
    if (key === "dependencies" || key === "devDependencies" || key === "peerDependencies") {
      const deps = object(value);
      if (deps !== null && Object.keys(deps).every((name) => DIRECTIVE_PACKAGE_NAMES.has(name))) {
        continue;
      }
      return false;
    }
    return false;
  }
  return true;
}

/**
 * After a successful package-manager remove: delete a sole-author package.json
 * and its lockfiles (F-013 / C5, moved here from the repository uninstaller by
 * #5999). Leaves a user-authored manifest alone (AC11.7).
 * @returns removed paths
 */
export function removeSoleAuthorManifest(projectRoot: string): string[] {
  const pkg = readJsonObject(join(projectRoot, "package.json"));
  if (pkg === null || !isSoleAuthorPackageJson(pkg)) return [];
  const removed: string[] = [];
  for (const rel of ["package.json", "package-lock.json", "pnpm-lock.yaml"] as const) {
    if (safeUnlink(projectRoot, rel)) removed.push(rel);
  }
  return removed;
}
