/**
 * Legacy on-disk layout detection for the npm CLI (#1912 Tier-2).
 *
 * The `npx @deftai/directive` CLI is fetched fresh at use-time. Before it
 * deposits (init) or refreshes (update) the canonical `.deft/core/` vendored
 * layout, it must detect a LEGACY on-disk layout and REFUSE -- the npm path
 * never migrates. Stage 1 (the frozen final Go bridge installer) migrates the
 * old layout; stage 2 (this npm CLI) takes over once the layout is
 * canonical-vendored.
 *
 * Legacy shapes recognized:
 *  - orphan-deft-version      : `.deft/VERSION` present but `.deft/core/` absent
 *  - legacy-deft-prefixed     : old `deft/`-prefixed install root
 *  - git-clone-or-submodule   : framework checked out as a clone / git submodule
 *  - pre-v0.27-sentinel-agents: pre-v0.27 AGENTS.md without a v2/v3 managed-section
 *
 * Reuses the manifest/AGENTS heuristics in ../doctor/manifest.ts -- it does NOT
 * reinvent them.
 *
 * Core principle (locked): never bake the upgrade command/version into the
 * artifact being upgraded -- bake in a stable pointer resolved fresh. The
 * refusal therefore signposts a STABLE UPGRADING.md URL, never a baked version.
 *
 * Refs #1912, #1669.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { GO_BRIDGE_RELEASES_URL, UPGRADING_DOC_URL } from "../doctor/constants.js";
import { extractManagedSection, parseInstallRootFromAgentsMd } from "../doctor/manifest.js";
import { readTextSafe } from "../doctor/paths.js";
import { containedRemove } from "../fs/contained-write.js";
import { gitPorcelain } from "../story-ready/git.js";

/** Non-zero exit code for a use-time legacy-layout refusal (needs-action). */
export const LEGACY_LAYOUT_REFUSED_EXIT_CODE = 2;

export type LegacyLayoutKind =
  | "orphan-deft-version"
  | "legacy-deft-prefixed"
  | "git-clone-or-submodule"
  | "pre-v0.27-sentinel-agents-md"
  | "dual-layout";

export interface LegacyLayoutDetection {
  readonly legacy: boolean;
  readonly kind: LegacyLayoutKind | null;
  readonly detail: string;
  readonly evidence: readonly string[];
}

export interface LegacyDetectSeams {
  readonly isFile?: (p: string) => boolean;
  readonly isDir?: (p: string) => boolean;
  readonly readText?: (p: string) => string | null;
}

const NOT_LEGACY: LegacyLayoutDetection = {
  legacy: false,
  kind: null,
  detail: "Canonical or greenfield layout -- no legacy Deft layout detected.",
  evidence: [],
};

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Does `.gitmodules` reference the deft framework at a deft install path? */
const LEGACY_DEFT_DIR = "deft";

function isFrameworkDeftDir(
  projectDir: string,
  isDir: (p: string) => boolean,
  isFile: (p: string) => boolean,
): boolean {
  const deftDir = join(projectDir, LEGACY_DEFT_DIR);
  const deftMarkers = [
    join(deftDir, "VERSION"),
    join(deftDir, "main.md"),
    join(deftDir, "Taskfile.yml"),
  ];
  return isDir(deftDir) && (deftMarkers.some((m) => isFile(m)) || isDir(join(deftDir, "skills")));
}

function gitmodulesReferencesFramework(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").toLowerCase();
  if (normalized.includes("deftai/directive")) {
    return true;
  }
  // A submodule whose path is the framework install dir is a strong signal even
  // when the url host differs (mirror, fork). Match `path = deft` / `path = .deft`.
  return /(^|\n)\s*path\s*=\s*\.?deft(\/|\s|$)/.test(normalized);
}

const DUAL_LAYOUT_DETAIL =
  "Found both the canonical .deft/core/ deposit and a leftover legacy deft/ " +
  "framework tree -- remove deft/ so .deft/core/ is the sole framework root.";

/**
 * Detect a post-bridge dual-layout: canonical `.deft/core/` plus a leftover
 * framework-marked `deft/` tree. Doctor-only -- the npm deposit path treats
 * `.deft/core/` as canonical and must not refuse here (#2805 / #2804 wiring).
 */
export function detectDualLayout(
  projectDir: string,
  seams: LegacyDetectSeams = {},
): LegacyLayoutDetection | null {
  const isFile = seams.isFile ?? defaultIsFile;
  const isDir = seams.isDir ?? defaultIsDir;
  const hasCanonicalCore = isDir(join(projectDir, ".deft", "core"));
  if (!hasCanonicalCore || !isFrameworkDeftDir(projectDir, isDir, isFile)) {
    return null;
  }
  return {
    legacy: true,
    kind: "dual-layout",
    detail: DUAL_LAYOUT_DETAIL,
    evidence: [".deft/core/", "deft/"],
  };
}

/**
 * Classify the on-disk layout at `projectDir`. Returns `legacy: false` for the
 * canonical `.deft/core/` vendored layout and for a greenfield project (so init
 * proceeds); returns `legacy: true` with the matched `kind` for any legacy shape.
 */
export function detectLegacyLayout(
  projectDir: string,
  seams: LegacyDetectSeams = {},
): LegacyLayoutDetection {
  const isFile = seams.isFile ?? defaultIsFile;
  const isDir = seams.isDir ?? defaultIsDir;
  const readText = seams.readText ?? readTextSafe;

  const hasCanonicalCore = isDir(join(projectDir, ".deft", "core"));
  const deftDirIsFramework = isFrameworkDeftDir(projectDir, isDir, isFile);

  // Canonical vendored layout present -> the npm path owns it; not legacy. Any
  // leftover deft/ tree is a dual-layout hygiene issue surfaced by Doctor only.
  if (hasCanonicalCore) {
    return NOT_LEGACY;
  }

  // Orphan `.deft/VERSION` (the old pre-`.deft/core/` manifest location) with no
  // `.deft/core/` directory.
  if (isFile(join(projectDir, ".deft", "VERSION"))) {
    return {
      legacy: true,
      kind: "orphan-deft-version",
      detail:
        "Found an orphan .deft/VERSION manifest with no .deft/core/ directory -- " +
        "this is a pre-.deft/core/ layout the npm CLI does not migrate.",
      evidence: [".deft/VERSION"],
    };
  }

  // Legacy `deft/`-prefixed install root: a top-level `deft/` directory carrying
  // framework markers. Distinguish a git-clone / submodule deposit (a `.git`
  // inside `deft/`, or a `.gitmodules` pointing at the framework) from a plain
  // legacy-prefixed vendored copy.
  const deftDir = join(projectDir, LEGACY_DEFT_DIR);
  if (deftDirIsFramework) {
    const submoduleGit = isFile(join(deftDir, ".git")) || isDir(join(deftDir, ".git"));
    if (submoduleGit) {
      return {
        legacy: true,
        kind: "git-clone-or-submodule",
        detail:
          "Found a deft/ framework directory backed by its own .git (clone or " +
          "git submodule) -- the npm CLI does not migrate a clone/submodule deposit.",
        evidence: ["deft/", "deft/.git"],
      };
    }
    return {
      legacy: true,
      kind: "legacy-deft-prefixed",
      detail:
        "Found a legacy deft/-prefixed framework install -- the canonical layout " +
        "is .deft/core/. The npm CLI does not migrate the deft/ -> .deft/core/ move.",
      evidence: ["deft/"],
    };
  }

  // Git submodule recorded in `.gitmodules` pointing at the framework, even when
  // the submodule directory has not been checked out.
  const gitmodulesPath = join(projectDir, ".gitmodules");
  if (isFile(gitmodulesPath)) {
    const text = readText(gitmodulesPath);
    if (text !== null && gitmodulesReferencesFramework(text)) {
      return {
        legacy: true,
        kind: "git-clone-or-submodule",
        detail:
          "Found a .gitmodules entry referencing the Deft framework -- a submodule " +
          "deposit the npm CLI does not migrate.",
        evidence: [".gitmodules"],
      };
    }
  }

  // Pre-v0.27 AGENTS.md: deft-managed but missing a v2/v3 managed-section, or
  // declaring the legacy `deft/` install root.
  const agentsText = readText(join(projectDir, "AGENTS.md"));
  if (agentsText !== null) {
    const installRoot = parseInstallRootFromAgentsMd(agentsText);
    if (installRoot === "deft") {
      return {
        legacy: true,
        kind: "legacy-deft-prefixed",
        detail:
          "AGENTS.md declares the legacy deft/ install root -- the canonical layout " +
          "is .deft/core/. The npm CLI does not migrate the deft/ -> .deft/core/ move.",
        evidence: ["AGENTS.md (install root: deft)"],
      };
    }
    // Match the OPEN tag only (`<!-- deft:managed-section ...`). A bare
    // `deft:managed-section` substring also appears in the close tag
    // (`<!-- /deft:managed-section -->`), so a truncated / mid-write AGENTS.md
    // carrying only the close tag (or an open tag with no extractable body)
    // would otherwise be misclassified as a pre-v0.27 legacy layout.
    const hasManagedMarker = agentsText.includes("<!-- deft:managed-section");
    if (hasManagedMarker && extractManagedSection(agentsText) === null) {
      return {
        legacy: true,
        kind: "pre-v0.27-sentinel-agents-md",
        detail:
          "AGENTS.md carries a pre-v0.27 sentinel-only managed-section (no v2/v3 " +
          "managed-section markers) -- run the Go bridge to migrate before the npm CLI.",
        evidence: ["AGENTS.md (sentinel-only managed-section)"],
      };
    }
  }

  return NOT_LEGACY;
}

/** Thrown by the deposit/refresh core path when a legacy layout is detected. */
export class LegacyLayoutRefusedError extends Error {
  readonly detection: LegacyLayoutDetection;

  constructor(detection: LegacyLayoutDetection) {
    super(detection.detail);
    this.name = "LegacyLayoutRefusedError";
    this.detection = detection;
  }
}

/**
 * Build the human-facing two-step recovery message. Version-neutral: it
 * signposts the stable UPGRADING.md doc + the frozen-bridge releases page and
 * NEVER bakes a Go-installer version or a literal upgrade command.
 */
export function buildLegacyRefusalMessage(
  command: "init" | "update",
  detection: LegacyLayoutDetection,
): string {
  const rerun = `npx @deftai/directive ${command}`;
  return (
    `directive ${command}: refusing to ${command === "init" ? "deposit" : "refresh"} -- ` +
    "a LEGACY Deft layout was detected.\n\n" +
    `  Detected: ${detection.detail}` +
    (detection.kind ? ` (${detection.kind})` : "") +
    "\n\n" +
    "The npm CLI does not migrate legacy layouts. Recover in two steps:\n\n" +
    "  1. Run the frozen final Go bridge installer to migrate this layout to the\n" +
    "     canonical .deft/core/ vendored layout. The binaries + exact command are\n" +
    "     documented (version-neutral) at:\n" +
    `       ${UPGRADING_DOC_URL}\n` +
    `     Frozen Go bridge releases: ${GO_BRIDGE_RELEASES_URL}\n` +
    `  2. Re-run \`${rerun}\` once the layout is canonical-vendored.\n\n` +
    "Why a pointer, not a command: never bake the upgrade command/version into the\n" +
    "artifact being upgraded -- the links above resolve the current bridge fresh.\n"
  );
}

/** Build the machine-readable refusal payload for `--json` callers. */
export function buildLegacyRefusalJson(
  command: "init" | "update",
  projectDir: string,
  detection: LegacyLayoutDetection,
): Record<string, unknown> {
  return {
    success: false,
    action: "refuse",
    refused: true,
    error_code: "legacy_layout_refused",
    command,
    project_dir: projectDir,
    legacy_layout: true,
    legacy_layout_kind: detection.kind,
    detail: detection.detail,
    evidence: [...detection.evidence],
    upgrading_doc_url: UPGRADING_DOC_URL,
    go_bridge_releases_url: GO_BRIDGE_RELEASES_URL,
  };
}

/** One-line doctor signpost carrying the stable URL (no baked version/command). */
export function legacyLayoutSignpostLine(detection: LegacyLayoutDetection): string {
  if (detection.kind === "dual-layout") {
    return dualLayoutSignpostLine(detection);
  }
  return (
    `Legacy Deft layout detected (${detection.kind ?? "unknown"}): ${detection.detail} ` +
    "Run the frozen Go bridge installer to migrate to .deft/core/, then use the npm " +
    `CLI (\`npx @deftai/directive update\`). See ${UPGRADING_DOC_URL} ` +
    `(frozen bridge: ${GO_BRIDGE_RELEASES_URL}).`
  );
}

/** Doctor / npm signpost for the post-bridge dual-layout state (#2805). */
export function dualLayoutSignpostLine(detection: LegacyLayoutDetection): string {
  return (
    `Dual Deft layout detected (${detection.kind ?? "dual-layout"}): ${detection.detail} ` +
    "Remove the legacy deft/ tree so .deft/core/ is the sole framework root " +
    "(when clean: `git rm -r deft/`; reconcile local edits first if `git status deft/` is dirty). " +
    `See ${UPGRADING_DOC_URL}.`
  );
}

export interface LegacyDeftCleanupSeams {
  readonly gitPorcelain?: (projectRoot: string) => string | null;
  readonly runGitRm?: (projectDir: string, relPath: string) => void;
  readonly removeDir?: (absPath: string) => void;
}

export type LegacyDeftCleanupAction = "removed" | "staged" | "refused" | "skipped";

export interface LegacyDeftCleanupResult {
  readonly ok: boolean;
  readonly action: LegacyDeftCleanupAction;
  readonly detail: string;
}

function porcelainEntryPath(line: string): string {
  let path = line.slice(3).trim().replace(/\\/g, "/");
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return path;
}

function porcelainTouchesLegacyDeft(porcelain: string): string[] {
  const touched: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const path = porcelainEntryPath(line);
    if (path === LEGACY_DEFT_DIR || path.startsWith(`${LEGACY_DEFT_DIR}/`)) {
      touched.push(path);
    }
  }
  return touched;
}

/**
 * Remove a clean tracked legacy `deft/` tree after bridge migration (#2805).
 * Refuses when the tree has local modifications or untracked files.
 */
export function tryCleanupLegacyDeftTree(
  projectDir: string,
  seams: LegacyDeftCleanupSeams = {},
): LegacyDeftCleanupResult {
  const detection = detectDualLayout(projectDir);
  if (detection === null) {
    return {
      ok: true,
      action: "skipped",
      detail: "No dual-layout legacy deft/ tree to remove.",
    };
  }

  const readPorcelain = seams.gitPorcelain ?? gitPorcelain;
  const porcelain = readPorcelain(projectDir);
  if (porcelain === null) {
    return {
      ok: false,
      action: "refused",
      detail:
        "Cannot determine whether the legacy deft/ tree is clean (git unavailable). " +
        "Inspect `git status deft/` and remove the tree manually once clean.",
    };
  }

  const dirtyPaths = porcelainTouchesLegacyDeft(porcelain);
  if (dirtyPaths.length > 0) {
    return {
      ok: false,
      action: "refused",
      detail:
        "Refusing to remove the legacy deft/ tree because it has local modifications or " +
        "untracked files. Reconcile or commit those changes, then re-run " +
        "`npx @deftai/directive update`, or remove deft/ manually once clean. " +
        `Dirty paths: ${JSON.stringify(dirtyPaths.slice(0, 5))}` +
        (dirtyPaths.length > 5 ? ", …" : "") +
        ".",
    };
  }

  const deftDir = join(projectDir, LEGACY_DEFT_DIR);
  const removeDir =
    seams.removeDir ??
    ((p: string) => {
      containedRemove({ root: projectDir, target: p, recursive: true });
    });
  const runGitRm =
    seams.runGitRm ??
    ((root: string, relPath: string) => {
      execFileSync("git", ["rm", "-r", "--ignore-unmatch", relPath], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    });

  try {
    runGitRm(projectDir, LEGACY_DEFT_DIR);
    removeDir(deftDir);
    return {
      ok: true,
      action: "staged",
      detail:
        "Removed the legacy deft/ framework tree and staged its deletion; " +
        ".deft/core/ is now the sole framework root.",
    };
  } catch {
    try {
      removeDir(deftDir);
      return {
        ok: true,
        action: "removed",
        detail:
          "Removed the legacy deft/ framework tree from disk; stage the deletion with " +
          "`git add -u deft/` if it was tracked.",
      };
    } catch (cause) {
      return {
        ok: false,
        action: "refused",
        detail: `Could not remove the legacy deft/ tree: ${String(cause)}`,
      };
    }
  }
}
