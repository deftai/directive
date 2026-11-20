/**
 * Directive-only drop helpers (#5771): raw-path canonical form, HEAD tree
 * reads against a real git repository, and the refusal note.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatDirectiveOnlyRefusalNote,
  isCanonicalStagedPath,
  isDirectivePathClass,
  parseLsTreeZ,
  readHeadTreeEntries,
} from "./directive-only-drop.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-directive-only-drop-"));
  temps.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "core.hooksPath", "/dev/null"]);
  return root;
}

describe("isCanonicalStagedPath (#5771)", () => {
  it("accepts only the form the ownership API reads", () => {
    expect(isCanonicalStagedPath(".githooks/pre-commit")).toBe(true);
    expect(isCanonicalStagedPath(".githooks\\pre-commit")).toBe(false);
    expect(isCanonicalStagedPath(" AGENTS.md")).toBe(false);
    expect(isCanonicalStagedPath("AGENTS.md ")).toBe(false);
    expect(isCanonicalStagedPath("./AGENTS.md")).toBe(false);
    expect(isCanonicalStagedPath("AGENTS.md\r")).toBe(false);
    expect(isCanonicalStagedPath("")).toBe(false);
  });

  it("reads Directive path classes from the ownership API", () => {
    expect(isDirectivePathClass("AGENTS.md")).toBe(true);
    expect(isDirectivePathClass("package.json")).toBe(true);
    expect(isDirectivePathClass(".githooks/pre-commit")).toBe(true);
    expect(isDirectivePathClass("src/a.ts")).toBe(false);
    expect(isDirectivePathClass(".deft/settings.json")).toBe(false);
  });
});

describe("readHeadTreeEntries (#5771)", () => {
  it("reports a verified unborn branch, not absence by error", () => {
    const root = repo();
    expect(readHeadTreeEntries(root, ["AGENTS.md"])).toEqual({ kind: "unborn" });
  });

  it("is an error outside a repository", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-directive-only-drop-norepo-"));
    temps.push(root);
    expect(readHeadTreeEntries(root, ["AGENTS.md"]).kind).toBe("error");
  });

  it("looks up exact paths: present, absent, and a directory beside a deeper path", () => {
    const root = repo();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "c"), "x\n");
    writeFileSync(join(root, "top"), "y\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    const lookup = readHeadTreeEntries(root, ["top", "missing", "a", "a/b/c", "a/*"]);
    expect(lookup.kind).toBe("entries");
    if (lookup.kind !== "entries") return;
    expect(lookup.entries.get("top")?.mode).toBe("100644");
    expect(lookup.entries.get("a/b/c")?.mode).toBe("100644");
    // ls-tree omits a directory it descends into; the single lookup finds it.
    expect(lookup.entries.get("a")?.mode).toBe("040000");
    expect(lookup.entries.has("missing")).toBe(false);
    // Literal pathspecs: a glob character is a name, not a pattern.
    expect(lookup.entries.has("a/*")).toBe(false);
  });

  it("parses ls-tree records and refuses a malformed one", () => {
    expect(parseLsTreeZ("100644 blob abc\tx y\0")?.get("x y")).toEqual({
      mode: "100644",
      type: "blob",
      oid: "abc",
    });
    expect(parseLsTreeZ("garbage\0")).toBeNull();
  });
});

describe("formatDirectiveOnlyRefusalNote (#5771)", () => {
  it("is empty when no Directive path is staged", () => {
    expect(formatDirectiveOnlyRefusalNote(null)).toBe("");
    expect(
      formatDirectiveOnlyRefusalNote({
        dropped: [],
        keptEntries: [],
        kept: [{ path: "src/a.ts", reason: "not-owned", directivePath: false }],
      }),
    ).toBe("");
  });

  it("names kept reasons and gives the recovery only when a path was dropped", () => {
    const kept = [{ path: "AGENTS.md", reason: "mixed" as const, directivePath: true }];
    const noDrop = formatDirectiveOnlyRefusalNote({ dropped: [], keptEntries: [], kept });
    expect(noDrop).toContain("AGENTS.md (mixed)");
    expect(noDrop).not.toMatch(/Recovery:/);
    const withDrop = formatDirectiveOnlyRefusalNote({
      dropped: ["package.json"],
      keptEntries: [],
      kept,
    });
    expect(withDrop).toContain("package.json");
    expect(withDrop).toMatch(/Recovery: commit the Directive-only paths on their own/);
    expect(withDrop).not.toMatch(/scope:promote|scope:activate/);
  });
});
