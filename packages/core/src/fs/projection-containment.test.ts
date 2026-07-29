import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Symlinks require elevated privileges on Windows (SeCreateSymbolicLink); skip there.
const itSymlink = it.skipIf(process.platform === "win32");

import { runCodebaseMapCli } from "../codebase/map.js";
import {
  stepEnsureGitignoreEntry,
  stepEnsureGitignoreEvalEntries,
} from "../triage/bootstrap/gitignore.js";
import {
  assertDestinationNotSymlink,
  assertProjectionContained,
  ProjectionContainmentError,
} from "./projection-containment.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function escapingSymlinkAtTarget(projectDir: string, relPath: string, escapeFile: string): void {
  const parent = join(projectDir, ...relPath.split("/").slice(0, -1));
  if (parent.length > projectDir.length) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(escapeFile, "", { encoding: "utf8" });
  symlinkSync(escapeFile, join(projectDir, ...relPath.split("/")));
}

describe("assertProjectionContained (#2413)", () => {
  it("passes for a greenfield project with no projection symlinks", () => {
    const projectDir = freshDir("proj-contain-clean-");
    expect(() =>
      assertProjectionContained(projectDir, join(projectDir, ".gitignore")),
    ).not.toThrow();
  });

  itSymlink("throws when the projection target is a symlink escaping the tree", () => {
    const projectDir = freshDir("proj-contain-target-");
    const escapeTarget = freshDir("proj-contain-escape-");
    escapingSymlinkAtTarget(projectDir, ".gitignore", join(escapeTarget, "evil.gitignore"));
    expect(() => assertProjectionContained(projectDir, join(projectDir, ".gitignore"))).toThrow(
      ProjectionContainmentError,
    );
  });

  itSymlink("throws when a parent directory is a symlink escaping the tree", () => {
    const projectDir = freshDir("proj-contain-parent-");
    const escapeTarget = freshDir("proj-contain-escape-");
    symlinkSync(escapeTarget, join(projectDir, ".planning"), "dir");
    expect(() =>
      assertProjectionContained(projectDir, join(projectDir, ".planning", "codebase", "MAP.md")),
    ).toThrow(/symlink escaping the project tree/);
  });

  itSymlink("throws when a nested symlink chain on the projection path escapes the tree", () => {
    const projectDir = freshDir("proj-contain-nested-");
    const escapeTarget = freshDir("proj-contain-nested-escape-");
    const escapeFile = join(escapeTarget, "stolen.md");
    const hopDir = join(projectDir, "hop");
    mkdirSync(join(hopDir, "codebase"), { recursive: true });
    writeFileSync(escapeFile, "victim\n", { encoding: "utf8" });
    symlinkSync(hopDir, join(projectDir, ".planning"), "dir");
    symlinkSync(escapeFile, join(hopDir, "codebase", "MAP.md"));

    expect(() =>
      assertProjectionContained(projectDir, join(projectDir, ".planning", "codebase", "MAP.md")),
    ).toThrow(/symlink escaping the project tree/);
  });

  itSymlink("throws when the projection target is a broken symlink", () => {
    const projectDir = freshDir("proj-contain-dangling-");
    symlinkSync(join(projectDir, "missing-target"), join(projectDir, ".gitattributes"));
    expect(() => assertProjectionContained(projectDir, join(projectDir, ".gitattributes"))).toThrow(
      /broken\/dangling symlink/,
    );
  });

  itSymlink("allows an in-tree symlink on the projection path", () => {
    const projectDir = freshDir("proj-contain-intree-");
    const inTree = join(projectDir, "actual-map.md");
    mkdirSync(join(projectDir, ".planning", "codebase"), { recursive: true });
    writeFileSync(inTree, "# map\n", { encoding: "utf8" });
    symlinkSync(inTree, join(projectDir, ".planning", "codebase", "MAP.md"));
    expect(() =>
      assertProjectionContained(projectDir, join(projectDir, ".planning", "codebase", "MAP.md")),
    ).not.toThrow();
  });
});

describe("assertDestinationNotSymlink (#2912)", () => {
  it("passes for a greenfield project with no destination symlinks", () => {
    const projectDir = freshDir("dest-nosym-clean-");
    expect(() =>
      assertDestinationNotSymlink(projectDir, join(projectDir, "AGENTS.md")),
    ).not.toThrow();
  });

  it("passes when the destination is a real nested file", () => {
    const projectDir = freshDir("dest-nosym-real-");
    mkdirSync(join(projectDir, ".github", "codeql"), { recursive: true });
    expect(() =>
      assertDestinationNotSymlink(
        projectDir,
        join(projectDir, ".github", "codeql", "codeql-config.yml"),
      ),
    ).not.toThrow();
  });

  itSymlink(
    "refuses an IN-TREE destination leaf symlink (assertProjectionContained allows it)",
    () => {
      const projectDir = freshDir("dest-nosym-intree-leaf-");
      const victim = join(projectDir, "real-agents.md");
      writeFileSync(victim, "KEEP\n", "utf8");
      symlinkSync(victim, join(projectDir, "AGENTS.md"));

      // Baseline: the legacy escape-only guard follows the in-tree symlink.
      expect(() =>
        assertProjectionContained(projectDir, join(projectDir, "AGENTS.md")),
      ).not.toThrow();
      // The #2912 guard fails closed.
      expect(() => assertDestinationNotSymlink(projectDir, join(projectDir, "AGENTS.md"))).toThrow(
        /in-tree destination symlinks are refused/,
      );
    },
  );

  itSymlink("refuses an IN-TREE parent-directory symlink on the destination path", () => {
    const projectDir = freshDir("dest-nosym-intree-parent-");
    const realDir = join(projectDir, ".deft", "core");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(projectDir, ".github"), "dir");

    expect(() =>
      assertProjectionContained(
        projectDir,
        join(projectDir, ".github", "codeql", "codeql-config.yml"),
      ),
    ).not.toThrow();
    expect(() =>
      assertDestinationNotSymlink(
        projectDir,
        join(projectDir, ".github", "codeql", "codeql-config.yml"),
      ),
    ).toThrow(/symlink on the destination path/);
  });

  itSymlink("still refuses an escaping destination symlink", () => {
    const projectDir = freshDir("dest-nosym-escape-");
    const escapeTarget = freshDir("dest-nosym-escape-out-");
    escapingSymlinkAtTarget(projectDir, ".gitattributes", join(escapeTarget, "evil.gitattributes"));
    expect(() =>
      assertDestinationNotSymlink(projectDir, join(projectDir, ".gitattributes")),
    ).toThrow(ProjectionContainmentError);
  });
});

describe("projection writers refuse symlink escapes (#2413)", () => {
  itSymlink("codebase:map fails closed when MAP.md is a symlink outside the project", () => {
    const projectDir = freshDir("proj-map-symlink-");
    const escapeTarget = freshDir("proj-map-escape-");
    const escapeFile = join(escapeTarget, "stolen-map.md");
    mkdirSync(join(projectDir, "xbrief"), { recursive: true });
    mkdirSync(join(projectDir, ".planning", "codebase"), { recursive: true });
    writeFileSync(escapeFile, "victim\n", { encoding: "utf8" });
    symlinkSync(escapeFile, join(projectDir, ".planning", "codebase", "MAP.md"));

    const result = runCodebaseMapCli(["--project-root", projectDir, "--force"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/projection write refused|symlink escaping/);
    expect(readFileSync(escapeFile, { encoding: "utf8" })).toBe("victim\n");
  });

  itSymlink(
    "triage:bootstrap fails closed when .gitignore is a symlink outside the project",
    () => {
      const projectDir = freshDir("proj-gi-symlink-");
      const escapeTarget = freshDir("proj-gi-escape-");
      const escapeFile = join(escapeTarget, "stolen.gitignore");
      writeFileSync(escapeFile, "victim\n", { encoding: "utf8" });
      symlinkSync(escapeFile, join(projectDir, ".gitignore"));

      const outcome = stepEnsureGitignoreEntry(projectDir);
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/projection write refused|symlink escaping/);
      expect(readFileSync(escapeFile, { encoding: "utf8" })).toBe("victim\n");
    },
  );

  itSymlink(
    "triage:bootstrap fails closed when .gitattributes is a symlink outside the project",
    () => {
      const projectDir = freshDir("proj-ga-symlink-");
      const escapeTarget = freshDir("proj-ga-escape-");
      const escapeFile = join(escapeTarget, "stolen.gitattributes");
      writeFileSync(escapeFile, "victim\n", { encoding: "utf8" });
      writeGitignore(projectDir);
      symlinkSync(escapeFile, join(projectDir, ".gitattributes"));

      const outcome = stepEnsureGitignoreEvalEntries(projectDir);
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/projection write refused|symlink escaping/);
      expect(readFileSync(escapeFile, { encoding: "utf8" })).toBe("victim\n");
    },
  );

  itSymlink(
    "triage:bootstrap fails closed when triage-cache README is a symlink outside the project",
    () => {
      const projectDir = freshDir("proj-readme-symlink-");
      const escapeTarget = freshDir("proj-readme-escape-");
      const escapeFile = join(escapeTarget, "stolen-readme.md");
      writeGitignore(projectDir);
      mkdirSync(join(projectDir, "xbrief", ".triage-cache"), { recursive: true });
      writeFileSync(escapeFile, "victim\n", { encoding: "utf8" });
      symlinkSync(escapeFile, join(projectDir, "xbrief", ".triage-cache", "README.md"));

      const outcome = stepEnsureGitignoreEvalEntries(projectDir);
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/projection write refused|symlink escaping/);
      expect(readFileSync(escapeFile, { encoding: "utf8" })).toBe("victim\n");
    },
  );
});

function writeGitignore(projectDir: string): void {
  writeFileSync(join(projectDir, ".gitignore"), ".deft-cache/\n", { encoding: "utf8" });
}
