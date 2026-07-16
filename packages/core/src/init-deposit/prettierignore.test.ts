import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrettierIgnoreLines, PRETTIERIGNORE_DEFT_CORE_LINE } from "./prettierignore.js";

describe("ensurePrettierIgnoreLines", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  function readPrettierignore(root: string): string {
    return readFileSync(join(root, ".prettierignore"), "utf8");
  }

  it("creates .prettierignore with .deft/core/ on greenfield init", () => {
    const root = freshRoot("prettierignore-greenfield-");
    const lines: string[] = [];

    const result = ensurePrettierIgnoreLines(root, { printf: (text) => lines.push(text) });

    expect(result.changed).toBe(true);
    const text = readPrettierignore(root);
    expect(text).toContain(PRETTIERIGNORE_DEFT_CORE_LINE);
    expect(lines.join("")).toContain(".prettierignore updated");
  });

  it("appends to an existing consumer preamble without duplicating lines", () => {
    const root = freshRoot("prettierignore-append-");
    const pre = "# consumer pre-existing\nnode_modules/\n";
    writeFileSync(join(root, ".prettierignore"), pre, "utf8");

    ensurePrettierIgnoreLines(root, { printf: () => {} });

    const text = readPrettierignore(root);
    expect(text.startsWith(pre)).toBe(true);
    expect(text).toContain("node_modules/");
    expect(text).toContain(PRETTIERIGNORE_DEFT_CORE_LINE);
  });

  it("is idempotent on a second run", () => {
    const root = freshRoot("prettierignore-idempotent-");
    const lines: string[] = [];

    ensurePrettierIgnoreLines(root, { printf: (text) => lines.push(text) });
    const first = readPrettierignore(root);

    const result = ensurePrettierIgnoreLines(root, { printf: (text) => lines.push(text) });

    expect(result.changed).toBe(false);
    expect(readPrettierignore(root)).toBe(first);
    expect(lines.join("")).toContain("already excludes");
  });

  it("treats alternate .deft/core spellings as already covered", () => {
    const root = freshRoot("prettierignore-covered-");
    writeFileSync(join(root, ".prettierignore"), ".deft/core\n", "utf8");

    const result = ensurePrettierIgnoreLines(root, { printf: () => {} });

    expect(result.changed).toBe(false);
    expect(readPrettierignore(root)).toBe(".deft/core\n");
  });
});
