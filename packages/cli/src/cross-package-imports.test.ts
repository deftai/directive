import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #1993 regression gate. Shipped CLI source MUST import sibling packages by
// their published package name (e.g. `@deftai/directive-core/dist/...`), never
// by a workspace-relative path (`../../core/dist/...`). The relative form
// resolves fine inside the monorepo but, once published, points at
// `node_modules/@deftai/core` -- a package that does not exist (the real one is
// `@deftai/directive-core`) -- so `npx @deftai/directive <verb>` crashed with a
// module-not-found error for every verb routed through such an import.
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)));

// Matches both `from "../../core/dist/..."` and `await import("../../core/...")`
// for the three sibling source packages.
const FORBIDDEN = /['"]\.\.\/\.\.\/(core|content|types)\//;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("cross-package import hygiene (#1993)", () => {
  it("no shipped CLI source imports a sibling package by workspace-relative path", () => {
    const violations: string[] = [];
    for (const file of tsFiles(SRC_DIR)) {
      // Tests may import sibling source directly; only shipped modules ship.
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf-8");
      text.split("\n").forEach((line, i) => {
        if (FORBIDDEN.test(line)) {
          violations.push(`${relative(SRC_DIR, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      violations,
      `Use the published package name (e.g. "@deftai/directive-core/dist/...") instead of a ` +
        `workspace-relative import. Offending lines:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
