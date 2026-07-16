/**
 * Consumer `.prettierignore` upkeep for install and npm-managed update (#2534).
 *
 * Managed `.deft/core/` is outside the consumer Prettier format gate. Official
 * install and `directive update` heal the ignore entry idempotently without
 * reformatting the vendored deposit.
 *
 * Refs #2534, #670.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertProjectionContained } from "../fs/projection-containment.js";
import { stripGitignoreInlineComment } from "../triage/bootstrap/gitignore.js";
import type { InitDepositIo } from "./constants.js";

/** Directory ignore entry for the hybrid deposit. */
export const PRETTIERIGNORE_DEFT_CORE_LINE = ".deft/core/";

/** Alternate spellings that already cover the deposit ignore entry. */
const DEFT_CORE_COVERING_LINES = new Set([".deft/core/", ".deft/core", ".deft/core/**"]);

const DEFT_FRAMEWORK_PRETTIERIGNORE_HEADER =
  "# Deft framework: the vendored payload is outside the consumer Prettier gate (#2534).\n";

export interface EnsurePrettierIgnoreResult {
  readonly changed: boolean;
}

function projectionTarget(projectDir: string): string {
  const target = join(projectDir, ".prettierignore");
  assertProjectionContained(projectDir, target);
  return target;
}

function prettierIgnoreCoversLine(present: ReadonlySet<string>, line: string): boolean {
  if (present.has(line)) return true;
  if (line === PRETTIERIGNORE_DEFT_CORE_LINE) {
    return [...DEFT_CORE_COVERING_LINES].some((candidate) => present.has(candidate));
  }
  return false;
}

function collectPresentPrettierIgnoreLines(existing: string): Set<string> {
  const present = new Set<string>();
  for (const raw of existing.split("\n")) {
    const stripped = stripGitignoreInlineComment(raw);
    if (stripped) present.add(stripped);
  }
  return present;
}

/**
 * Ensure the consumer `.prettierignore` excludes managed `.deft/core/` from
 * Prettier. Idempotent; preserves consumer preamble.
 */
export function ensurePrettierIgnoreLines(
  projectDir: string,
  io: InitDepositIo,
): EnsurePrettierIgnoreResult {
  const path = projectionTarget(projectDir);

  let existing = "";
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, { encoding: "utf8" });
    } catch (cause) {
      throw new Error(`could not read .prettierignore: ${String(cause)}`);
    }
  }

  const present = collectPresentPrettierIgnoreLines(existing);
  const targetLines = [PRETTIERIGNORE_DEFT_CORE_LINE];
  const additions = targetLines.filter((line) => !prettierIgnoreCoversLine(present, line));

  if (additions.length === 0) {
    io.printf(".prettierignore already excludes the managed deft framework deposit — skipping.\n");
    return { changed: false };
  }

  let body = existing;
  if (body !== "" && !body.endsWith("\n")) {
    body += "\n";
  }
  if (body !== "" && !body.endsWith("\n\n")) {
    body += "\n";
  }
  body += DEFT_FRAMEWORK_PRETTIERIGNORE_HEADER;
  for (const add of additions) {
    body += `${add}\n`;
  }

  try {
    writeFileSync(path, body, { encoding: "utf8", mode: 0o644 });
  } catch (cause) {
    throw new Error(`could not write .prettierignore: ${String(cause)}`);
  }

  io.printf(`.prettierignore updated with Deft framework exclusions: ${additions.join(", ")}\n`);
  return { changed: true };
}
