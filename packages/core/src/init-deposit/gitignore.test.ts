import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTree } from "../deposit/copy-tree.js";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import {
  CANONICAL_GITIGNORE_BASELINE,
  ensureInitGitignoreLines,
  ensureUntrackCoreGitignoreLines,
  GITIGNORE_DEFT_CORE_LINE,
  isDepositTrackedInGit,
  reconstituteDepositFromContent,
  resolveInitGitignoreLines,
  UNTRACK_CORE_GITIGNORE_LINES,
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

  it("ignores triage-cache files on both vbrief/ and xbrief/ layouts (#2348)", () => {
    // The engine writes operator-private triage-cache files under the active
    // layout's `.triage-cache/`. Before #2348 only the `xbrief/` set was in the
    // baseline, so on an `xbrief/` project those paths were trackable.
    for (const leaf of [
      "candidates.jsonl",
      "summary-history.jsonl",
      "scope-lifecycle.jsonl",
      "decompositions/",
      "doctor-state.json",
    ]) {
      expect(CANONICAL_GITIGNORE_BASELINE).toContain(`xbrief/.triage-cache/${leaf}`);
      expect(CANONICAL_GITIGNORE_BASELINE).toContain(`xbrief/.triage-cache/${leaf}`);
    }
  });

  it("covers xBRIEF-era eval result paths on both layouts (#2206)", () => {
    // Generated version-eval results (health history, golden runs) live under
    // .eval/results/ for both vbrief/ and xbrief/ layouts. Before #2206 only the
    // triage-cache paths were covered; the eval/results/ subdirectory was missing.
    expect(CANONICAL_GITIGNORE_BASELINE).toContain("xbrief/.eval/results/");
    expect(CANONICAL_GITIGNORE_BASELINE).toContain("vbrief/.eval/results/");
  });

  it("covers xbrief migration backup directories (#2206)", () => {
    // `deft migrate:xbrief` creates .deft/xbrief-migrate-backup-<stamp>/ directories
    // that the old .deft/*.bak-* pattern did not cover.
    expect(CANONICAL_GITIGNORE_BASELINE).toContain(".deft/xbrief-migrate-backup-*/");
  });

  it("update/brownfield: ensureInitGitignoreLines adds xBRIEF-era entries (#2206)", () => {
    const root = freshRoot("gitignore-brownfield-");
    // Simulate a brownfield project that has a .gitignore without Deft entries.
    writeFileSync(join(root, ".gitignore"), "node_modules/\nbuild/\n", "utf8");

    const result = ensureInitGitignoreLines(root, { printf: () => {} });

    expect(result.changed).toBe(true);
    const text = readFileSync(join(root, ".gitignore"), "utf8");
    expect(text).toContain("xbrief/.eval/results/");
    expect(text).toContain("vbrief/.eval/results/");
    expect(text).toContain(".deft/xbrief-migrate-backup-*/");
    expect(text).toContain("node_modules/");
  });

  it("born-ignores the local engine cache dir (.deft/.cli/) (#2264)", () => {
    const root = freshRoot("gitignore-cli-");
    ensureInitGitignoreLines(root, { printf: () => {} });
    expect(CANONICAL_GITIGNORE_BASELINE).toContain(".deft/.cli/");
    expect(CANONICAL_GITIGNORE_BASELINE).toContain(".deft-directive-disable");
    expect(readGitignore(root)).toContain(".deft/.cli/");
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

  it("heals a forbidden blanket vbrief/.triage-cache/ line while adding canonical entries", () => {
    const root = freshRoot("gitignore-heal-");
    writeFileSync(join(root, ".gitignore"), "node_modules/\nvbrief/.triage-cache/\n", "utf8");

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

describe("ensureUntrackCoreGitignoreLines (#2269)", () => {
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

  it("forces the .deft/core/ entry plus the canonical baseline", () => {
    const root = freshRoot("untrack-gi-");
    const result = ensureUntrackCoreGitignoreLines(root, { printf: () => {} });

    expect(result.changed).toBe(true);
    expect(result.deftCoreIgnored).toBe(true);
    const text = readGitignore(root);
    expect(text).toContain(GITIGNORE_DEFT_CORE_LINE);
    expect(text).toContain(".deft/.cli/");
    expect(text).toContain(".deft/ritual-state.json");
    expect(text).toContain(".deft-cache/");
  });

  it("adds .deft/core/ even when a prior init left it untracked-omitted", () => {
    const root = freshRoot("untrack-gi-add-");
    // A tracked-deposit init writes the baseline WITHOUT .deft/core/.
    writeFileSync(join(root, ".gitignore"), `${CANONICAL_GITIGNORE_BASELINE.join("\n")}\n`, "utf8");

    const result = ensureUntrackCoreGitignoreLines(root, { printf: () => {} });

    expect(result.changed).toBe(true);
    expect(readGitignore(root)).toContain(GITIGNORE_DEFT_CORE_LINE);
  });

  it("never adds package.json to the ignore set", () => {
    const root = freshRoot("untrack-gi-pkg-");
    ensureUntrackCoreGitignoreLines(root, { printf: () => {} });

    expect(UNTRACK_CORE_GITIGNORE_LINES).not.toContain("package.json");
    expect(CANONICAL_GITIGNORE_BASELINE).not.toContain("package.json");
    expect(readGitignore(root)).not.toMatch(/^package\.json\s*$/m);
  });

  it("is idempotent on a second reconcile", () => {
    const root = freshRoot("untrack-gi-idem-");
    ensureUntrackCoreGitignoreLines(root, { printf: () => {} });
    const first = readGitignore(root);

    const second = ensureUntrackCoreGitignoreLines(root, { printf: () => {} });

    expect(second.changed).toBe(false);
    expect(readGitignore(root)).toBe(first);
    expect(first.split(GITIGNORE_DEFT_CORE_LINE).length - 1).toBe(1);
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

const itSymlink = it.skipIf(process.platform === "win32");

describe("init-deposit gitignore projection containment (#2839)", () => {
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

  function freshEscape(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  }

  itSymlink(
    "ensureInitGitignoreLines refuses when .gitignore is a symlink outside the project",
    () => {
      const root = freshRoot("gitignore-symlink-");
      const escapeDir = freshEscape("gitignore-escape-");
      const escapeFile = join(escapeDir, "stolen.gitignore");
      writeFileSync(escapeFile, "victim\n", "utf8");
      symlinkSync(escapeFile, join(root, ".gitignore"));

      expect(() => ensureInitGitignoreLines(root, { printf: () => {} })).toThrow(
        ProjectionContainmentError,
      );
      expect(readFileSync(escapeFile, "utf8")).toBe("victim\n");
    },
  );

  itSymlink(
    "ensureUntrackCoreGitignoreLines refuses when .gitignore is a symlink outside the project",
    () => {
      const root = freshRoot("gitignore-untrack-symlink-");
      const escapeDir = freshEscape("gitignore-untrack-escape-");
      const escapeFile = join(escapeDir, "stolen.gitignore");
      writeFileSync(escapeFile, "victim\n", "utf8");
      symlinkSync(escapeFile, join(root, ".gitignore"));

      expect(() => ensureUntrackCoreGitignoreLines(root, { printf: () => {} })).toThrow(
        ProjectionContainmentError,
      );
      expect(readFileSync(escapeFile, "utf8")).toBe("victim\n");
    },
  );

  itSymlink("ensureInitGitignoreLines refuses an IN-TREE .gitignore dest symlink (#2912)", () => {
    const root = freshRoot("gitignore-intree-symlink-");
    const victim = join(root, "real-notes.txt");
    writeFileSync(victim, "KEEP\n", "utf8");
    symlinkSync(victim, join(root, ".gitignore"));

    expect(() => ensureInitGitignoreLines(root, { printf: () => {} })).toThrow(
      ProjectionContainmentError,
    );
    // The in-tree victim the symlink pointed at is never diverted-onto.
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
  });
});
