import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEPRECATED_FILES } from "./constants.js";
import { isCurrentGeneratedSpecification, isDeprecationRedirect } from "./precutover.js";

/** Check that deprecated root markdown files contain redirect sentinels (#334). */
export function validateDeprecatedPlaceholders(vbriefDir: string): string[] {
  const warnings: string[] = [];
  const projectRoot = resolve(vbriefDir, "..");

  for (const filename of DEPRECATED_FILES) {
    const filepath = join(projectRoot, filename);
    if (!existsSync(filepath)) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(filepath, "utf8");
    } catch {
      continue;
    }

    if (isDeprecationRedirect(content)) {
      continue;
    }
    if (filename === "SPECIFICATION.md" && isCurrentGeneratedSpecification(projectRoot, content)) {
      continue;
    }
    warnings.push(
      `${filename} contains non-redirect content -- ` +
        "this file is deprecated; use scope vBRIEFs " +
        "in vbrief/ instead",
    );
  }

  return warnings;
}
