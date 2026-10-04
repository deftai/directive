import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSnapshot } from "./snapshot.js";

const roots: string[] = [];
function repo() {
  const root = mkdtempSync(join(tmpdir(), "ceiling-snapshot-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(root, "README.md"), "initial\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  return { root, git };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("immutable candidate snapshot", () => {
  it("uses the index for added, changed, removed and renamed files", () => {
    const { root, git } = repo();
    mkdirSync(join(root, ".deft"));
    writeFileSync(join(root, ".deft/presentation-ceiling.json"), '{"changeClass":"presentation"}');
    git("mv", "README.md", "renamed.md");
    git("add", ".");
    writeFileSync(join(root, "renamed.md"), "unstaged bytes");
    const s = loadSnapshot({ projectRoot: root, originRef: "HEAD", staged: true });
    expect("error" in s).toBe(false);
    if ("error" in s) return;
    expect(s.changed).toEqual([".deft/presentation-ceiling.json", "README.md", "renamed.md"]);
    expect(s.head.read("renamed.md")).toBe("initial\n");
    expect(s.head.read("README.md")).toBeNull();
    expect(s.head.paths).toContain(".deft/presentation-ceiling.json");
  });
  it("fails on unmerged index entries and Git enumeration failures", () => {
    const { root, git } = repo();
    const oid = git("rev-parse", "HEAD:README.md");
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: root,
      input: `100644 ${oid} 1\tconflict.ts\n100644 ${oid} 2\tconflict.ts\n100644 ${oid} 3\tconflict.ts\n`,
    });
    expect(loadSnapshot({ projectRoot: root, originRef: "HEAD", staged: true })).toHaveProperty(
      "error",
    );
    expect(loadSnapshot({ projectRoot: join(root, "missing"), originRef: "HEAD" })).toHaveProperty(
      "error",
    );
  });
});

it("records symlink/git mode 120000 and unreadable blob authority instead of interpreting them as absent", () => {
  const { root, git } = repo();
  // Mode 120000 is a git-tree carrier only (snapshot.ts tree() never reads the worktree).
  // Forbid OS symlinkSync / win32 skip / catch-return / junction here — a junction stages as a
  // directory tree (no 120000); see packages/cli/src/windows-bin-ps1.test.ts junction fixture.
  // Stage after any git add ., or omit mkdirSync(.deft)+git add . (both dead under plumbing).
  const linkOid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: "../README.md",
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["update-index", "--index-info"], {
    cwd: root,
    input: `120000 ${linkOid} 0\t.deft/presentation-ceiling.json\n`,
  });
  const s = loadSnapshot({ projectRoot: root, originRef: "HEAD", staged: true });
  if ("error" in s) throw new Error(s.error);
  expect(s.head.read(".deft/presentation-ceiling.json")).toBeNull();
  expect(s.head.read(".deft/presentation-ceiling.json")).toBeNull();
  expect(s.head.errors).toHaveLength(1);
  const oid = git("rev-parse", "HEAD:README.md");
  rmSync(join(root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
  expect(s.base.read("README.md")).toBeNull();
  expect(s.base.errors[0]).toContain("unreadable");
  expect(loadSnapshot({ projectRoot: root, originRef: "nonexistent" })).toHaveProperty("error");
});

it("preserves spaces, tabs, newlines and Unicode in Git path names", () => {
  const { root, git } = repo();
  const paths = [
    "two words.html",
    "é.html",
    // Windows forbids control characters in filenames.
    ...(process.platform === "win32" ? [] : ["tab\tname.sql", "line\nname.txt"]),
  ];
  for (const path of paths) writeFileSync(join(root, path), `pinned ${path}`);
  git("add", ".");
  const s = loadSnapshot({ projectRoot: root, originRef: "HEAD", staged: true });
  if ("error" in s) throw new Error(s.error);
  expect([...s.changed].sort()).toEqual([...paths].sort());
  for (const path of paths) expect(s.head.read(path)).toBe(`pinned ${path}`);
  expect(s.head.errors).toEqual([]);
});
