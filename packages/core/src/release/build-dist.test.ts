import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertArchiveEntriesTrackedOrGenerated,
  buildArchive,
  containedAbsPath,
  DEFAULT_EXCLUDES,
  DEFAULT_GENERATED_ALLOWLIST,
  emitBuildProgress,
  iterSourceFiles,
  listGitTrackedFiles,
  main,
  outputPath,
  parseExtraExcludes,
  resolveArchiveEntries,
  selectFormat,
  UntrackedArchiveEntryError,
} from "./build-dist.js";

function gitCommitAll(root: string, message = "init"): void {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", message], {
    cwd: root,
    stdio: "ignore",
  });
}

function payloadFingerprint(entries: Array<{ absPath: string; archiveRel: string }>): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.archiveRel);
    hash.update("\0");
    hash.update(readFileSync(entry.absPath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function zipMemberNames(zipPath: string): string[] {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip EOCD not found");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip central header corrupt");
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8"));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names.sort();
}

describe("build-dist helpers", () => {
  it("selectFormat honors explicit arg and defaults", () => {
    expect(selectFormat("zip")).toBe("zip");
    expect(selectFormat("ZIP")).toBe("zip");
    expect(selectFormat("tar")).toBe("tar");
    expect(selectFormat("bogus")).toBe("tar");
    expect(selectFormat(null)).toMatch(/^(tar|zip)$/);
  });

  it("outputPath uses version and format suffix", () => {
    expect(outputPath("/root", "1.2.3", "zip")).toBe(join("/root", "dist", "deft-1.2.3.zip"));
    expect(outputPath("/root", "1.2.3", "tar")).toBe(join("/root", "dist", "deft-1.2.3.tar.gz"));
  });

  it("parseExtraExcludes splits and trims", () => {
    expect(parseExtraExcludes(" a , b ,, c ")).toEqual(["a", "b", "c"]);
    expect(parseExtraExcludes("")).toEqual([]);
  });

  it("iterSourceFiles walks tree, flattens content, and applies excludes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-"));
    mkdirSync(join(root, "content", "skills"), { recursive: true });
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    mkdirSync(join(root, "history", "archive"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# hi\n");
    writeFileSync(join(root, "content", "skills", "demo.md"), "skill\n");
    writeFileSync(join(root, "packages", "core", "foo.test.ts"), "test\n");
    writeFileSync(join(root, "packages", "core", "bar.ts"), "code\n");
    writeFileSync(join(root, "history", "archive", "old.md"), "old\n");
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x\n");
    writeFileSync(join(root, "tests", "root.test.ts"), "outside packages\n");

    const entries = iterSourceFiles(root);
    const rels = entries.map((e) => e.archiveRel);
    expect(rels).toContain("README.md");
    expect(rels).toContain("skills/demo.md");
    expect(rels).toContain("packages/core/bar.ts");
    expect(rels).toContain("tests/root.test.ts");
    expect(rels).not.toContain("packages/core/foo.test.ts");
    expect(rels).not.toContain("history/archive/old.md");
    expect(rels).not.toContain("node_modules/pkg/index.js");
  });

  it("DEFAULT_EXCLUDES includes Vitest coverage alongside pytest .coverage", () => {
    expect(DEFAULT_EXCLUDES.has("coverage")).toBe(true);
    expect(DEFAULT_EXCLUDES.has(".coverage")).toBe(true);
  });

  it("DEFAULT_EXCLUDES includes .deft-scratch worktree roots (#2953)", () => {
    expect(DEFAULT_EXCLUDES.has(".deft-scratch")).toBe(true);
    expect(DEFAULT_EXCLUDES.has("swarm-worktrees")).toBe(true);
  });

  it("iterSourceFiles skips .deft-scratch worktrees (#2953)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-scratch-"));
    mkdirSync(join(root, ".deft-scratch", "worktrees", "story"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# hi\n");
    writeFileSync(join(root, ".deft-scratch", "worktrees", "story", "noise.md"), "x\n");

    const rels = iterSourceFiles(root).map((e) => e.archiveRel);
    expect(rels).toContain("README.md");
    expect(rels.some((r) => r.includes(".deft-scratch"))).toBe(false);
  });

  it("iterSourceFiles excludes coverage/.tmp Vitest artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-coverage-"));
    mkdirSync(join(root, "coverage", ".tmp"), { recursive: true });
    writeFileSync(join(root, "coverage", ".tmp", "coverage-1.json"), "{}\n");
    writeFileSync(join(root, "README.md"), "# hi\n");

    const entries = iterSourceFiles(root);
    const rels = entries.map((e) => e.archiveRel);
    expect(rels).toContain("README.md");
    expect(rels).not.toContain("coverage/.tmp/coverage-1.json");
  });

  it("buildArchive succeeds when coverage/.tmp is present", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-coverage-archive-"));
    mkdirSync(join(root, "content"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# fixture\n");
    writeFileSync(join(root, "content", "doc.md"), "hello\n");
    gitCommitAll(root);
    mkdirSync(join(root, "coverage", ".tmp"), { recursive: true });
    writeFileSync(join(root, "coverage", ".tmp", "coverage-2.json"), "{}\n");

    const out = await buildArchive(root, "9.9.9", "zip");
    expect(statSync(out).size).toBeGreaterThan(0);
  });

  it("emitBuildProgress formats stage ticks (#2953)", () => {
    const chunks: string[] = [];
    const stream = {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    };
    emitBuildProgress(
      { stage: "pack", current: 5, total: 20, detail: "zip" },
      stream as { write: (s: string) => boolean },
    );
    expect(chunks.join("")).toContain("build-dist: pack 5/20 (25%)");
    expect(chunks.join("")).toContain("zip");
  });

  it("buildArchive reports progress stages (#2953)", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-progress-"));
    mkdirSync(join(root, "content"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# fixture\n");
    writeFileSync(join(root, "content", "doc.md"), "hello\n");
    gitCommitAll(root);
    const stages: string[] = [];
    await buildArchive(root, "1.0.0", "zip", {
      onProgress: (p) => {
        stages.push(p.stage);
      },
    });
    expect(stages).toContain("scan");
    expect(stages).toContain("pack");
    expect(stages).toContain("finalize");
    expect(stages).toContain("done");
  });

  it("iterSourceFiles honors extra excludes and empty prefix list", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-extra-"));
    mkdirSync(join(root, "backup"), { recursive: true });
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeFileSync(join(root, "backup", "x.txt"), "x\n");
    writeFileSync(join(root, "xbrief", "completed", "done.xbrief.json"), "{}\n");

    const withBackup = iterSourceFiles(root, new Set([...DEFAULT_EXCLUDES, "backup"]));
    expect(withBackup.map((e) => e.archiveRel)).not.toContain("backup/x.txt");

    const withCompleted = iterSourceFiles(root, DEFAULT_EXCLUDES, []);
    expect(withCompleted.map((e) => e.archiveRel)).toContain("xbrief/completed/done.xbrief.json");
  });

  it("main validates argv and reports help", async () => {
    expect(await main([])).toBe(2);
    expect(await main(["--help"])).toBe(2);
    expect(await main(["--version", "1.0.0", "--root", "/nonexistent-root-xyz"])).toBe(2);
  });

  // Regression guard for the archiver v8 class-API migration: archiver v8 dropped the
  // v7 `archiver(format, opts)` factory, which silently broke the release build until a
  // production cut hit `TypeError: archiver is not a function`. These tests actually
  // produce an archive so the calling convention can never regress uncaught again.
  function fixtureProject(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-archive-"));
    mkdirSync(join(root, "content"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# fixture\n");
    writeFileSync(join(root, "content", "doc.md"), "hello\n");
    gitCommitAll(root);
    return root;
  }

  it("buildArchive produces a non-empty tar.gz", async () => {
    const root = fixtureProject();
    const out = await buildArchive(root, "9.9.9", "tar");
    expect(out).toBe(outputPath(root, "9.9.9", "tar"));
    expect(statSync(out).size).toBeGreaterThan(0);
  });

  it("buildArchive produces a non-empty zip and overwrites an existing artifact", async () => {
    const root = fixtureProject();
    const first = await buildArchive(root, "9.9.9", "zip");
    expect(statSync(first).size).toBeGreaterThan(0);
    // Second run exercises the existing-output unlink branch.
    const second = await buildArchive(root, "9.9.9", "zip");
    expect(second).toBe(first);
    expect(statSync(second).size).toBeGreaterThan(0);
  });

  it("main builds an archive end-to-end and returns 0", async () => {
    const root = fixtureProject();
    expect(await main(["--version", "9.9.9", "--format", "zip", "--root", root])).toBe(0);
    expect(statSync(outputPath(root, "9.9.9", "zip")).size).toBeGreaterThan(0);
  });

  it("DEFAULT_GENERATED_ALLOWLIST is empty so generated outputs must be named", () => {
    expect(DEFAULT_GENERATED_ALLOWLIST).toEqual([]);
  });

  it("listGitTrackedFiles fails closed outside a git work tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-nogit-"));
    writeFileSync(join(root, "README.md"), "# hi\n");
    expect(() => listGitTrackedFiles(root)).toThrow(/git ls-files failed/);
  });

  it("listGitTrackedFiles fails closed when --root is not the repository root", () => {
    const root = fixtureProject();
    expect(() => listGitTrackedFiles(join(root, "content"))).toThrow(/git ls-files failed/);
  });

  it("resolveArchiveEntries packs tracked files and ignores untracked host trees (#3490)", () => {
    const root = fixtureProject();
    mkdirSync(join(root, ".claude", "worktrees", "agent"), { recursive: true });
    mkdirSync(join(root, ".deft-scratch", "worktrees", "story"), { recursive: true });
    mkdirSync(join(root, ".new-agent-host"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.local.json"), "{}\n");
    writeFileSync(join(root, ".claude", "worktrees", "agent", "noise.md"), "x\n");
    writeFileSync(join(root, ".deft-scratch", "worktrees", "story", "scratch.md"), "x\n");
    writeFileSync(join(root, ".new-agent-host", "state.json"), "{}\n");
    writeFileSync(join(root, "untracked-root.txt"), "surprise\n");

    const rels = resolveArchiveEntries(root).map((e) => e.archiveRel);
    expect(rels).toContain("README.md");
    expect(rels).toContain("doc.md");
    expect(rels.some((r) => r.includes(".claude"))).toBe(false);
    expect(rels.some((r) => r.includes(".deft-scratch"))).toBe(false);
    expect(rels.some((r) => r.includes(".new-agent-host"))).toBe(false);
    expect(rels).not.toContain("untracked-root.txt");
  });

  it("archive contents match with and without extra untracked directories (#3490)", async () => {
    const root = fixtureProject();
    const cleanEntries = resolveArchiveEntries(root);
    const cleanZip = await buildArchive(root, "1.0.0", "zip");
    const cleanNames = zipMemberNames(cleanZip);
    const cleanFp = payloadFingerprint(cleanEntries);

    mkdirSync(join(root, ".claude", "worktrees", "agent"), { recursive: true });
    mkdirSync(join(root, ".deft-scratch", "worktrees", "story"), { recursive: true });
    mkdirSync(join(root, ".new-agent-host"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.local.json"), "secret\n");
    writeFileSync(join(root, ".claude", "worktrees", "agent", "nested.ts"), "x\n");
    writeFileSync(join(root, ".deft-scratch", "worktrees", "story", "scratch.md"), "x\n");
    writeFileSync(join(root, ".new-agent-host", "state.json"), "{}\n");

    const dirtyEntries = resolveArchiveEntries(root);
    const dirtyZip = await buildArchive(root, "1.0.0", "zip");
    expect(dirtyEntries.map((e) => e.archiveRel)).toEqual(cleanEntries.map((e) => e.archiveRel));
    expect(payloadFingerprint(dirtyEntries)).toBe(cleanFp);
    expect(zipMemberNames(dirtyZip)).toEqual(cleanNames);
  });

  it("assertArchiveEntriesTrackedOrGenerated fails closed on surprise untracked files", () => {
    const root = fixtureProject();
    writeFileSync(join(root, "secret.txt"), "nope\n");
    expect(() => assertArchiveEntriesTrackedOrGenerated(root, ["README.md", "secret.txt"])).toThrow(
      UntrackedArchiveEntryError,
    );
    expect(() => assertArchiveEntriesTrackedOrGenerated(root, ["README.md", "secret.txt"])).toThrow(
      /secret\.txt/,
    );
  });

  it("generated allowlist files may be packed even when untracked", async () => {
    const root = fixtureProject();
    writeFileSync(join(root, "generated.out"), "built\n");
    const rels = resolveArchiveEntries(root, { generatedAllowlist: ["generated.out"] }).map(
      (e) => e.archiveRel,
    );
    expect(rels).toContain("generated.out");
    const out = await buildArchive(root, "1.0.0", "zip", {
      generatedAllowlist: ["generated.out"],
    });
    expect(zipMemberNames(out)).toContain("deft/generated.out");
  });

  it("defence in depth still skips tracked paths under excluded basenames", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-excluded-tracked-"));
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, "content"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# hi\n");
    writeFileSync(join(root, "content", "doc.md"), "hello\n");
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x\n");
    gitCommitAll(root);
    const rels = resolveArchiveEntries(root).map((e) => e.archiveRel);
    expect(rels).toContain("README.md");
    expect(rels).not.toContain("node_modules/pkg/index.js");
  });

  it("main returns 1 when git ls-files cannot run", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-main-nogit-"));
    writeFileSync(join(root, "README.md"), "# hi\n");
    expect(await main(["--version", "1.0.0", "--format", "zip", "--root", root])).toBe(1);
  });

  it("containedAbsPath rejects parent traversal", () => {
    const root = fixtureProject();
    expect(containedAbsPath(root, "README.md")).toBe(join(root, "README.md"));
    expect(containedAbsPath(root, "../secret.txt")).toBeNull();
    expect(containedAbsPath(root, "content/../../secret.txt")).toBeNull();
  });

  it("generated allowlist paths that escape the root fail closed", () => {
    const root = fixtureProject();
    expect(() => resolveArchiveEntries(root, { generatedAllowlist: ["../outside.txt"] })).toThrow(
      /escapes the archive root/,
    );
  });

  it("listGitTrackedFiles preserves internal spaces in filenames", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-space-"));
    mkdirSync(join(root, "content"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# hi\n");
    writeFileSync(join(root, "content", "doc.md"), "hello\n");
    writeFileSync(join(root, "has space.txt"), "x\n");
    gitCommitAll(root);
    expect(listGitTrackedFiles(root)).toContain("has space.txt");
  });

  it("containedAbsPath treats only POSIX slashes as separators", () => {
    const root = fixtureProject();
    expect(containedAbsPath(root, "content/doc.md")).toBe(join(root, "content", "doc.md"));
    expect(containedAbsPath(root, "content/../README.md")).toBeNull();
    // Git index paths are `/`-separated (gitglossary "path"). A literal `\` is
    // a filename byte. Splitting on `\` would pack a POSIX file named `foo\bar`
    // as nested segments and could escape the root. On win32, Node resolve
    // still fail-closes OS-separator `..\` via isInsideRoot.
    const winEscape = "content\\..\\..\\secret.txt";
    if (process.platform === "win32") {
      expect(containedAbsPath(root, winEscape)).toBeNull();
    } else {
      expect(containedAbsPath(root, winEscape)).toBe(join(root, winEscape));
    }
  });

  it("generated allowlist symlink to a file outside the root fails closed", () => {
    const root = fixtureProject();
    const outside = join(mkdtempSync(join(tmpdir(), "deft-build-dist-out-")), "secret.txt");
    writeFileSync(outside, "secret\n");
    const link = join(root, "generated.out");
    try {
      symlinkSync(outside, link);
    } catch {
      return;
    }
    expect(() => resolveArchiveEntries(root, { generatedAllowlist: ["generated.out"] })).toThrow(
      /resolves outside the archive root/,
    );
  });

  it("generated allowlist file under a symlinked ancestor directory fails closed", () => {
    const root = fixtureProject();
    const outsideDir = mkdtempSync(join(tmpdir(), "deft-build-dist-outdir-"));
    writeFileSync(join(outsideDir, "secret.txt"), "secret\n");
    const linkDir = join(root, "linkdir");
    try {
      symlinkSync(outsideDir, linkDir, "dir");
    } catch {
      try {
        symlinkSync(outsideDir, linkDir);
      } catch {
        return;
      }
    }
    expect(() =>
      resolveArchiveEntries(root, { generatedAllowlist: ["linkdir/secret.txt"] }),
    ).toThrow(/resolves outside the archive root/);
  });

  function trySymlinkDir(target: string, link: string): boolean {
    try {
      symlinkSync(target, link, "dir");
      return true;
    } catch {
      try {
        symlinkSync(target, link, "junction");
        return true;
      } catch {
        try {
          symlinkSync(target, link);
          return true;
        } catch {
          return false;
        }
      }
    }
  }

  it("archive via a symlink root matches the real checkout (#3490)", async () => {
    const realRoot = fixtureProject();
    const holder = mkdtempSync(join(tmpdir(), "deft-build-dist-linkroot-"));
    const linkRoot = join(holder, "link-root");
    if (!trySymlinkDir(realRoot, linkRoot)) return;

    const viaReal = resolveArchiveEntries(realRoot);
    const viaLink = resolveArchiveEntries(linkRoot);
    expect(viaLink.map((e) => e.archiveRel)).toEqual(viaReal.map((e) => e.archiveRel));
    expect(payloadFingerprint(viaLink)).toBe(payloadFingerprint(viaReal));

    const zipReal = await buildArchive(realRoot, "1.0.0", "zip");
    const zipLink = await buildArchive(linkRoot, "1.0.1", "zip");
    expect(zipMemberNames(zipLink)).toEqual(zipMemberNames(zipReal));
  });
});
