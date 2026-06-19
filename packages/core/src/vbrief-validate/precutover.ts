import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEPRECATION_SENTINEL } from "../vbrief-build/constants.js";

export { DEPRECATION_SENTINEL as DEPRECATED_REDIRECT_SENTINEL };

const DEPRECATION_REDIRECT_PURPOSE = "<!-- Purpose: deprecation redirect -->";
const GENERATED_SPEC_PURPOSE = "<!-- Purpose: rendered specification -->";
const GENERATED_SPEC_SOURCE = "<!-- Source of truth: vbrief/specification.vbrief.json -->";
const SPEC_SOURCE_RELPATH = join("vbrief", "specification.vbrief.json");

const LIFECYCLE_FOLDERS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

function missingLifecycleFolders(projectRoot: string): string[] {
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

function isGeneratedSpecificationExport(projectRoot: string, content: string): boolean {
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
