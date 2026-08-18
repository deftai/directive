/**
 * Static chokepoint-enforcement contract (#3437 / #3392 / #3458).
 *
 * Dest mutation on the update / dry-run path must go through containedWrite
 * or containedRemove. Raw node:fs dest writers are a statically banned
 * bypass — not merely a documented bug.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_SRC = join(import.meta.dirname, "..");

/** Dest-mutating node:fs APIs. Reads (readFileSync, existsSync, …) stay allowed. */
const DEST_MUTATION_CALL =
  /\b(rmSync|unlinkSync|unlink|rmdirSync|rmdir|writeFileSync|appendFileSync|renameSync|copyFileSync|cpSync)\s*\(/g;

const ALLOWED_REL = new Set(["fs/contained-write.ts"]);

function walkProductionTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkProductionTs(full, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

function toPosixRel(abs: string): string {
  return abs.slice(CORE_SRC.length + 1).replace(/\\/g, "/");
}

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

describe("dry-run dest-mutation chokepoint (#3437 / #3392 / #3458)", () => {
  it("bans raw node:fs dest mutation on the update/dry-run path", () => {
    const files = [
      ...walkProductionTs(join(CORE_SRC, "init-deposit")),
      join(CORE_SRC, "xbrief-migrate", "migrate-project.ts"),
      join(CORE_SRC, "deposit", "copy-tree.ts"),
    ];
    const violations: string[] = [];
    for (const abs of files) {
      const rel = toPosixRel(abs);
      if (ALLOWED_REL.has(rel)) continue;
      const source = readFileSync(abs, "utf8");
      if (rel === "xbrief-migrate/migrate-project.ts") {
        const body = extractFunctionBody(source, "removeStaleMigratedFrameworkNarrative");
        expect(body, `${rel} must export removeStaleMigratedFrameworkNarrative`).not.toBeNull();
        violations.push(...destMutationHits(body ?? "", `${rel}#removeStaleMigratedFrameworkNarrative`));
        continue;
      }
      if (rel === "deposit/copy-tree.ts") {
        const body = extractFunctionBody(source, "collectReplaceTreeMutations");
        expect(body, `${rel} must define collectReplaceTreeMutations`).not.toBeNull();
        violations.push(...destMutationHits(body ?? "", `${rel}#collectReplaceTreeMutations`));
        continue;
      }
      violations.push(...destMutationHits(source, rel));
    }
    expect(violations, `dest-mutation bypasses:\n${violations.join("\n")}`).toEqual([]);
  });
});
