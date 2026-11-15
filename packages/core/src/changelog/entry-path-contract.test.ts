/**
 * Contract (#6314 / #6286 item 1): no check matches the literal `CHANGELOG.md`
 * as a path outside `isChangelogEntryPath`. A new literal path match fails
 * this test and names the file.
 *
 * "Path match" here is the code shape, not prose: a `===` / `!==` comparison
 * with the literal, a regular expression for it, a `.has` / `.includes` /
 * `case` membership test, a standalone element of a path list, or a comparison
 * with a constant whose value is the literal. Reading or writing the file
 * (`join(root, "CHANGELOG.md")`, messages) is not a path match.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isChangelogEntryPath } from "./entry-path.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Source roots scanned (repository-relative). */
const SCAN_ROOTS = ["packages", ".github/scripts"] as const;

const SOURCE_EXT_RE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const SKIP_FILE_RE =
  /(?:\.test\.|\.spec\.|\.d\.ts$|(?:^|\/)(?:fixtures?|__fixtures__|test-fixtures)\/)/;
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo"]);

/**
 * The one module that owns the path test, and the CI mirror that cannot import
 * core (pinned to the same answers by the parity test below). Each allowance
 * names the only line shape admitted in that file.
 */
const ALLOWED: Readonly<Record<string, RegExp>> = {
  "packages/core/src/changelog/entry-path.ts": /./,
  ".github/scripts/artifact-only-lifecycle.mjs":
    /^\s*return path === "CHANGELOG\.md" \|\| \/\^changelog\\\.d\\\/\[a-z0-9\._-\]\+\\\.md\$\/\.test\(path\);$/,
};

export interface LiteralChangelogPathMatch {
  readonly path: string;
  readonly line: number;
  readonly rule: "comparison" | "regex" | "membership" | "list-element" | "constant-comparison";
  readonly text: string;
}

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const LIT = String.raw`(?:"CHANGELOG\.md"|'CHANGELOG\.md'|\x60CHANGELOG\.md\x60)`;
const RULES: readonly { rule: LiteralChangelogPathMatch["rule"]; re: RegExp }[] = [
  { rule: "comparison", re: new RegExp(String.raw`[=!]==?\s*` + LIT) },
  { rule: "comparison", re: new RegExp(LIT + String.raw`\s*[=!]==?`) },
  { rule: "regex", re: /CHANGELOG\\{1,2}\.md|CHANGELOG\(\?:\\{1,2}\.md\)/ },
  { rule: "membership", re: new RegExp(String.raw`\.(?:has|includes)\(\s*` + LIT) },
  { rule: "membership", re: new RegExp(String.raw`\bcase\s+` + LIT + String.raw`\s*:`) },
  // Inline literal collections: `["CHANGELOG.md", …].includes(p)`, `new Set(["CHANGELOG.md"])`.
  {
    rule: "membership",
    re: new RegExp(
      String.raw`\[[^\]]*` + LIT + String.raw`[^\]]*\]\s*\.(?:includes|indexOf|some|find|has)\(`,
    ),
  },
  { rule: "membership", re: new RegExp(String.raw`new\s+(?:Set|Map)\s*\(\s*\[[^\]]*` + LIT) },
  { rule: "list-element", re: new RegExp(String.raw`^\s*` + LIT + String.raw`\s*,?\s*$`) },
];

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

const CONST_DECL_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*` + LIT,
);

/** Find literal `CHANGELOG.md` path matches in the given sources (pure). */
export function findLiteralChangelogPathMatches(
  files: readonly SourceFile[],
  allowed: Readonly<Record<string, RegExp>> = ALLOWED,
): LiteralChangelogPathMatch[] {
  // Constants whose value is the literal (plus one alias level), across all files.
  const names = new Set<string>();
  for (const file of files) {
    for (const line of file.text.split(/\r?\n/)) {
      const m = CONST_DECL_RE.exec(line);
      if (m?.[1] !== undefined) names.add(m[1]);
    }
  }
  for (const file of files) {
    for (const line of file.text.split(/\r?\n/)) {
      for (const name of [...names]) {
        const alias = new RegExp(
          String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*` +
            name +
            String.raw`\s*;`,
        ).exec(line);
        if (alias?.[1] !== undefined) names.add(alias[1]);
      }
    }
  }
  const constRes = [...names].map(
    (name) =>
      new RegExp(
        String.raw`(?:[=!]==?\s*${name}\b|\b${name}\s*[=!]==?|\.(?:has|includes)\(\s*${name}\b|\bcase\s+${name}\s*:)`,
      ),
  );

  const out: LiteralChangelogPathMatch[] = [];
  for (const file of files) {
    const allow = allowed[file.path];
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (isCommentLine(line)) continue;
      if (allow?.test(line) === true) continue;
      const hit = RULES.find((r) => r.re.test(line));
      if (hit !== undefined) {
        out.push({ path: file.path, line: i + 1, rule: hit.rule, text: line.trim() });
        continue;
      }
      if (constRes.some((re) => re.test(line))) {
        out.push({ path: file.path, line: i + 1, rule: "constant-comparison", text: line.trim() });
      }
    }
  }
  return out;
}

function walk(absDir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(absDir, entry.name), out);
    } else if (entry.isFile() && SOURCE_EXT_RE.test(entry.name)) {
      out.push(join(absDir, entry.name));
    }
  }
}

function repoSources(): SourceFile[] {
  const abs: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), abs);
  return abs
    .map((p) => relative(REPO_ROOT, p).replace(/\\/g, "/"))
    .filter((rel) => !SKIP_FILE_RE.test(rel))
    .filter((rel) => !rel.startsWith("packages/") || /^packages\/[^/]+\/src\//.test(rel))
    .map((rel) => ({ path: rel, text: readFileSync(join(REPO_ROOT, rel), "utf8") }));
}

describe("changelog entry path contract (#6314)", () => {
  it("finds no literal CHANGELOG.md path match outside isChangelogEntryPath", () => {
    const sources = repoSources();
    expect(sources.length).toBeGreaterThan(100);
    const hits = findLiteralChangelogPathMatches(sources);
    expect(hits.map((h) => `${h.path}:${String(h.line)} [${h.rule}] ${h.text}`)).toEqual([]);
  });

  it("fails on a new literal path match and names the file", () => {
    const hits = findLiteralChangelogPathMatches([
      { path: "packages/core/src/x/compare.ts", text: 'if (p === "CHANGELOG.md") return true;' },
      { path: "packages/core/src/x/regex.ts", text: "const RE = /^(CHANGELOG\\.md|LICENSE)$/i;" },
      { path: "packages/core/src/x/has.ts", text: 'return SET.has("CHANGELOG.md");' },
      { path: "packages/core/src/x/inline.ts", text: 'return ["CHANGELOG.md"].includes(path);' },
      {
        path: "packages/core/src/x/set.ts",
        text: 'const S = new Set(["README.md", "CHANGELOG.md"]);',
      },
      {
        path: "packages/core/src/x/list.ts",
        text: 'const L = [\n  "README.md",\n  "CHANGELOG.md",\n];',
      },
      {
        path: "packages/core/src/x/const.ts",
        text: 'const CL = "CHANGELOG.md";\nexport function f(p: string) { return p === CL; }',
      },
      { path: "packages/core/src/x/alias.ts", text: "const ALIAS = CL;\nif (ALIAS !== q) {}" },
    ]);
    expect(hits.map((h) => [h.path, h.rule])).toEqual([
      ["packages/core/src/x/compare.ts", "comparison"],
      ["packages/core/src/x/regex.ts", "regex"],
      ["packages/core/src/x/has.ts", "membership"],
      ["packages/core/src/x/inline.ts", "membership"],
      ["packages/core/src/x/set.ts", "membership"],
      ["packages/core/src/x/list.ts", "list-element"],
      ["packages/core/src/x/const.ts", "constant-comparison"],
      ["packages/core/src/x/alias.ts", "constant-comparison"],
    ]);
  });

  it("does not flag reads, writes, messages or comments", () => {
    const hits = findLiteralChangelogPathMatches([
      {
        path: "packages/core/src/x/read.ts",
        text: [
          'const p = join(root, "CHANGELOG.md");',
          'io.writeOut("FAIL: CHANGELOG.md not found\\n");',
          '// if (p === "CHANGELOG.md")',
          ' * `p === "CHANGELOG.md"` in a doc comment',
          'export const ARTIFACTS = ["CHANGELOG.md", "ROADMAP.md"] as const;',
        ].join("\n"),
      },
    ]);
    expect(hits).toEqual([]);
  });

  it("admits only the named line shape in an allowed file", () => {
    const hits = findLiteralChangelogPathMatches([
      {
        path: ".github/scripts/artifact-only-lifecycle.mjs",
        text: 'function g(n) { return n === "CHANGELOG.md"; }',
      },
    ]);
    expect(hits.map((h) => h.path)).toEqual([".github/scripts/artifact-only-lifecycle.mjs"]);
  });

  it("CI script mirror answers the same as isChangelogEntryPath", async () => {
    const url = pathToFileURL(join(REPO_ROOT, ".github/scripts/artifact-only-lifecycle.mjs")).href;
    const mod = (await import(url)) as { isChangelogEntryPath: (p: string) => boolean };
    const vectors = [
      "CHANGELOG.md",
      "changelog.d/6286-fragments.md",
      "changelog.d/a.b_c-d.md",
      "changelog.d/sub/x.md",
      "changelog.d/X.md",
      "changelog.d/.md",
      "changelog.d/x.txt",
      "changelog.d",
      "docs/CHANGELOG.md",
      "changelog.md",
      "./CHANGELOG.md",
      "CHANGELOG.md/x",
      "",
    ];
    for (const v of vectors) {
      expect([v, mod.isChangelogEntryPath(v)]).toEqual([v, isChangelogEntryPath(v)]);
    }
  });
});
