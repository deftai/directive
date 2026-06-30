#!/usr/bin/env node
/**
 * Copy canonical vBRIEF/xBRIEF core schemas into the types package publish surface.
 * v0.6: content/vbrief/schemas/vbrief-core.schema.json (#1799)
 * v0.8: content/vbrief/schemas/xbrief-core-0.8.schema.json (#2107)
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const schemaDir = join(repoRoot, "content", "vbrief", "schemas");
const destDir = join(here, "..", "schemas");

mkdirSync(destDir, { recursive: true });

copyFileSync(
  join(schemaDir, "vbrief-core.schema.json"),
  join(destDir, "vbrief-core-0.6.schema.json"),
);
copyFileSync(
  join(schemaDir, "xbrief-core-0.8.schema.json"),
  join(destDir, "xbrief-core-0.8.schema.json"),
);
