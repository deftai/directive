import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEPRECATION_SENTINEL } from "../vbrief-build/constants.js";

export { DEPRECATION_SENTINEL as DEPRECATED_REDIRECT_SENTINEL };

const DEPRECATION_REDIRECT_PURPOSE = "<!-- Purpose: deprecation redirect -->";
const GENERATED_SPEC_PURPOSE = "<!-- Purpose: rendered specification -->";
const GENERATED_SPEC_SOURCE = "<!-- Source of truth: vbrief/specification.vbrief.json -->";
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

export function isGeneratedSpecificationExport(projectRoot: string, content: string): boolean {
  return (
    content.includes(GENERATED_SPEC_PURPOSE) &&
    content.includes(GENERATED_SPEC_SOURCE) &&
    existsSync(join(projectRoot, SPEC_SOURCE_RELPATH))
  );
}

/** Return true for a fully current ``task spec:render`` root export. */
export function isCurrentGeneratedSpecification(projectRoot: string, content: string): boolean {
  return isGeneratedSpecificationExport(projectRoot, content) && hasCompleteLifecycle(projectRoot);
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
  if (filename === "SPECIFICATION.md" && isGeneratedSpecificationExport(projectRoot, content)) {
    return false;
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
  /** True when any legacy pre-v0.20 artifact still needs migration. */
  preCutover: boolean;
  /** Human-readable reasons; empty when the project is on the current model. */
  reasons: string[];
}

/**
 * Detect whether ``projectRoot`` still carries pre-v0.20 (pre-cutover) document-model
 * artifacts that need migration. Mirrors the AGENTS.md "Pre-Cutover Check" rule and the
 * legacy ``scripts/_precutover.py`` helper: a project is pre-cutover when any of the
 * following hold:
 *
 * - ``SPECIFICATION.md`` exists and is neither a deprecation redirect nor a current
 *   generated spec export;
 * - ``PROJECT.md`` exists and is not a deprecation redirect;
 * - ``vbrief/`` exists but is missing one or more lifecycle folders.
 */
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

/**
 * Render the single-line pre-cutover status string surfaced by ``deft doctor``.
 * Flags the migration-needed state with reasons, or reports a clean current-model state.
 */
export function renderPrecutoverLine(projectRoot: string): string {
  const { preCutover, reasons } = detectPreCutover(projectRoot);
  if (!preCutover) {
    return "Pre-cutover: none -- project is on the current vBRIEF document model.";
  }
  // Collapse any embedded newlines so the status line stays a single line (CWE-116).
  const summary = reasons.join("; ").replace(/\r?\n/g, " ");
  return `Pre-cutover: migration needed -- ${summary}. Run \`deft migrate:vbrief\` to migrate.`;
}
