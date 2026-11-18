/**
 * #5961 / AC8.10: setup removes exactly the `.deft/core` lines Directive wrote
 * into `.prettierignore`, `greptile.json` and the CodeQL config, and keeps the
 * files and every other line. #6167 / AC13.3: the hook-file line goes into an
 * existing `.prettierignore` only.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addPrettierIgnoreHookLine,
  CODEQL_CONFIG_REL,
  ensurePrettierIgnoreHookLine,
  isRetiredGitattributesLine,
  PRETTIERIGNORE_HOOK_FILES_LINE,
  PRETTIERIGNORE_MANAGED_HEADER,
  removeRetiredCopyModelLines,
  stripRetiredCodeqlConfig,
  stripRetiredGreptileIgnore,
  stripRetiredPrettierIgnore,
} from "./retired-copy-model-lines.js";

const OLD_PRETTIER_HEADER =
  "# Deft framework: the vendored payload is outside the consumer Prettier gate (#2534).";

/** Exact CodeQL config Directive created before the new layout. */
const OLD_CODEQL_DEFAULT =
  "# Deft framework: exclude the vendored payload from CodeQL analysis (#1430).\n" +
  "# .deft/core/** is packaged framework code, not consumer source.\n" +
  'name: "CodeQL config (deft)"\n' +
  "paths-ignore:\n" +
  "  - '.deft/core/**'\n";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-5961-"));
  created.push(root);
  return root;
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("stripRetiredPrettierIgnore (#5961)", () => {
  it("removes the old header and entry and keeps the customer's lines", () => {
    const before = `dist/\ncoverage/\n\n${OLD_PRETTIER_HEADER}\n.deft/core/\n`;
    expect(stripRetiredPrettierIgnore(before)).toBe("dist/\ncoverage/\n");
  });

  it("removes the alternate spellings the old writer treated as the same entry", () => {
    expect(stripRetiredPrettierIgnore("a\n.deft/core\nb\n.deft/core/**\n")).toBe("a\nb\n");
  });

  it("keeps CRLF line endings", () => {
    expect(stripRetiredPrettierIgnore("dist/\r\n.deft/core/\r\nbuild/\r\n")).toBe(
      "dist/\r\nbuild/\r\n",
    );
  });

  it("returns null when there is nothing to remove", () => {
    expect(stripRetiredPrettierIgnore("dist/\n.deft/other/\n")).toBeNull();
  });
});

describe("stripRetiredGreptileIgnore (#5961)", () => {
  it("removes only the .deft/core pattern and keeps every other byte", () => {
    const before =
      '{\n    "reviewRules": ["x"],\n    "ignorePatterns": "dist/**\\n.deft/core/**\\nbuild/**",\n    "z": 1\n}\n';
    expect(stripRetiredGreptileIgnore(before)).toBe(
      '{\n    "reviewRules": ["x"],\n    "ignorePatterns": "dist/**\\nbuild/**",\n    "z": 1\n}\n',
    );
  });

  it("keeps the key, empty, when the pattern was the only one", () => {
    expect(stripRetiredGreptileIgnore('{\n  "ignorePatterns": ".deft/core/**"\n}\n')).toBe(
      '{\n  "ignorePatterns": ""\n}\n',
    );
  });

  it("leaves files it cannot edit safely alone", () => {
    expect(stripRetiredGreptileIgnore("not json")).toBeNull();
    expect(stripRetiredGreptileIgnore('{"ignorePatterns": ["x"]}')).toBeNull();
    expect(stripRetiredGreptileIgnore('{"ignorePatterns": "dist/**"}')).toBeNull();
  });
});

describe("stripRetiredCodeqlConfig (#5961)", () => {
  it("strips Directive's default config down to its name line", () => {
    expect(stripRetiredCodeqlConfig(OLD_CODEQL_DEFAULT)).toBe('name: "CodeQL config (deft)"\n');
  });

  it("keeps the customer's other paths-ignore items and keys", () => {
    const before =
      'name: "mine"\npaths-ignore:\n  - "vendor/**"\n  - ".deft/core/**"\n  - .deft/core/**\nqueries:\n  - uses: security-extended\n';
    expect(stripRetiredCodeqlConfig(before)).toBe(
      'name: "mine"\npaths-ignore:\n  - "vendor/**"\nqueries:\n  - uses: security-extended\n',
    );
  });

  it("does not touch a .deft/core item outside paths-ignore", () => {
    expect(stripRetiredCodeqlConfig("paths:\n  - '.deft/core/**'\n")).toBeNull();
  });
});

describe("removeRetiredCopyModelLines (#5961)", () => {
  it("edits each old file once, keeps the files, and a second run changes nothing", () => {
    const root = project();
    write(root, ".prettierignore", `dist/\n\n${OLD_PRETTIER_HEADER}\n.deft/core/\n`);
    write(root, "greptile.json", '{\n  "ignorePatterns": "dist/**\\n.deft/core/**"\n}\n');
    write(root, CODEQL_CONFIG_REL, OLD_CODEQL_DEFAULT);

    expect(removeRetiredCopyModelLines(root).sort()).toEqual(
      [".prettierignore", CODEQL_CONFIG_REL, "greptile.json"].sort(),
    );
    expect(read(root, ".prettierignore")).toBe("dist/\n");
    expect(read(root, "greptile.json")).toBe('{\n  "ignorePatterns": "dist/**"\n}\n');
    expect(read(root, CODEQL_CONFIG_REL)).toBe('name: "CodeQL config (deft)"\n');
    for (const rel of [".prettierignore", "greptile.json", CODEQL_CONFIG_REL]) {
      expect(read(root, rel)).not.toContain(".deft/core");
    }

    expect(removeRetiredCopyModelLines(root)).toEqual([]);
  });

  it("creates nothing in a project without those files", () => {
    const root = project();
    expect(removeRetiredCopyModelLines(root)).toEqual([]);
    expect(existsSync(join(root, ".prettierignore"))).toBe(false);
    expect(existsSync(join(root, "greptile.json"))).toBe(false);
    expect(existsSync(join(root, CODEQL_CONFIG_REL))).toBe(false);
  });
});

describe("prettierignore hook-file line (#6167 / AC13.3)", () => {
  it("appends the line under the managed header once", () => {
    const once = addPrettierIgnoreHookLine("dist/\n");
    expect(once).toBe(
      `dist/\n\n${PRETTIERIGNORE_MANAGED_HEADER}\n${PRETTIERIGNORE_HOOK_FILES_LINE}\n`,
    );
    expect(addPrettierIgnoreHookLine(once ?? "")).toBeNull();
  });

  it("puts the line back under an existing managed header", () => {
    expect(addPrettierIgnoreHookLine(`${PRETTIERIGNORE_MANAGED_HEADER}\ndist/\n`)).toBe(
      `${PRETTIERIGNORE_MANAGED_HEADER}\n${PRETTIERIGNORE_HOOK_FILES_LINE}\ndist/\n`,
    );
  });

  it("writes an existing .prettierignore and never creates one", () => {
    const without = project();
    expect(ensurePrettierIgnoreHookLine(without)).toBe(false);
    expect(existsSync(join(without, ".prettierignore"))).toBe(false);

    const withFile = project();
    write(withFile, ".prettierignore", "dist/");
    expect(ensurePrettierIgnoreHookLine(withFile)).toBe(true);
    expect(read(withFile, ".prettierignore")).toBe(
      `dist/\n\n${PRETTIERIGNORE_MANAGED_HEADER}\n${PRETTIERIGNORE_HOOK_FILES_LINE}\n`,
    );
    expect(ensurePrettierIgnoreHookLine(withFile)).toBe(false);
  });
});

describe("isRetiredGitattributesLine (#5961)", () => {
  it("knows the retired lines and their comments, not managed or customer lines", () => {
    expect(isRetiredGitattributesLine(".deft/core/** linguist-vendored=true")).toBe(true);
    expect(isRetiredGitattributesLine(".deft/core/** text eol=lf")).toBe(true);
    expect(isRetiredGitattributesLine("# byte identity (#5245).")).toBe(true);
    expect(isRetiredGitattributesLine(".githooks/** text=auto eol=lf")).toBe(false);
    expect(isRetiredGitattributesLine("*.png binary")).toBe(false);
  });
});
