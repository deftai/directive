import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXCLUDES,
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
    expect(outputPath("/root", "1.2.3", "zip")).toBe("/root/dist/deft-1.2.3.zip");
    expect(outputPath("/root", "1.2.3", "tar")).toBe("/root/dist/deft-1.2.3.tar.gz");
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

  it("iterSourceFiles honors extra excludes and empty prefix list", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-build-dist-extra-"));
    mkdirSync(join(root, "backup"), { recursive: true });
    mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
    writeFileSync(join(root, "backup", "x.txt"), "x\n");
    writeFileSync(join(root, "vbrief", "completed", "done.vbrief.json"), "{}\n");

    const withBackup = iterSourceFiles(root, new Set([...DEFAULT_EXCLUDES, "backup"]));
    expect(withBackup.map((e) => e.archiveRel)).not.toContain("backup/x.txt");

    const withCompleted = iterSourceFiles(root, DEFAULT_EXCLUDES, []);
    expect(withCompleted.map((e) => e.archiveRel)).toContain("vbrief/completed/done.vbrief.json");
  });

  it("main validates argv and reports help", async () => {
    expect(await main([])).toBe(2);
    expect(await main(["--help"])).toBe(2);
    expect(await main(["--version", "1.0.0", "--root", "/nonexistent-root-xyz"])).toBe(2);
  });
});
