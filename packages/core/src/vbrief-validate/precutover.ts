import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_SPEC_PURPOSE, GENERATED_SPEC_SOURCE_SPEC } from "../spec-authority/constants.js";
import { isFullSpecState, isGreenfieldSpecExport } from "../spec-authority/resolver.js";
import { DEPRECATION_SENTINEL } from "../vbrief-build/constants.js";

export { DEPRECATION_SENTINEL as DEPRECATED_REDIRECT_SENTINEL };

const DEPRECATION_REDIRECT_PURPOSE = "<!-- Purpose: deprecation redirect -->";
const SPEC_SOURCE_RELPATH = join("vbrief", "specification.vbrief.json");

const LIFECYCLE_FOLDERS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

export function missingLifecycleFolders(projectRoot: string): string[] {
  const vbriefRoot = join(projectRoot, "vbrief");
  return LIFECYCLE_FOLDERS.filter((folder) => !existsSync(join(vbriefRoot, folder)));
}

function hasCompleteLifecycle(projectRoot: string): boolean {
  return missingLifecycleFolders(projectRoot).length === 0;
}

/** Return true when markdown content is a migration redirect stub. */
export function isDeprecationRedirect(content: string): boolean {
  return content.includes(DEPRECATION_SENTINEL) || content.includes(DEPRECATION_REDIRECT_PURPOSE);
}

/** Full-spec generated export (specification.vbrief.json source line). */
export function isGeneratedSpecificationExport(projectRoot: string, content: string): boolean {
  return (
    content.includes(GENERATED_SPEC_PURPOSE) &&
    content.includes(GENERATED_SPEC_SOURCE_SPEC) &&
    existsSync(join(projectRoot, SPEC_SOURCE_RELPATH))
  );
}

/** Return true for a fully current generated spec export (full-spec or greenfield). */
export function isCurrentGeneratedSpecification(projectRoot: string, content: string): boolean {
  if (!hasCompleteLifecycle(projectRoot)) return false;
  if (isGeneratedSpecificationExport(projectRoot, content)) return true;
  return isGreenfieldSpecExport(projectRoot);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function rootMarkdownIsLegacy(projectRoot: string, filename: string, content: string): boolean {
  if (isDeprecationRedirect(content)) return false;
  if (filename === "SPECIFICATION.md") {
    if (isGeneratedSpecificationExport(projectRoot, content)) return false;
    if (isGreenfieldSpecExport(projectRoot)) return false;
  }
  return filename === "SPECIFICATION.md" || filename === "PROJECT.md";
}

/** Return root artifact filenames that are legacy pre-v0.20 inputs (#793 / migrate preflight). */
export function detectPreCutoverLegacy(projectRoot: string): string[] {
  const legacy: string[] = [];
  for (const filename of ["SPECIFICATION.md", "PROJECT.md"] as const) {
    const candidate = join(projectRoot, filename);
    if (!isFile(candidate)) continue;
    const content = safeReadText(candidate);
    if (rootMarkdownIsLegacy(projectRoot, filename, content)) {
      legacy.push(filename);
    }
  }
  return legacy;
}

/** Structured result of a pre-cutover (pre-v0.20 document model) probe. */
export interface PrecutoverDetection {
  preCutover: boolean;
  reasons: string[];
}

export function detectPreCutover(projectRoot: string): PrecutoverDetection {
  const reasons: string[] = [];

  const specPath = join(projectRoot, "SPECIFICATION.md");
  if (isFile(specPath)) {
    const content = safeReadText(specPath);
    if (!isDeprecationRedirect(content) && !isCurrentGeneratedSpecification(projectRoot, content)) {
      reasons.push(
        "SPECIFICATION.md is a pre-v0.20 hand-authored doc (not a deprecation redirect or current generated export)",
      );
    }
  }

  const projectMdPath = join(projectRoot, "PROJECT.md");
  if (isFile(projectMdPath)) {
    const content = safeReadText(projectMdPath);
    if (!isDeprecationRedirect(content)) {
      reasons.push("PROJECT.md is a pre-v0.20 hand-authored doc (not a deprecation redirect)");
    }
  }

  const vbriefRoot = join(projectRoot, "vbrief");
  if (existsSync(vbriefRoot)) {
    const missing = missingLifecycleFolders(projectRoot);
    if (missing.length > 0) {
      reasons.push(`vbrief/ is missing lifecycle folder(s): ${missing.join(", ")}`);
    }
  }

  return { preCutover: reasons.length > 0, reasons };
}

export function renderPrecutoverLine(projectRoot: string): string {
  const { preCutover, reasons } = detectPreCutover(projectRoot);
  if (!preCutover) {
    return "Pre-cutover: none -- project is on the current vBRIEF document model.";
  }
  const summary = reasons.join("; ").replace(/\r?\n/g, " ");
  return `Pre-cutover: migration needed -- ${summary}. Run \`deft migrate:vbrief\` to migrate.`;
}

// Re-export for classify callers (#2013).
export { isFullSpecState, isGreenfieldSpecExport };
