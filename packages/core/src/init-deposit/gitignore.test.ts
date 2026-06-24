import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTree } from "../deposit/copy-tree.js";
import {
  CANONICAL_GITIGNORE_BASELINE,
  ensureInitGitignoreLines,
  GITIGNORE_DEFT_CORE_LINE,
  isDepositTrackedInGit,
  reconstituteDepositFromContent,
  resolveInitGitignoreLines,
} from "./gitignore.js";

describe("ensureInitGitignoreLines", () => {
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

  function readGitignore(root: string): string {
    return readFileSync(join(root, ".gitignore"), "utf8");
  }

  it("writes the born-ignored .deft/core entry on greenfield init", () => {
    const root = freshRoot("gitignore-greenfield-");
    const lines: string[] = [];

    const result = ensureInitGitignoreLines(root, { printf: (text) => lines.push(text) });

    expect(result.changed).toBe(true);
    expect(result.deftCoreIgnored).toBe(true);
    expect(result.skippedDeftCoreBecauseTracked).toBe(false);
    const text = readGitignore(root);
    expect(text).toContain(GITIGNORE_DEFT_CORE_LINE);
    for (const line of CANONICAL_GITIGNORE_BASELINE) {
      expect(text).toContain(line);
    }
    expect(lines.join("")).toContain(".gitignore updated");
  });

  it("is idempotent on a second init run", () => {
    const root = freshRoot("gitignore-idempotent-");
    const io = { printf: () => {} };

    ensureInitGitignoreLines(root, io);
    const first = readGitignore(root);
    const second = ensureInitGitignoreLines(root, io);

    expect(second.changed).toBe(false);
    expect(readGitignore(root)).toBe(first);
    expect(first.split(GITIGNORE_DEFT_CORE_LINE).length - 1).toBe(1);
  });

  it("heals a forbidden blanket vbrief/.eval/ line while adding canonical entries", () => {
    const root = freshRoot("gitignore-heal-");
    writeFileSync(join(root, ".gitignore"), "node_modules/\nvbrief/.eval/\n", "utf8");

    ensureInitGitignoreLines(root, { printf: () => {} });

    const text = readGitignore(root);
    expect(text).toContain("node_modules/");
    expect(text).not.toMatch(/^vbrief\/\.eval\/\s*$/m);
    expect(text).toContain(GITIGNORE_DEFT_CORE_LINE);
  });

  it("does not add .deft/core to gitignore when the deposit is already tracked", () => {
    const root = freshRoot("gitignore-tracked-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft/core", "main.md"), "# tracked deposit\n", "utf8");
    execFileSync("git", ["add", ".deft/core"], { cwd: root, stdio: "ignore" });

    expect(isDepositTrackedInGit(root)).toBe(true);

    const result = ensureInitGitignoreLines(root, { printf: () => {} });
    const text = readGitignore(root);

    expect(result.skippedDeftCoreBecauseTracked).toBe(true);
    expect(result.deftCoreIgnored).toBe(false);
    expect(text).not.toContain(GITIGNORE_DEFT_CORE_LINE);
    expect(text).not.toContain(".deft/core\n");
    expect(text).toContain(".deft-cache/");
  });

  it("resolveInitGitignoreLines omits .deft/core when tracked", () => {
    const root = freshRoot("gitignore-resolve-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".deft/core"), { recursive: true });
    writeFileSync(join(root, ".deft/core", "VERSION"), "v1\n", "utf8");
    execFileSync("git", ["add", ".deft/core/VERSION"], { cwd: root, stdio: "ignore" });

    const resolved = resolveInitGitignoreLines(root);
    expect(resolved.includeDeftCore).toBe(false);
    expect(resolved.lines).not.toContain(GITIGNORE_DEFT_CORE_LINE);
  });
});

describe("reconstituteDepositFromContent", () => {
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

  it("reconstitutes the deposit when .deft/core is absent", async () => {
    const project = freshRoot("reconstitute-absent-");
    const contentRoot = join(project, "content-pkg");
    mkdirSync(join(contentRoot, ".githooks"), { recursive: true });
    writeFileSync(join(contentRoot, "main.md"), "# Deft content\n", "utf8");
    writeFileSync(join(contentRoot, ".githooks", "pre-commit"), "#!/bin/sh\n", "utf8");
    chmodSync(join(contentRoot, ".githooks", "pre-commit"), 0o755);

    const deftDir = join(project, ".deft/core");
    expect(existsSync(deftDir)).toBe(false);

    const result = await reconstituteDepositFromContent(contentRoot, deftDir, copyTree);

    expect(result.reconstituted).toBe(true);
    expect(readFileSync(join(deftDir, "main.md"), "utf8")).toContain("# Deft content");
  });

  it("refreshes an existing deposit without treating it as reconstitution", async () => {
    const project = freshRoot("reconstitute-present-");
    const contentRoot = join(project, "content-pkg");
    const deftDir = join(project, ".deft/core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(join(deftDir, "main.md"), "# stale\n", "utf8");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "main.md"), "# fresh\n", "utf8");

    const result = await reconstituteDepositFromContent(contentRoot, deftDir, copyTree);

    expect(result.reconstituted).toBe(false);
    expect(readFileSync(join(deftDir, "main.md"), "utf8")).toContain("# fresh");
  });
});
