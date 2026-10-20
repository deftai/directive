/**
 * Thin historical-shape detect for the launcher (AC3.1: no core import).
 * Reuses pin.ts (readPin / hasCopiedCoreEvidence). FS fingerprints align with
 * packages/core LegacyLayoutKind names mapped to survey shape_ids.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasCopiedCoreEvidence, readPin } from "../pin.js";
import { decisionForShapeId, type RecoveryDecision, type SurveyShapeId } from "./registry.js";

export interface ShapeResolution {
  readonly shapeId: SurveyShapeId;
  readonly decision: RecoveryDecision;
  readonly evidence: readonly string[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const LEGACY_DEFT_DIR = "deft";

/** Same markers as core legacy-detect isFrameworkDeftDir (keep in sync). */
function isFrameworkDeftDir(projectRoot: string): boolean {
  const deftDir = join(projectRoot, LEGACY_DEFT_DIR);
  if (!isDir(deftDir)) return false;
  return (
    isFile(join(deftDir, "VERSION")) ||
    isFile(join(deftDir, "main.md")) ||
    isFile(join(deftDir, "Taskfile.yml")) ||
    isDir(join(deftDir, "skills"))
  );
}

function gitmodulesReferencesFramework(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").toLowerCase();
  if (normalized.includes("deftai/directive")) return true;
  return /(^|\n)\s*path\s*=\s*\.?deft(\/|\s|$)/.test(normalized);
}

/** Parent index still has deft as gitlink (mode 160000) — convert refuses. */
function isUnsafeSubmoduleGitlink(projectRoot: string): boolean {
  try {
    const out = execFileSync("git", ["-C", projectRoot, "ls-files", "-s", "--", "deft"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split(/\r?\n/)) {
      if (/^160000\s/.test(line.trim())) return true;
    }
  } catch {
    /* no git / untracked — fs-only cleanup is safe */
  }
  return false;
}

function resolution(
  shapeId: SurveyShapeId,
  evidence: readonly string[],
  decisionOverride?: RecoveryDecision,
): ShapeResolution {
  return {
    shapeId,
    decision: decisionOverride ?? decisionForShapeId(shapeId),
    evidence,
  };
}

/**
 * Classify install layout → survey shape_id + recovery decision.
 * Returns null for greenfield / non-historical (caller keeps existing gates).
 *
 * Priority: L0 pin shapes first, then dual-layout, vendored-core-go, then
 * legacy-detect-aligned FS (orphan / submodule / go-tarball).
 */
export function resolveInstallShape(projectRoot: string): ShapeResolution | null {
  const pin = readPin(projectRoot);

  // L0: exact runtime pin (OVPR). Leftover .deft/core is hygiene, not vendored-core-go.
  if (pin.kind === "exact" && !pin.oldStyle && pin.version !== null) {
    return resolution("ovpr-runtime-pin", [
      `package.json#@deftai/directive-runtime@${pin.version}`,
    ]);
  }

  // L0: latest-legacy exact pre-split pin + copied-core (wave 2f).
  if (pin.oldStyle) {
    return resolution("npm-hybrid-pin-copied-core", [
      "package.json#@deftai/directive (exact)",
      ".deft/core (copied-core evidence)",
    ]);
  }

  const hasCore = hasCopiedCoreEvidence(projectRoot);
  const frameworkDeft = isFrameworkDeftDir(projectRoot);

  // Dual layout: framework deft/ + copied-core (no exact pin). Order: deft then core.
  if (hasCore && frameworkDeft) {
    return resolution("dual-layout-deft-and-core", [".deft/core", "deft/"]);
  }

  // L2: copied core without exact pin (Go deposit / pin-stripped).
  if (hasCore) {
    return resolution("vendored-core-go", [".deft/core (copied-core evidence, no exact pin)"]);
  }

  // Align with LegacyLayoutKind: orphan-deft-version
  if (isFile(join(projectRoot, ".deft", "VERSION")) && !isDir(join(projectRoot, ".deft", "core"))) {
    return resolution("orphan-deft-version", [".deft/VERSION"]);
  }

  const deftDir = join(projectRoot, LEGACY_DEFT_DIR);
  if (frameworkDeft) {
    const submoduleGit = isFile(join(deftDir, ".git")) || isDir(join(deftDir, ".git"));
    if (submoduleGit) {
      if (isUnsafeSubmoduleGitlink(projectRoot)) {
        return resolution(
          "submodule-deft",
          ["deft/", "deft/.git", "gitlink mode 160000"],
          "unsupported-honest",
        );
      }
      return resolution("submodule-deft", ["deft/", "deft/.git"]);
    }
    return resolution("go-tarball-deft-root", ["deft/"]);
  }

  // Submodule recorded but not checked out (legacy-detect git-clone-or-submodule).
  const gitmodulesPath = join(projectRoot, ".gitmodules");
  if (isFile(gitmodulesPath)) {
    const text = readText(gitmodulesPath);
    if (text !== null && gitmodulesReferencesFramework(text)) {
      if (isUnsafeSubmoduleGitlink(projectRoot)) {
        return resolution(
          "submodule-deft",
          [".gitmodules", "gitlink mode 160000"],
          "unsupported-honest",
        );
      }
      return resolution("submodule-deft", [".gitmodules"]);
    }
  }

  return null;
}
