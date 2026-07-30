import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildArchive,
  DEFAULT_EXCLUDES,
  emitBuildProgress,
  iterSourceFiles,
  main,
  outputPath,
  parseExtraExcludes,
  selectFormat,
} from "./build-dist.js";

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
    mkdirSync(join(root, "coverage", ".tmp"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# fixture\n");
    writeFileSync(join(root, "content", "doc.md"), "hello\n");
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
});
