/**
 * Static dest-mutation ban on removeStaleMigratedFrameworkNarrative
 * (#3437 / #3392 / #3458 / #3462).
 *
 * Salvage from halted PR 3453: the function-level import-ban only.
 * A full init-deposit/** walk is not architecture-independent on master
 * (leftover renameSync in agent-hooks.ts; collectReplaceTreeMutations is
 * the rejected collect-only planner).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_SRC = join(import.meta.dirname, "..");
const MIGRATE_PROJECT = join(CORE_SRC, "xbrief-migrate", "migrate-project.ts");

/** Dest-mutating node:fs APIs. Reads (readFileSync, existsSync, …) stay allowed. */
const DEST_MUTATION_CALL =
  /\b(rmSync|unlinkSync|unlink|rmdirSync|rmdir|writeFileSync|appendFileSync|renameSync|copyFileSync|cpSync)\s*\(/g;

function extractFunctionBody(source: string, name: string): string | null {
  const header = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{`,
    "m",
  );
  const match = header.exec(source);
  if (match === null || match.index === undefined) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function destMutationHits(source: string, rel: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(DEST_MUTATION_CALL)) {
    const idx = match.index ?? 0;
    const line = source.slice(0, idx).split("\n").length;
    hits.push(`${rel}:${line} ${match[1]}`);
  }
  return hits;
}

describe("removeStaleMigratedFrameworkNarrative dest-mutation ban (#3437 / #3392 / #3458 / #3462)", () => {
  it("bans raw dest-mutating node:fs on removeStaleMigratedFrameworkNarrative", () => {
    const source = readFileSync(MIGRATE_PROJECT, "utf8");
    const rel = "xbrief-migrate/migrate-project.ts#removeStaleMigratedFrameworkNarrative";
    const body = extractFunctionBody(source, "removeStaleMigratedFrameworkNarrative");
    expect(
      body,
      "migrate-project.ts must export removeStaleMigratedFrameworkNarrative",
    ).not.toBeNull();
    const violations = destMutationHits(body ?? "", rel);
    expect(violations, `dest-mutation bypasses:\n${violations.join("\n")}`).toEqual([]);
  });
});
