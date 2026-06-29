#!/usr/bin/env node
/**
 * Copy the canonical vBRIEF core schema into the types package publish surface.
 * Single source of truth: content/vbrief/schemas/vbrief-core.schema.json (#1799).
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const source = join(repoRoot, "content", "vbrief", "schemas", "vbrief-core.schema.json");
const destDir = join(here, "..", "schemas");
const dest = join(destDir, "vbrief-core-0.6.schema.json");

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
