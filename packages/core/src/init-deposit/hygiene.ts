/**
 * Scoped staging + installer-managed allowlist for TS-native init/update (#1453).
 *
 * Mirrors cmd/deft-install/hygiene.go + deposit.go installerManagedMatchers.
 *
 * CRITICAL (#1430 / #3030): the allowlist MUST honor the SPEC consumer-path
 * denylist (`CONSUMER_GUARD_MUST_FIRE`). Consumer-authored PROJECT-DEFINITION
 * and scope briefs are never installer-managed; if they reappear in
 * `installerManagedMatchers()`, unit tests and deposit-time assert fail closed.
 *
 * Refs #1576, #1453, #1430, #3029, #3030, #3127, #3117, #3193, #3393.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { containedRemove } from "../fs/contained-write.js";
import {
  activeMutationLedger,
  isCollectOnlyActive,
  type MutationSummary,
  snapshotMutationSummary,
} from "../fs/mutation-ledger.js";
import { applyCoreGuardWithBranchSync, type BranchSyncDetection } from "../policy/branch-sync.js";
import { gitPorcelain } from "../story-ready/git.js";
import { CANONICAL_INSTALL_ROOT, type InitDepositIo } from "./constants.js";
import { CONSUMER_SKILL_DISCOVERY_INVENTORY } from "./skill-discovery-deposit.js";
import { hostSkillRelativePath, listSkillDiscoveryHosts } from "./skill-discovery-hosts.js";
import { slashCommandManagedExactPaths } from "./slash-deposit.js";

export const CODEQL_CONFIG_REL = ".github/codeql/codeql-config.yml";
export const CORE_GUARD_WORKFLOW_REL = ".github/workflows/deft-core-guard.yml";

// The lifecycle dir names are identical across the legacy `vbrief/` tree and the
// post-#2034 / #2110 `xbrief/` tree, so both allowlist families reuse this list.
const VBRIEF_LIFECYCLE_DIRS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

export interface InstallerManagedMatcher {
  readonly exact?: string;
  readonly prefix?: string;
}

/**
 * Consumer paths that MUST trip no-mixed-core-and-app when mixed with
 * `.deft/core/**` (#1430 SPEC). These probe paths must never match
 * `installerManagedMatchers()` / the deposited guard ERE.
 *
 * Legitimate installer scaffolding (xbrief/.deft-version, lifecycle .gitkeep,
 * schemas/, migration/, xbrief.md) is NOT in this denylist — see #2277.
 * Init may still *create* PROJECT-DEFINITION (#3013); create ≠ allowlist.
 *
 * Refs #3030, #3029, #1430.
 */
export const CONSUMER_GUARD_MUST_FIRE: readonly string[] = [
  "xbrief/PROJECT-DEFINITION.xbrief.json",
  "vbrief/PROJECT-DEFINITION.vbrief.json",
  // Representative consumer scope briefs (not scaffolding markers).
  "xbrief/active/example-scope.xbrief.json",
  "vbrief/active/example-scope.vbrief.json",
  "xbrief/proposed/example-scope.xbrief.json",
  "vbrief/pending/example-scope.vbrief.json",
];

/** Exact managed multi-host skill pointer paths only (#75 Greptile P1). */
function multiHostSkillDiscoveryManagedMatchers(): InstallerManagedMatcher[] {
  // Exact SKILL.md paths only so consumer-authored siblings under the same
  // host skills tree stay app-owned (not staged / not guard-exempt).
  const matchers: InstallerManagedMatcher[] = [];
  for (const host of listSkillDiscoveryHosts()) {
    for (const skill of CONSUMER_SKILL_DISCOVERY_INVENTORY) {
      matchers.push({ exact: hostSkillRelativePath(host, skill.dir) });
    }
  }
  return matchers;
}

/** Single source of truth for installer-managed paths (#1440 / #1576). */
export function installerManagedMatchers(): InstallerManagedMatcher[] {
  return [
    { exact: "AGENTS.md" },
    { prefix: ".agents/" },
    // Multi-host skill discovery thin pointers (#75 residual) — not slash commands (#55).
    // Exact inventory paths only; never claim the whole host skills tree.
    ...multiHostSkillDiscoveryManagedMatchers(),
    { prefix: ".githooks/" },
    { exact: ".claude/settings.json" },
    { exact: ".grok/hooks/deft.json" },
    { exact: ".cursor/hooks.json" },
    // Official Cursor adapter only (#3393). Exact paths — not a `.cursor/hooks/`
    // prefix — so consumer-authored hooks stay app. Consumers using
    // `pull_request_target` or pinned workflow refs evaluate the deposited
    // guard from the previous allowlist for one PR; document, do not work around.
    { exact: ".cursor/hooks/deft-cursor-hook-adapter.mjs" },
    { exact: ".cursor/hooks/deft-cursor-hook-adapter.test.mjs" },
    { exact: ".codex/hooks.json" },
    // Multi-host slash product files only (#3054 / L8 prefer commit).
    // Exact paths — not directory prefixes — so consumer custom commands under
    // the same host dirs stay app-owned for staging + no-mixed-core-and-app.
    ...slashCommandManagedExactPaths().map((exact) => ({ exact })),
    { exact: ".gitattributes" },
    { exact: ".gitignore" },
    // Installer-deposited Prettier gate exclusion (#2534); must be allowlisted or
    // framework-only deposit PRs trip no-mixed-core-and-app (#2629).
    { exact: ".prettierignore" },
    { exact: "greptile.json" },
    { exact: CODEQL_CONFIG_REL },
    { exact: CORE_GUARD_WORKFLOW_REL },
    { exact: "Taskfile.yml" },
    // Upgrade co-travel unit (#3127 / #3193): path-allow package/lock + GENERATION
    // so they are not auto-classified as "app". When mixed with .deft/core/**, the
    // deposited guard + classifyMixedCoreAndAppContentAware additionally require
    // package.json to be @deftai/directive* dependency-key pin-only and lockfiles
    // to be pin follow-through (not unrelated direct product deps). GENERATION
    // stays path-only (#3117). True app/product paths still fail (#1430).
    { exact: "package.json" },
    { exact: "package-lock.json" },
    { exact: "pnpm-lock.yaml" },
    { exact: "yarn.lock" },
    { exact: ".deft/GENERATION.json" },
    // Legacy vbrief/ tree -- retained for not-yet-migrated consumers.
    { exact: "vbrief/.deft-version" },
    { exact: "vbrief/vbrief.md" },
    { prefix: "vbrief/schemas/" },
    { prefix: "vbrief/migration/" },
    ...VBRIEF_LIFECYCLE_DIRS.map((sub) => ({ exact: `vbrief/${sub}/.gitkeep` })),
    // Migrated xbrief/ tree (#2034 / #2110). The framework-managed version marker
    // now lives at xbrief/.deft-version, so it MUST be allowlisted or every routine
    // `deft update` framework-deposit PR trips no-mixed-core-and-app (#2277).
    { exact: "xbrief/.deft-version" },
    { exact: "xbrief/xbrief.md" },
    // CRITICAL (#1430 / #3029 / #3030): do NOT allowlist consumer-authored
    // PROJECT-DEFINITION (xbrief/ or vbrief/) or consumer scope briefs.
    // Init may still seed PD (#3013); the seed is app-owned for guard classification
    // so core+PD mixed PRs fail no-mixed-core-and-app. See CONSUMER_GUARD_MUST_FIRE.
    { prefix: "xbrief/schemas/" },
    { prefix: "xbrief/migration/" },
    ...VBRIEF_LIFECYCLE_DIRS.map((sub) => ({ exact: `xbrief/${sub}/.gitkeep` })),
  ];
}

function escapeEre(value: string): string {
  return value.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

function matcherToEre(matcher: InstallerManagedMatcher): string {
  if (matcher.exact) return `^${escapeEre(matcher.exact)}$`;
  return `^${escapeEre(matcher.prefix ?? "")}`;
}

function matchesInstallerManaged(
  path: string,
  matchers: readonly InstallerManagedMatcher[],
): boolean {
  for (const matcher of matchers) {
    if (matcher.exact && path === matcher.exact) return true;
    if (matcher.prefix && path.startsWith(matcher.prefix)) return true;
  }
  return false;
}

/** Consumer scope-brief filenames under lifecycle dirs (not scaffolding). */
const CONSUMER_SCOPE_BRIEF_EXACT =
  /^(xbrief|vbrief)\/(proposed|pending|active|completed|cancelled)\/.+\.(x|v)brief\.json$/;

/** PROJECT-DEFINITION exact paths (xbrief or legacy vbrief). */
const CONSUMER_PROJECT_DEFINITION_EXACT = /^(xbrief|vbrief)\/PROJECT-DEFINITION\.(x|v)brief\.json$/;

/**
 * Prefixes that would exempt entire consumer lifecycle trees or the whole
 * xbrief/vbrief tree — never installer-managed (#1430).
 */
const FORBIDDEN_CONSUMER_PREFIXES = new Set([
  "xbrief/",
  "vbrief/",
  ...VBRIEF_LIFECYCLE_DIRS.flatMap((sub) => [`xbrief/${sub}/`, `vbrief/${sub}/`]),
]);

/**
 * Fail closed when the installer-managed allowlist would exempt consumer
 * PROJECT-DEFINITION or scope briefs (#3030 / #1430). Pure over `matchers` so
 * tests can inject a bad matcher without mutating production state.
 *
 * Checks both:
 * 1. Explicit probe paths in {@link CONSUMER_GUARD_MUST_FIRE}
 * 2. Structural patterns (any exact consumer scope brief / PD; forbidden prefixes)
 *    so an unlisted `xbrief/active/another-scope.xbrief.json` matcher still fails.
 */
export function assertInstallerAllowlistHonors1430(
  matchers: readonly InstallerManagedMatcher[] = installerManagedMatchers(),
): void {
  for (const path of CONSUMER_GUARD_MUST_FIRE) {
    if (matchesInstallerManaged(path, matchers)) {
      throw new Error(
        `#1430 violation: ${path} must not be installer-managed (SPEC consumer denylist; see CONSUMER_GUARD_MUST_FIRE / #3030)`,
      );
    }
  }
  for (const matcher of matchers) {
    if (matcher.exact) {
      if (
        CONSUMER_PROJECT_DEFINITION_EXACT.test(matcher.exact) ||
        CONSUMER_SCOPE_BRIEF_EXACT.test(matcher.exact)
      ) {
        throw new Error(
          `#1430 violation: exact matcher ${matcher.exact} must not be installer-managed (consumer brief denylist / #3030)`,
        );
      }
    }
    if (matcher.prefix) {
      const normalized = matcher.prefix.endsWith("/") ? matcher.prefix : `${matcher.prefix}/`;
      if (FORBIDDEN_CONSUMER_PREFIXES.has(normalized)) {
        throw new Error(
          `#1430 violation: prefix matcher ${matcher.prefix} must not cover consumer brief trees (#3030)`,
        );
      }
    }
  }
}

/**
 * Individual POSIX ERE patterns for the deposited deft-core-guard allowlist.
 * One pattern per line in the workflow heredoc (#3345) — joined form is still
 * available via {@link installerManagedGuardEre} for tests and classifiers.
 */
export function installerManagedGuardErePatterns(): string[] {
  const matchers = installerManagedMatchers();
  // Refuse to emit a guard workflow that would exempt consumer denylist paths.
  assertInstallerAllowlistHonors1430(matchers);
  return matchers.map((matcher) => matcherToEre(matcher));
}

/** POSIX ERE alternation (joined) for tests / tooling that want a single pattern. */
export function installerManagedGuardEre(): string {
  return installerManagedGuardErePatterns().join("|");
}

export function isInstallerManagedPath(path: string): boolean {
  return matchesInstallerManaged(path, installerManagedMatchers());
}

export interface MixedCoreAndAppClassification {
  readonly core: string[];
  readonly installerManaged: string[];
  readonly app: string[];
  /** True when both core and app are non-empty — the deposited guard fails. */
  readonly wouldFail: boolean;
  /**
   * Pin/lock paths that were path-allowlisted but failed content-aware checks
   * when co-travelling with core (#3193). Empty when path-only classification.
   */
  readonly pinContentRejected?: string[];
}

/** Paths that path-allowlist for upgrade co-travel but need content checks with core (#3193). */
export const UPGRADE_PIN_CONTENT_PATHS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

export type UpgradePinContentPath = (typeof UPGRADE_PIN_CONTENT_PATHS)[number];

/** package.json dependency map fields that may hold @deftai/directive* pins. */
export const PACKAGE_JSON_DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/**
 * True when `name` is an `@deftai/directive*` dependency **key** (#3193).
 * Substring hits in scripts/settings values do not qualify.
 */
export function isDirectiveDependencyKey(name: string): boolean {
  return name.startsWith("@deftai/directive");
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualJson(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
  }
  return ak.every((k) => deepEqualJson(ao[k], bo[k]));
}

function stripDirectivePinsFromPackageJson(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (
      (PACKAGE_JSON_DEP_FIELDS as readonly string[]).includes(key) &&
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw)
    ) {
      const kept: Record<string, unknown> = {};
      for (const [depKey, depVal] of Object.entries(raw as Record<string, unknown>)) {
        if (!isDirectiveDependencyKey(depKey)) kept[depKey] = depVal;
      }
      out[key] = kept;
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * package.json co-travel is allowed only when the sole differences are
 * `@deftai/directive*` dependency-key pins under the standard dep maps (#3193).
 * Scripts/settings/metadata that merely contain the substring still fail.
 */
export function isPackageJsonDirectivePinOnlyDiff(baseRaw: string, headRaw: string): boolean {
  let base: unknown;
  let head: unknown;
  try {
    base = JSON.parse(baseRaw);
    head = JSON.parse(headRaw);
  } catch {
    return false;
  }
  return deepEqualJson(
    stripDirectivePinsFromPackageJson(base),
    stripDirectivePinsFromPackageJson(head),
  );
}

function collectDepIdentities(pkg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of PACKAGE_JSON_DEP_FIELDS) {
    const block = pkg[field];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
        else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          const version = (v as Record<string, unknown>).version;
          if (typeof version === "string") out[k] = version;
          else out[k] = JSON.stringify(v);
        } else if (v !== undefined && v !== null) {
          out[k] = String(v);
        }
      }
    }
  }
  return out;
}

function onlyDirectiveDirectDepsDiffer(
  baseDeps: Record<string, string>,
  headDeps: Record<string, string>,
): boolean {
  const keys = new Set([...Object.keys(baseDeps), ...Object.keys(headDeps)]);
  for (const key of keys) {
    if (isDirectiveDependencyKey(key)) continue;
    if ((baseDeps[key] ?? null) !== (headDeps[key] ?? null)) return false;
  }
  return true;
}

function npmLockRootDirectDeps(lock: Record<string, unknown>): Record<string, string> {
  const packages = lock.packages;
  if (packages !== null && typeof packages === "object" && !Array.isArray(packages)) {
    const root = (packages as Record<string, unknown>)[""];
    if (root !== null && typeof root === "object" && !Array.isArray(root)) {
      return collectDepIdentities(root as Record<string, unknown>);
    }
  }
  if (
    lock.dependencies !== null &&
    typeof lock.dependencies === "object" &&
    !Array.isArray(lock.dependencies)
  ) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(lock.dependencies as Record<string, unknown>)) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const version = (v as Record<string, unknown>).version;
        out[k] = typeof version === "string" ? version : JSON.stringify(v);
      } else if (typeof v === "string") {
        out[k] = v;
      }
    }
    return out;
  }
  return {};
}

/** Strip @deftai/directive* keys recursively from an npm v1 dependencies tree. */
function stripDirectiveFromNpmV1Deps(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isDirectiveDependencyKey(k)) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const entry = v as Record<string, unknown>;
      const next: Record<string, unknown> = { ...entry };
      if (entry.dependencies !== undefined) {
        next.dependencies = stripDirectiveFromNpmV1Deps(entry.dependencies);
      }
      out[k] = next;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * package-lock.json follow-through: non-@deftai/directive* root direct dependency
 * identities (and their `node_modules/<name>` package entries when present) must
 * be unchanged. Directive pin identity + transitive/resolution churn may change.
 */
export function isPackageLockDirectivePinFollowThrough(baseRaw: string, headRaw: string): boolean {
  let base: unknown;
  let head: unknown;
  try {
    base = JSON.parse(baseRaw);
    head = JSON.parse(headRaw);
  } catch {
    return false;
  }
  if (
    base === null ||
    head === null ||
    typeof base !== "object" ||
    typeof head !== "object" ||
    Array.isArray(base) ||
    Array.isArray(head)
  ) {
    return false;
  }
  const baseObj = base as Record<string, unknown>;
  const headObj = head as Record<string, unknown>;
  const baseRoot = npmLockRootDirectDeps(baseObj);
  const headRoot = npmLockRootDirectDeps(headObj);
  if (!onlyDirectiveDirectDepsDiffer(baseRoot, headRoot)) return false;

  const basePkgs =
    baseObj.packages !== null &&
    typeof baseObj.packages === "object" &&
    !Array.isArray(baseObj.packages)
      ? (baseObj.packages as Record<string, unknown>)
      : {};
  const headPkgs =
    headObj.packages !== null &&
    typeof headObj.packages === "object" &&
    !Array.isArray(headObj.packages)
      ? (headObj.packages as Record<string, unknown>)
      : {};
  // Freeze every non-@deftai/directive package record (including hoisted
  // transitives and nested product trees). Only packages[""] root dep maps
  // (directive keys only) and node_modules/@deftai/directive* trees may change.
  const allPkgKeys = new Set([...Object.keys(basePkgs), ...Object.keys(headPkgs)]);
  for (const key of allPkgKeys) {
    if (key === "") continue;
    if (key.includes("node_modules/@deftai/directive") || key.includes("/@deftai/directive/")) {
      continue;
    }
    if (!deepEqualJson(basePkgs[key], headPkgs[key])) return false;
  }

  // Legacy npm lockfileVersion 1: no packages map — freeze the full nested
  // dependencies tree after stripping @deftai/directive* keys (#3193 Greptile).
  if (Object.keys(basePkgs).length === 0 && Object.keys(headPkgs).length === 0) {
    if (
      !deepEqualJson(
        stripDirectiveFromNpmV1Deps(baseObj.dependencies),
        stripDirectiveFromNpmV1Deps(headObj.dependencies),
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Minimal pnpm-lock.yaml (v6/v9) root importer (`.`) direct-dep extractor.
 * Avoids a YAML dependency; sufficient for pin follow-through identity checks.
 */
export function pnpmLockRootDirectDeps(raw: string): Record<string, string> {
  const lines = raw.split(/\r?\n/);
  const out: Record<string, string> = {};
  let inImporters = false;
  let inRoot = false;
  let inDepBlock = false;
  let currentPkg: string | null = null;

  const unquote = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1);
    }
    return t;
  };

  for (const line of lines) {
    if (/^importers:\s*$/.test(line)) {
      inImporters = true;
      inRoot = false;
      inDepBlock = false;
      currentPkg = null;
      continue;
    }
    if (!inImporters) continue;
    // Left the importers section (top-level key at column 0).
    if (/^[^\s#]/.test(line) && !line.startsWith("importers")) {
      break;
    }
    // Root importer `.` (quoted or bare).
    if (/^ {2}(?:\.|'\.'|"\."):\s*$/.test(line)) {
      inRoot = true;
      inDepBlock = false;
      currentPkg = null;
      continue;
    }
    // Sibling importer under importers (2-space indent, not a dep field).
    if (inRoot && /^ {2}\S/.test(line) && !/^ {2}\./.test(line)) {
      inRoot = false;
      inDepBlock = false;
      currentPkg = null;
      continue;
    }
    if (!inRoot) continue;
    if (
      /^ {4}(?:dependencies|devDependencies|optionalDependencies|peerDependencies):\s*$/.test(line)
    ) {
      inDepBlock = true;
      currentPkg = null;
      continue;
    }
    // Non-dep field under root importer ends a dep block.
    if (inDepBlock && /^ {4}\S/.test(line)) {
      inDepBlock = false;
      currentPkg = null;
      continue;
    }
    if (!inDepBlock) continue;
    const pkgMatch = line.match(/^ {6}(.+?):\s*$/);
    if (pkgMatch) {
      currentPkg = unquote(pkgMatch[1] ?? "");
      continue;
    }
    if (currentPkg) {
      const verMatch = line.match(/^ {8}version:\s*(.+?)\s*$/);
      if (verMatch) {
        out[currentPkg] = unquote(verMatch[1] ?? "");
        currentPkg = null;
      }
    }
  }
  return out;
}

/**
 * Extract pnpm `packages:` section records keyed by the package name (not
 * name@version). Used to freeze product package resolution blocks.
 */
export function pnpmPackagesByName(raw: string): Map<string, string> {
  const map = new Map<string, string[]>();
  const lines = raw.split(/\r?\n/);
  let inPackages = false;
  let currentName: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (currentName === null) return;
    const prev = map.get(currentName) ?? [];
    prev.push(buf.join("\n"));
    map.set(currentName, prev);
    currentName = null;
    buf = [];
  };
  const unquote = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1);
    }
    return t;
  };
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      flush();
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^[^\s#]/.test(line) && !line.startsWith("packages")) {
      flush();
      break;
    }
    // Package key at 2-space indent: `  lodash@4.17.21:` or `  '@scope/pkg@1.0.0':`
    const keyMatch = line.match(/^ {2}(.+?):\s*$/);
    if (keyMatch) {
      flush();
      const key = unquote(keyMatch[1] ?? "");
      // name@version or @scope/name@version — strip version suffix after last @
      // that is not the scope marker.
      const at = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
      currentName = at > 0 ? key.slice(0, at) : key;
      buf = [line];
      continue;
    }
    if (currentName !== null) buf.push(line);
  }
  flush();
  // Join multi-version records for stable compare.
  const out = new Map<string, string>();
  for (const [name, blocks] of map) {
    out.set(name, blocks.slice().sort().join("\n---\n"));
  }
  return out;
}

/**
 * pnpm-lock.yaml follow-through: root importer (`.`) non-directive direct dep
 * identities must be unchanged, and every non-@deftai/directive packages-section
 * record (including transitive product packages) must be byte-stable (#3193).
 */
/**
 * Extract a top-level pnpm section (`packages:` or `snapshots:`) keyed by package name.
 */
function pnpmNamedSectionByName(
  raw: string,
  section: "packages" | "snapshots",
): Map<string, string> {
  const map = new Map<string, string[]>();
  const lines = raw.split(/\r?\n/);
  let inSection = false;
  let currentName: string | null = null;
  let buf: string[] = [];
  const sectionRe = new RegExp(`^${section}:\\s*$`);
  const flush = (): void => {
    if (currentName === null) return;
    const prev = map.get(currentName) ?? [];
    prev.push(buf.join("\n"));
    map.set(currentName, prev);
    currentName = null;
    buf = [];
  };
  const unquote = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1);
    }
    return t;
  };
  for (const line of lines) {
    if (sectionRe.test(line)) {
      flush();
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^[^\s#]/.test(line) && !line.startsWith(section)) {
      flush();
      break;
    }
    const keyMatch = line.match(/^ {2}(.+?):\s*$/);
    if (keyMatch) {
      flush();
      const key = unquote(keyMatch[1] ?? "");
      const at = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
      currentName = at > 0 ? key.slice(0, at) : key;
      buf = [line];
      continue;
    }
    if (currentName !== null) buf.push(line);
  }
  flush();
  const out = new Map<string, string>();
  for (const [name, blocks] of map) {
    out.set(name, blocks.slice().sort().join("\n---\n"));
  }
  return out;
}

export function isPnpmLockDirectivePinFollowThrough(baseRaw: string, headRaw: string): boolean {
  const baseRoot = pnpmLockRootDirectDeps(baseRaw);
  const headRoot = pnpmLockRootDirectDeps(headRaw);
  if (!onlyDirectiveDirectDepsDiffer(baseRoot, headRoot)) return false;
  for (const section of ["packages", "snapshots"] as const) {
    const baseSec = pnpmNamedSectionByName(baseRaw, section);
    const headSec = pnpmNamedSectionByName(headRaw, section);
    const names = new Set([...baseSec.keys(), ...headSec.keys()]);
    for (const name of names) {
      if (isDirectiveDependencyKey(name)) continue;
      if ((baseSec.get(name) ?? null) !== (headSec.get(name) ?? null)) return false;
    }
  }
  return true;
}

/**
 * yarn.lock (v1) package identity blocks: every non-@deftai/directive* package
 * must keep identical block text (or fail if added/removed). Directive package
 * blocks may change freely as pin follow-through (#3193).
 */
export function isYarnLockDirectivePinFollowThrough(baseRaw: string, headRaw: string): boolean {
  const baseBlocks = yarnLockPackageBlocks(baseRaw);
  const headBlocks = yarnLockPackageBlocks(headRaw);
  const names = new Set([...baseBlocks.keys(), ...headBlocks.keys()]);
  for (const name of names) {
    if (isDirectiveDependencyKey(name)) continue;
    if ((baseBlocks.get(name) ?? null) !== (headBlocks.get(name) ?? null)) return false;
  }
  return true;
}

function yarnLockPackageBlocks(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  let currentNames: string[] = [];
  let buf: string[] = [];
  const flush = (): void => {
    if (currentNames.length === 0) return;
    const body = buf.join("\n");
    for (const name of currentNames) {
      map.set(name, body);
    }
    currentNames = [];
    buf = [];
  };
  for (const line of lines) {
    if (line === "" || line.startsWith("#")) {
      if (currentNames.length > 0 && line === "") {
        flush();
      }
      continue;
    }
    // Package header: `"lodash@^4.17.21":` or `lodash@^4.17.21:`
    if (!/^\s/.test(line) && line.endsWith(":")) {
      flush();
      const header = line.slice(0, -1);
      currentNames = header.split(",").map((part) => {
        let p = part.trim();
        if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
          p = p.slice(1, -1);
        }
        // name@version or @scope/name@version
        const at = p.startsWith("@") ? p.indexOf("@", 1) : p.indexOf("@");
        return at > 0 ? p.slice(0, at) : p;
      });
      buf = [line];
      continue;
    }
    if (currentNames.length > 0) buf.push(line);
  }
  flush();
  return map;
}

/**
 * Content-aware check for a single upgrade pin path (#3193).
 * Returns true when the path may co-travel with `.deft/core/**`.
 */
export function isUpgradePinPathContentAllowed(
  path: string,
  baseRaw: string,
  headRaw: string,
): boolean {
  const normalized = path.replace(/\\/g, "/");
  switch (normalized) {
    case "package.json":
      return isPackageJsonDirectivePinOnlyDiff(baseRaw, headRaw);
    case "package-lock.json":
      return isPackageLockDirectivePinFollowThrough(baseRaw, headRaw);
    case "pnpm-lock.yaml":
      return isPnpmLockDirectivePinFollowThrough(baseRaw, headRaw);
    case "yarn.lock":
      return isYarnLockDirectivePinFollowThrough(baseRaw, headRaw);
    default:
      return false;
  }
}

export interface PinContentFilePair {
  readonly base: string;
  readonly head: string;
}

/**
 * TS twin of Go `classifyChangedPaths` / deposited shell guard (#1430).
 * Core = `.deft/core/**`; installer-managed = allowlist; app = everything else.
 * Guard fails iff both core and app are non-empty.
 *
 * Path-only: does not inspect package/lock contents. Prefer
 * {@link classifyMixedCoreAndAppContentAware} when base/head blobs are available
 * (deposited guard + unit tests for #3193).
 */
export function classifyMixedCoreAndApp(
  changedPaths: readonly string[],
  matchers: readonly InstallerManagedMatcher[] = installerManagedMatchers(),
): MixedCoreAndAppClassification {
  const core: string[] = [];
  const installerManaged: string[] = [];
  const app: string[] = [];
  for (const raw of changedPaths) {
    const path = raw.replace(/\\/g, "/");
    if (!path) continue;
    if (path === ".deft/core" || path.startsWith(".deft/core/")) {
      core.push(path);
    } else if (matchesInstallerManaged(path, matchers)) {
      installerManaged.push(path);
    } else {
      app.push(path);
    }
  }
  return {
    core,
    installerManaged,
    app,
    wouldFail: core.length > 0 && app.length > 0,
  };
}

/**
 * Path classifier plus the shared #3388 sync predicate. Feature mixes still
 * fail; a matching sync PR passes with a loud exemption message.
 */
export function classifyMixedCoreAndAppForPr(
  changedPaths: readonly string[],
  sync: BranchSyncDetection,
  matchers: readonly InstallerManagedMatcher[] = installerManagedMatchers(),
): MixedCoreAndAppClassification & { loudMessage: string | null } {
  const base = classifyMixedCoreAndApp(changedPaths, matchers);
  const applied = applyCoreGuardWithBranchSync(base, sync);
  return { ...base, wouldFail: applied.wouldFail, loudMessage: applied.loudMessage };
}

/**
 * Content-aware upgrade co-travel classifier (#3193).
 *
 * Starts from path classification (#3127 allowlist), then when `.deft/core/**`
 * is present reclassifies package.json / lockfile paths as **app** unless their
 * base→head content is the Directive pin unit (or lock follow-through).
 * `.deft/GENERATION.json` remains path-allowlisted with no content constraint.
 *
 * Missing content for a pin path co-travelling with core fails closed (treated
 * as app) so partial fixtures cannot silently re-open the path-only hole.
 */
export function classifyMixedCoreAndAppContentAware(
  changedPaths: readonly string[],
  fileContents: Readonly<Partial<Record<string, PinContentFilePair>>>,
  matchers: readonly InstallerManagedMatcher[] = installerManagedMatchers(),
): MixedCoreAndAppClassification {
  const base = classifyMixedCoreAndApp(changedPaths, matchers);
  if (base.core.length === 0) {
    return { ...base, pinContentRejected: [] };
  }

  const pinContentRejected: string[] = [];
  const keptManaged: string[] = [];
  const app = [...base.app];

  for (const path of base.installerManaged) {
    if (!(UPGRADE_PIN_CONTENT_PATHS as readonly string[]).includes(path)) {
      keptManaged.push(path);
      continue;
    }
    const pair = fileContents[path];
    if (!pair || !isUpgradePinPathContentAllowed(path, pair.base, pair.head)) {
      pinContentRejected.push(path);
      app.push(path);
    } else {
      keptManaged.push(path);
    }
  }

  return {
    core: base.core,
    installerManaged: keptManaged,
    app,
    wouldFail: app.length > 0,
    pinContentRejected,
  };
}

export interface FrameworkStagePathsOptions {
  /**
   * Include the vendored `.deft/core` payload in the exist-walk stage set.
   * Defaults to `true`. Ignored when a mutation ledger is bound (#3394) —
   * core paths stage only if they appear on this-run ledger.
   */
  readonly includeCore?: boolean;
  /**
   * Unused (#3394). Ledger intersection stages Taskfile.yml only when this run
   * mutated it. Kept so existing callers compile. Exist-walk (no ledger) stages
   * Taskfile.yml when the file exists — do not reintroduce the include skip.
   */
  readonly includeTaskfile?: boolean;
}

/** True for the vendored payload tree (not the installer-managed allowlist). */
export function isCoreStagePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized === ".deft/core" || normalized.startsWith(".deft/core/");
}

export interface LedgerStageSplit {
  readonly stagePaths: string[];
  readonly unstagedRemainder: string[];
  readonly skippedUntrackedDeletes: string[];
}

/**
 * True when `git ls-files` named the path or a descendant (directory prune).
 * Exact-only membership misses a ledgered directory whose tracked children
 * are the ls-files hits (#3394 Greptile).
 */
export function isTrackedDeletePath(path: string, trackedDeletes: ReadonlySet<string>): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (trackedDeletes.has(normalized)) return true;
  const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
  for (const tracked of trackedDeletes) {
    if (tracked === normalized || tracked.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Split this-run ledger paths into stageable (allowlist or core) vs remainder.
 * Deleted paths not present in `trackedDeletes` (or under a tracked prefix)
 * are skipped so one untracked delete cannot fail a batch `git add` (#3394).
 */
export function splitLedgerForStaging(
  summary: MutationSummary,
  trackedDeletes: ReadonlySet<string> = new Set(),
): LedgerStageSplit {
  const seen = new Set<string>();
  const stagePaths: string[] = [];
  const unstagedRemainder: string[] = [];
  const skippedUntrackedDeletes: string[] = [];
  const deleted = new Set(summary.deleted.map((path) => path.replace(/\\/g, "/")));

  const visit = (raw: string): void => {
    const path = raw.replace(/\\/g, "/");
    if (!path || seen.has(path)) return;
    seen.add(path);
    if (!isInstallerManagedPath(path) && !isCoreStagePath(path)) {
      unstagedRemainder.push(path);
      return;
    }
    if (deleted.has(path) && !isTrackedDeletePath(path, trackedDeletes)) {
      skippedUntrackedDeletes.push(path);
      return;
    }
    stagePaths.push(path);
  };

  for (const path of summary.wrote) visit(path);
  for (const path of summary.stripped) visit(path);
  for (const path of summary.deleted) visit(path);
  return { stagePaths, unstagedRemainder, skippedUntrackedDeletes };
}

export function frameworkStagePaths(
  projectDir: string,
  deftDir: string,
  options: FrameworkStagePathsOptions = {},
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string): void => {
    const normalized = rel.replace(/\\/g, "/");
    if (!normalized || normalized === "." || seen.has(normalized)) return;
    if (!existsSync(join(projectDir, normalized))) return;
    seen.add(normalized);
    paths.push(normalized);
  };

  const relDeft = relative(projectDir, deftDir);
  if (
    options.includeCore !== false &&
    relDeft &&
    !relDeft.startsWith("..") &&
    !relDeft.startsWith("/")
  ) {
    add(relDeft);
  }

  for (const matcher of installerManagedMatchers()) {
    if (matcher.exact) {
      add(matcher.exact);
    } else if (matcher.prefix) {
      add(matcher.prefix.replace(/\/$/, ""));
    }
  }
  return paths;
}

export interface StageFrameworkPathsSeams {
  gitPorcelain?: (projectRoot: string) => string | null;
  runGitAdd?: (projectDir: string, paths: readonly string[]) => void;
}

/** Best-effort scoped `git add` — never fails the install/update (#1453 Layer 2b). */
export function stageFrameworkPaths(
  projectDir: string,
  paths: readonly string[],
  seams: StageFrameworkPathsSeams = {},
): { staged: boolean; error: Error | null } {
  if (paths.length === 0) return { staged: false, error: null };
  const readPorcelain = seams.gitPorcelain ?? gitPorcelain;
  if (readPorcelain(projectDir) === null) return { staged: false, error: null };
  const runGitAdd =
    seams.runGitAdd ??
    ((root: string, stagePaths: readonly string[]) => {
      execFileSync("git", ["add", "--", ...stagePaths], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    });
  try {
    runGitAdd(projectDir, paths);
    return { staged: true, error: null };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return { staged: false, error };
  }
}

/**
 * Framework-internal subdirectories that are shipped as part of the source
 * repository but are NOT included in the `@deftai/directive-content` npm
 * package deposited into `.deft/core/`. If one of these paths survives from
 * a prior git-vendored install, `deft update`'s additive file-swap will never
 * remove it — causing the deposit-hygiene advisory to persist indefinitely.
 *
 * Each entry is a relative path within `.deft/core/`; presence in the CONTENT
 * root overrides the prune (i.e. if the content package ever ships `packages/`
 * again, we won't prune it).
 *
 * Refs #2347.
 */
export const STRAY_DEPOSIT_FRAMEWORK_PATHS = ["packages"] as const;

/**
 * Deposit-local files generated by init/update that are intentionally absent
 * from `@deftai/directive-content` (#2804).
 */
export const DEPOSIT_GENERATED_METADATA_PATHS = ["VERSION"] as const;

export function isDepositGeneratedMetadata(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return (DEPOSIT_GENERATED_METADATA_PATHS as readonly string[]).includes(normalized);
}

function normalizeRelativePath(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

function listRelativeFilePathsSync(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  walk(root, "");
  return results;
}

async function listRelativeFilePaths(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  await walk(root, "");
  return results;
}

function contentDirectoryPaths(contentFiles: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of contentFiles) {
    let dir = dirname(file);
    while (dir && dir !== ".") {
      dirs.add(normalizeRelativePath(dir));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return dirs;
}

/**
 * List deposit-relative paths that are absent from the installed content package,
 * excluding generated deposit metadata such as `VERSION` (#2804).
 */
export function findPackageAbsentDepositPathsSync(deftDir: string, contentRoot: string): string[] {
  const depositFiles = listRelativeFilePathsSync(deftDir);
  const contentFiles = new Set(listRelativeFilePathsSync(contentRoot));
  return depositFiles
    .filter((rel) => !contentFiles.has(rel) && !isDepositGeneratedMetadata(rel))
    .sort();
}

export async function findPackageAbsentDepositPaths(
  deftDir: string,
  contentRoot: string,
): Promise<string[]> {
  const depositFiles = await listRelativeFilePaths(deftDir);
  const contentFiles = new Set(await listRelativeFilePaths(contentRoot));
  return depositFiles
    .filter((rel) => !contentFiles.has(rel) && !isDepositGeneratedMetadata(rel))
    .sort();
}

export interface PrunePackageAbsentDepositPathsResult {
  readonly pruned: string[];
  readonly prunedDirs: string[];
}

async function pruneEmptyParentsForFile(
  deftDir: string,
  contentDirs: ReadonlySet<string>,
  relFile: string,
): Promise<string[]> {
  const prunedDirs: string[] = [];
  let rel = dirname(relFile);
  while (rel && rel !== ".") {
    const normalized = normalizeRelativePath(rel);
    if (contentDirs.has(normalized)) break;
    const abs = join(deftDir, rel);
    try {
      if (!existsSync(abs) || readdirSync(abs).length !== 0) break;
      containedRemove({ root: deftDir, target: abs, mutation: false });
      prunedDirs.push(normalized);
    } catch {
      break;
    }
    rel = dirname(rel);
  }
  return prunedDirs;
}

/**
 * Remove deposit files not shipped by `@deftai/directive-content`, preserving
 * generated deposit metadata such as `VERSION` (#2804). Subsumes the legacy
 * hard-coded `packages/` prune (#2347).
 *
 * Individual removal failures are reported but do not throw — callers that must
 * refuse a VERSION stamp until the deposit matches the content package should
 * use {@link reconcileDepositToContentPackage} (#2913).
 *
 * Dest-only file removers go through {@link containedRemove} so a bound
 * mutation ledger records them (#3392).
 */
export async function prunePackageAbsentDepositPaths(
  deftDir: string,
  contentRoot: string,
  io: InitDepositIo,
): Promise<PrunePackageAbsentDepositPathsResult> {
  const absent = await findPackageAbsentDepositPaths(deftDir, contentRoot);
  const contentDirs = contentDirectoryPaths(listRelativeFilePathsSync(contentRoot));
  const pruned: string[] = [];
  const prunedDirs: string[] = [];
  for (const rel of absent) {
    try {
      containedRemove({ root: deftDir, target: join(deftDir, rel) });
      pruned.push(rel);
      prunedDirs.push(...(await pruneEmptyParentsForFile(deftDir, contentDirs, rel)));
    } catch (cause) {
      io.printf(`Warning: could not prune .deft/core/${rel}: ${String(cause)}\n`);
    }
  }
  if (pruned.length > 0) {
    io.printf(
      `Pruned ${pruned.length} package-absent deposit file(s) not shipped by @deftai/directive-content (#2804).\n`,
    );
  }
  return { pruned, prunedDirs };
}

/**
 * Fail-closed deposit reconcile against the installed content package (#2913).
 *
 * Runs {@link prunePackageAbsentDepositPaths}, then re-scans. If any
 * package-absent path remains, throws so callers refuse the VERSION stamp
 * (dst-only stale/malicious agent content must not survive a refresh).
 *
 * After a successful {@link replaceTree} full-swap this is typically a no-op
 * verification; it also covers additive copy seams and the already-current
 * refresh path that skips payload copy.
 */
export async function reconcileDepositToContentPackage(
  deftDir: string,
  contentRoot: string,
  io: InitDepositIo,
): Promise<PrunePackageAbsentDepositPathsResult> {
  const result = await prunePackageAbsentDepositPaths(deftDir, contentRoot, io);
  // Collect-only records intended deletes and leaves dest-only paths on disk.
  if (isCollectOnlyActive()) return result;
  const remaining = await findPackageAbsentDepositPaths(deftDir, contentRoot);
  if (remaining.length > 0) {
    const sample = remaining.slice(0, 5).join(", ");
    const more = remaining.length > 5 ? ` (+${remaining.length - 5} more)` : "";
    throw new Error(
      `deposit reconcile failed: ${remaining.length} package-absent path(s) remain under .deft/core ` +
        `(e.g. ${sample}${more}). Refusing VERSION stamp until dst-only content is removed (#2913).`,
    );
  }
  return result;
}

export interface PruneStrayDepositPathsResult {
  readonly pruned: string[];
}

/**
 * Remove framework-source subdirectories from `.deft/core/` that are not
 * present in the deposited content package (#2347). Silently skips any path
 * that is also present in `contentRoot` (future-safe: if the content package
 * ever ships `packages/` we stop pruning it).
 */
export async function pruneStrayDepositPaths(
  deftDir: string,
  contentRoot: string,
  io: InitDepositIo,
): Promise<PruneStrayDepositPathsResult> {
  const pruned: string[] = [];
  for (const rel of STRAY_DEPOSIT_FRAMEWORK_PATHS) {
    const depositPath = join(deftDir, rel);
    const contentPath = join(contentRoot, rel);
    let isInDeposit = false;
    let isInContent = false;
    try {
      isInDeposit = (await stat(depositPath)).isDirectory();
    } catch {
      // absent — nothing to prune
    }
    if (!isInDeposit) continue;
    try {
      isInContent = (await stat(contentPath)).isDirectory();
    } catch {
      // not in content package — safe to prune
    }
    if (isInContent) continue;
    try {
      await rm(depositPath, { recursive: true, force: true });
      pruned.push(rel);
      io.printf(
        `Pruned stray framework-source tree .deft/core/${rel}/ — not shipped by @deftai/directive-content (#2347).\n`,
      );
    } catch (cause) {
      io.printf(`Warning: could not prune .deft/core/${rel}/: ${String(cause)}\n`);
    }
  }
  return { pruned };
}

export const COMMIT_HYGIENE_BRANCH_NAME = "chore/deft-framework-upgrade";

export function printUnstagedLedgerRemainder(
  io: InitDepositIo,
  remainder: readonly string[],
): void {
  if (remainder.length === 0) return;
  io.printf("Left unstaged (not installer-managed this run; do not git add -A):\n");
  for (const path of remainder) {
    io.printf(`  ${path}\n`);
  }
}

export function printCommitGuidance(
  io: InitDepositIo,
  paths: readonly string[],
  staged: boolean,
  unstagedRemainder: readonly string[] = [],
): void {
  if (paths.length === 0 && unstagedRemainder.length === 0) return;
  if (paths.length > 0) {
    const addCmd = `git add -- ${paths.join(" ")}`;
    io.printf(
      "\nCommit hygiene (#1453, #1671, #3127, #3193, #3394): keep the framework upgrade in its OWN branch/PR.\n",
    );
    io.printf("Do NOT use `git add -A` -- mixing the payload with product/app files trips the\n");
    io.printf("deft-core-guard CI check.\n");
    io.printf(
      "One upgrade PR MAY co-travel: .deft/core/** + installer-managed deposits + package.json\n",
    );
    io.printf(
      "pin/lock (Directive pin-only + lock follow-through, #3193) + .deft/GENERATION.json.\n",
    );
    io.printf("True app/product paths still require a separate PR.\n");
    if (staged) {
      io.printf("The installer already staged ONLY these framework + installer-managed paths:\n");
      io.printf(`  ${addCmd}\n`);
    } else {
      io.printf("Stage ONLY these framework + installer-managed paths:\n");
      io.printf(`  ${addCmd}\n`);
    }
    io.printf("Then take the framework deposit through the full PR lifecycle so deft-core-guard\n");
    io.printf("evaluates a clean, standalone upgrade PR:\n");
    io.printf(`  1. Branch: git switch -c ${COMMIT_HYGIENE_BRANCH_NAME}\n`);
    io.printf('  2. Commit: git commit -m "chore(deft): update framework payload"\n');
    io.printf(`  3. Push:   git push -u origin ${COMMIT_HYGIENE_BRANCH_NAME}\n`);
    io.printf('  4. PR:     gh pr create --fill --title "chore(deft): update framework payload"\n');
    io.printf(
      "  5. Merge:  gh pr merge --squash --delete-branch   # after deft-core-guard passes\n",
    );
  }
  printUnstagedLedgerRemainder(io, unstagedRemainder);
}

function defaultCachedNames(projectDir: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split("\0")
      .map((entry) => entry.trim().replace(/\\/g, "/"))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Narrow the candidate stage paths to those that actually have staged index
 * changes. A candidate file matches when the cached name is identical; a
 * candidate directory (e.g. ``.deft/core``) matches when any cached name lives
 * beneath it. This keeps ``staged_paths`` honest for downstream automation --
 * it reports what git actually staged, not every path passed to ``git add``.
 */
function actuallyStagedPaths(
  stagePaths: readonly string[],
  cachedNames: readonly string[],
): string[] {
  return stagePaths.filter((candidate) =>
    cachedNames.some((name) => name === candidate || name.startsWith(`${candidate}/`)),
  );
}

export interface DepositStagePathsOptions
  extends StageFrameworkPathsSeams,
    FrameworkStagePathsOptions {
  readCachedNames?: (projectDir: string) => string[];
  /** `git ls-files` seam for filtering untracked ledger deletions (#3394). */
  readTrackedNames?: (projectDir: string, paths: readonly string[]) => string[];
  /** Explicit this-run ledger. Defaults to the bound snapshot. */
  mutations?: MutationSummary;
  printf?: (text: string) => void;
}

function defaultTrackedNames(projectDir: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", ...paths], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split("\0")
      .map((entry) => entry.trim().replace(/\\/g, "/"))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function depositStagePaths(
  projectDir: string,
  options: DepositStagePathsOptions = {},
): {
  stagePaths: string[];
  staged: boolean;
  stagedPaths: string[];
  unstagedRemainder: string[];
  skippedUntrackedDeletes: string[];
} {
  const summary = options.mutations ?? snapshotMutationSummary();
  const ledgerBound = options.mutations !== undefined || activeMutationLedger() !== undefined;

  let stagePaths: string[];
  let unstagedRemainder: string[] = [];
  let skippedUntrackedDeletes: string[] = [];

  if (ledgerBound) {
    const readTracked = options.readTrackedNames ?? defaultTrackedNames;
    const tracked = new Set(readTracked(projectDir, summary.deleted));
    const split = splitLedgerForStaging(summary, tracked);
    stagePaths = split.stagePaths;
    unstagedRemainder = split.unstagedRemainder;
    skippedUntrackedDeletes = split.skippedUntrackedDeletes;
  } else {
    const deftDir = join(projectDir, CANONICAL_INSTALL_ROOT);
    stagePaths = frameworkStagePaths(projectDir, deftDir, {
      includeCore: options.includeCore,
    });
  }

  const leftover = [...unstagedRemainder, ...skippedUntrackedDeletes];
  if (leftover.length > 0 && options.printf) {
    printUnstagedLedgerRemainder({ printf: options.printf }, leftover);
  }

  const { staged } = stageFrameworkPaths(projectDir, stagePaths, options);
  const readCachedNames = options.readCachedNames ?? defaultCachedNames;
  const cachedNames = staged ? readCachedNames(projectDir) : [];
  return {
    stagePaths,
    staged,
    stagedPaths: staged ? actuallyStagedPaths(stagePaths, cachedNames) : [],
    unstagedRemainder,
    skippedUntrackedDeletes,
  };
}
