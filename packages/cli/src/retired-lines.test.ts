/**
 * Uninstall removes the lines Directive wrote into shared files (#6007 /
 * AC8.10 / AC13.3) and leaves every other line byte-identical.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePrettierIgnoreLines,
  PRETTIERIGNORE_DEFT_CORE_LINE,
} from "@deftai/directive-core/dist/init-deposit/prettierignore.js";
import {
  DESIRED_GITATTRIBUTES_LINES,
  ensureCodeqlPathsIgnore,
  ensureGitattributes,
  ensureGreptileIgnore,
  gitattributesDepositComment,
  LEGACY_CORE_TEXT_EOL_LF,
  MANAGED_WIRING_GITATTRIBUTES_LINES,
} from "@deftai/directive-core/dist/init-deposit/scaffold.js";
import { classifyDirectiveOwnedChange } from "@deftai/directive-core/dist/install-health/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEQL_CONFIG_REL,
  DIRECTIVE_WRITTEN_LINES,
  filesWithDirectiveLines,
  removeDirectiveWrittenLines,
  stripCodeqlConfig,
  stripDirectiveLines,
  stripGreptileJson,
} from "./retired-lines.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "uninstall-lines-"));
  roots.push(root);
  return root;
}

const quietIo = { printf: () => {} };

function write(root: string): (rel: string, body: string) => boolean {
  return (rel, body) => {
    writeFileSync(join(root, rel), body);
    return true;
  };
}

describe("Directive-written lines in shared files (#6007)", () => {
  it("core writers then uninstall leaves the user's files byte-identical", () => {
    const root = tempRoot();
    const user = {
      ".gitattributes": "*.png binary\n# user comment\n*.sh text eol=lf\n",
      ".prettierignore": "dist/\n# keep\ncoverage/\n",
      "greptile.json": `{\n  "comment": "user",\n  "ignorePatterns": "build/**\\nvendor/**",\n  "strictness": 2\n}\n`,
      [CODEQL_CONFIG_REL]: `name: "My CodeQL"\npaths-ignore:\n  - 'dist/**'\nqueries:\n  - uses: security-extended\n`,
    } as const;
    mkdirSync(join(root, ".github", "codeql"), { recursive: true });
    for (const [rel, body] of Object.entries(user)) writeFileSync(join(root, rel), body);

    // The writers Directive used before OVPR and the managed block it writes today.
    ensureGitattributes(root, quietIo);
    ensurePrettierIgnoreLines(root, quietIo);
    ensureGreptileIgnore(root, quietIo);
    ensureCodeqlPathsIgnore(root, quietIo);
    for (const [rel, body] of Object.entries(user)) {
      expect(readFileSync(join(root, rel), "utf8")).not.toBe(body);
    }
    expect(filesWithDirectiveLines(root).sort()).toEqual(Object.keys(user).sort());

    const report = removeDirectiveWrittenLines(root, write(root));
    expect(report.leftovers).toEqual([]);
    for (const [rel, body] of Object.entries(user)) {
      expect(readFileSync(join(root, rel), "utf8")).toBe(body);
    }
    expect(filesWithDirectiveLines(root)).toEqual([]);
  });

  it("files Directive created keep existing, emptied of Directive lines (never deleted)", () => {
    const root = tempRoot();
    ensureGitattributes(root, quietIo);
    ensureGreptileIgnore(root, quietIo);
    ensureCodeqlPathsIgnore(root, quietIo);
    removeDirectiveWrittenLines(root, write(root));
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe("");
    expect(JSON.parse(readFileSync(join(root, "greptile.json"), "utf8"))).toEqual({
      ignorePatterns: "",
    });
    // The old default config keeps its name line; paths-ignore held only Directive's item.
    expect(readFileSync(join(root, CODEQL_CONFIG_REL), "utf8")).toBe(
      'name: "CodeQL config (deft)"\n',
    );
    expect(filesWithDirectiveLines(root)).toEqual([]);
  });

  it("keeps CRLF line endings and the user's blank lines", () => {
    const body =
      "*.png binary\r\n\r\n*.txt text\r\n\r\n# Deft managed wiring: pin Directive-deposited host/command/hook/skill paths\r\n# to LF so Windows core.autocrlf checkouts stay ownership-comparable (#5995).\r\n.githooks/** text=auto eol=lf\r\nAGENTS.md text=auto eol=lf\r\n";
    const { next, removed } = stripDirectiveLines(body, DIRECTIVE_WRITTEN_LINES[".gitattributes"]);
    expect(removed).toBe(true);
    expect(next).toBe("*.png binary\r\n\r\n*.txt text\r\n");
  });

  it("removes the AC13.3 hook-file line under a managed-wiring header in .prettierignore", () => {
    const body =
      "dist/\n\n# Deft managed wiring: committed host hook files stay out of the formatter check.\n**/deft-hook-*.mjs\n";
    const { next } = stripDirectiveLines(body, DIRECTIVE_WRITTEN_LINES[".prettierignore"]);
    expect(next).toBe("dist/\n");
  });

  it("keeps a managed-wiring header that introduces a user line", () => {
    const body = "# Deft managed wiring: user reused the header\nmy-file.txt text\n";
    const { next, removed } = stripDirectiveLines(body, DIRECTIVE_WRITTEN_LINES[".gitattributes"]);
    expect(removed).toBe(false);
    expect(next).toBe(body);
  });

  it("keeps a user paths-ignore item and drops only Directive's", () => {
    const body = `paths-ignore:\n  - "dist/**"\n  - ".deft/core/**"\n`;
    expect(stripCodeqlConfig(body).next).toBe(`paths-ignore:\n  - "dist/**"\n`);
  });

  it("keeps each user line's own ending in a mixed LF/CRLF file", () => {
    const body = "a.png binary\nb.txt text\r\n.githooks/** text=auto eol=lf\nc.sh text\n";
    expect(stripDirectiveLines(body, DIRECTIVE_WRITTEN_LINES[".gitattributes"]).next).toBe(
      "a.png binary\nb.txt text\r\nc.sh text\n",
    );
  });

  it("keeps paths-ignore when a column-0 comment sits before a user item", () => {
    const body =
      "name: Analysis\npaths-ignore:\n  - '.deft/core/**'\n# Generated files\n  - 'dist/**'\n";
    expect(stripCodeqlConfig(body).next).toBe(
      "name: Analysis\npaths-ignore:\n# Generated files\n  - 'dist/**'\n",
    );
  });

  it("keeps paths-ignore for an unindented user list item", () => {
    const body = "paths-ignore:\n- '.deft/core/**'\n- 'dist/**'\nqueries: []\n";
    expect(stripCodeqlConfig(body).next).toBe("paths-ignore:\n- 'dist/**'\nqueries: []\n");
  });

  it("keeps the kept line's own newline when the removed last line had none", () => {
    const body = "a.png binary\n.githooks/** text=auto eol=lf";
    expect(stripDirectiveLines(body, DIRECTIVE_WRITTEN_LINES[".gitattributes"]).next).toBe(
      "a.png binary\n",
    );
  });

  it("keeps a user comment under the managed-wiring header", () => {
    const body =
      "# Deft managed wiring: pin Directive-deposited host/command/hook/skill paths\n# my note\n.githooks/** text=auto eol=lf\n";
    expect(stripDirectiveLines(body, DIRECTIVE_WRITTEN_LINES[".gitattributes"]).next).toBe(
      "# my note\n",
    );
  });

  it("edits ignorePatterns by its key, not another field with the same text", () => {
    const raw = `{"ignorePatterns":".deft\\/core/**","comment":".deft/core/**"}\n`;
    expect(stripGreptileJson(raw)).toEqual({
      next: `{"ignorePatterns":"","comment":".deft/core/**"}\n`,
      removed: true,
    });
  });

  it("leaves greptile.json alone when the key cannot be found exactly once", () => {
    // The key appears twice (once nested): an in-place edit could hit the wrong one.
    const raw = `{"nested": {"ignorePatterns": "x"}, "ignorePatterns": ".deft/core/**"}\n`;
    expect(stripGreptileJson(raw)).toBe("unsafe");
    const root = tempRoot();
    writeFileSync(join(root, "greptile.json"), raw);
    const report = removeDirectiveWrittenLines(root, write(root));
    expect(report.leftovers).toEqual(["greptile.json (Directive lines)"]);
    expect(readFileSync(join(root, "greptile.json"), "utf8")).toBe(raw);
  });

  it("knows every line core writes today (launcher copy vs core)", () => {
    const coreGitattributes = new Set<string>([
      ...DESIRED_GITATTRIBUTES_LINES,
      LEGACY_CORE_TEXT_EOL_LF,
    ]);
    for (const sample of [
      DESIRED_GITATTRIBUTES_LINES,
      DESIRED_GITATTRIBUTES_LINES.filter((l) => l.includes("text=auto eol=lf")),
      MANAGED_WIRING_GITATTRIBUTES_LINES,
      [],
    ]) {
      for (const line of gitattributesDepositComment(sample).split("\n")) {
        if (line.trim()) coreGitattributes.add(line.trim());
      }
    }
    for (const line of coreGitattributes) {
      expect(DIRECTIVE_WRITTEN_LINES[".gitattributes"].has(line), line).toBe(true);
    }
    expect(DIRECTIVE_WRITTEN_LINES[".prettierignore"].has(PRETTIERIGNORE_DEFT_CORE_LINE)).toBe(
      true,
    );
  });

  it("each strip is a Directive-only change by the core ownership API", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gitattributes"), "*.png binary\n");
    writeFileSync(join(root, ".prettierignore"), "dist/\n");
    ensureGitattributes(root, quietIo);
    ensurePrettierIgnoreLines(root, quietIo);
    const before = {
      ".gitattributes": readFileSync(join(root, ".gitattributes"), "utf8"),
      ".prettierignore": readFileSync(join(root, ".prettierignore"), "utf8"),
    };
    removeDirectiveWrittenLines(root, write(root));
    for (const [rel, body] of Object.entries(before)) {
      const after = readFileSync(join(root, rel), "utf8");
      expect(classifyDirectiveOwnedChange(rel, body, after)).toBe("directive-only");
    }
  });
});
