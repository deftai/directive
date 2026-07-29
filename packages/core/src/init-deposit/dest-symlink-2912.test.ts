/**
 * Regression: AppSec #2912 (install-deposit-04) — consumer projection writers
 * must refuse IN-TREE destination symlinks (leaf or parent), not just escaping
 * ones. `assertProjectionContained` allows an in-tree symlink on the write
 * path, so a planted symlink could divert a projection write onto an
 * unintended checked-in file under operator credentials.
 *
 * Every sink below must fail closed and must NOT overwrite the file the
 * in-tree symlink points at.
 *
 * Refs #2904, #2912.
 */
import {
  chmodSync,
  copyFileSync,
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
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import { ensurePrettierIgnoreLines } from "./prettierignore.js";
import {
  depositNeutralization,
  ensureCodeqlPathsIgnore,
  ensureCoreGuardWorkflow,
  ensureGitattributes,
  ensureGreptileIgnore,
  writeAgentsMd,
  writeAgentsSkills,
  writeConsumerGitHooks,
} from "./scaffold.js";

const itSymlink = it.skipIf(process.platform === "win32");

describe("init-deposit refuses in-tree destination symlinks (#2912)", () => {
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

  const io = { printf: () => {} };

  function seedFramework(deftDir: string): void {
    mkdirSync(join(deftDir, "templates"), { recursive: true });
    copyFileSync(
      join(process.cwd(), "content/templates/agents-entry.md"),
      join(deftDir, "templates/agents-entry.md"),
    );
    copyFileSync(
      join(process.cwd(), "content/templates/agents-consumer-header.md"),
      join(deftDir, "templates/agents-consumer-header.md"),
    );
  }

  /** Plant an in-tree victim file and a `rel` symlink (in-tree) pointing at it. */
  function plantInTreeLeaf(project: string, rel: string, victimBody: string): string {
    const victim = join(project, "in-tree-victim");
    writeFileSync(victim, victimBody, "utf8");
    symlinkSync(victim, join(project, rel));
    return victim;
  }

  itSymlink("writeAgentsMd refuses an in-tree AGENTS.md dest symlink", () => {
    const project = freshRoot("dest2912-agents-");
    const deftDir = join(project, ".deft", "core");
    seedFramework(deftDir);
    const victim = plantInTreeLeaf(project, "AGENTS.md", "victim\n");

    expect(() => writeAgentsMd(project, deftDir, io)).toThrow(ProjectionContainmentError);
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
  });

  itSymlink("ensureGitattributes refuses an in-tree .gitattributes dest symlink", () => {
    const project = freshRoot("dest2912-ga-");
    const victim = plantInTreeLeaf(project, ".gitattributes", "victim\n");

    expect(() => ensureGitattributes(project, io)).toThrow(ProjectionContainmentError);
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
  });

  itSymlink("ensureGreptileIgnore refuses an in-tree greptile.json dest symlink", () => {
    const project = freshRoot("dest2912-greptile-");
    const victim = plantInTreeLeaf(project, "greptile.json", '{"victim":true}\n');

    expect(() => ensureGreptileIgnore(project, io)).toThrow(ProjectionContainmentError);
    expect(readFileSync(victim, "utf8")).toBe('{"victim":true}\n');
  });

  itSymlink("ensurePrettierIgnoreLines refuses an in-tree .prettierignore dest symlink", () => {
    const project = freshRoot("dest2912-prettier-");
    const victim = plantInTreeLeaf(project, ".prettierignore", "victim\n");

    expect(() => ensurePrettierIgnoreLines(project, io)).toThrow(ProjectionContainmentError);
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
  });

  itSymlink("writeConsumerGitHooks refuses an in-tree .githooks parent-dir symlink", () => {
    const project = freshRoot("dest2912-hooks-dir-");
    const deftDir = join(project, ".deft", "core");
    const srcHooks = join(deftDir, ".githooks");
    mkdirSync(srcHooks, { recursive: true });
    writeFileSync(join(srcHooks, "pre-commit"), "#!/bin/sh\necho deft\n", "utf8");
    chmodSync(join(srcHooks, "pre-commit"), 0o755);

    // In-tree symlink: .githooks -> a real in-tree directory.
    const realDir = join(project, "real-hooks");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(project, ".githooks"), "dir");

    expect(() => writeConsumerGitHooks(project, deftDir, io)).toThrow(ProjectionContainmentError);
    // Nothing deposited through the diverted directory.
    expect(existsSync(join(realDir, "pre-commit"))).toBe(false);
  });

  itSymlink("writeConsumerGitHooks refuses an in-tree hook-file dest symlink", () => {
    const project = freshRoot("dest2912-hooks-leaf-");
    const deftDir = join(project, ".deft", "core");
    const srcHooks = join(deftDir, ".githooks");
    mkdirSync(srcHooks, { recursive: true });
    writeFileSync(join(srcHooks, "pre-commit"), "#!/bin/sh\necho deft\n", "utf8");
    chmodSync(join(srcHooks, "pre-commit"), 0o755);

    mkdirSync(join(project, ".githooks"), { recursive: true });
    const victim = join(project, "protected-script.sh");
    writeFileSync(victim, "KEEP\n", "utf8");
    symlinkSync(victim, join(project, ".githooks", "pre-commit"));

    expect(() => writeConsumerGitHooks(project, deftDir, io)).toThrow(ProjectionContainmentError);
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
  });

  itSymlink("ensureCodeqlPathsIgnore refuses an in-tree .github parent-dir symlink", () => {
    const project = freshRoot("dest2912-codeql-");
    const realDir = join(project, ".deft", "core");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "SKILL.md"), "KEEP\n", "utf8");
    // In-tree symlink: .github -> .deft/core (both under the project tree).
    symlinkSync(realDir, join(project, ".github"), "dir");

    expect(() => ensureCodeqlPathsIgnore(project, io)).toThrow(ProjectionContainmentError);
    // No codeql config written through the diverted .github tree.
    expect(existsSync(join(realDir, "codeql"))).toBe(false);
  });

  itSymlink("ensureCoreGuardWorkflow refuses an in-tree .github parent-dir symlink", () => {
    const project = freshRoot("dest2912-guard-");
    const realDir = join(project, "nested");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(project, ".github"), "dir");

    expect(() => ensureCoreGuardWorkflow(project, io)).toThrow(ProjectionContainmentError);
    expect(existsSync(join(realDir, "workflows"))).toBe(false);
  });

  itSymlink(
    "depositNeutralization fails closed on an in-tree .gitattributes dest symlink",
    async () => {
      const project = freshRoot("dest2912-neutralize-");
      const victim = plantInTreeLeaf(project, ".gitattributes", "victim\n");

      await expect(depositNeutralization(project, io)).rejects.toThrow(ProjectionContainmentError);
      expect(readFileSync(victim, "utf8")).toBe("victim\n");
    },
  );

  itSymlink("writeAgentsSkills refuses an in-tree .agents parent-dir symlink", () => {
    const project = freshRoot("dest2912-agents-skills-");
    const realDir = join(project, "real-agents");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(project, ".agents"), "dir");

    expect(() => writeAgentsSkills(project, io)).toThrow(ProjectionContainmentError);
    expect(existsSync(join(realDir, "skills"))).toBe(false);
  });
});
