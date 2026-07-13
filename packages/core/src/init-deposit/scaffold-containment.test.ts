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
import {
  depositNeutralization,
  ensureGitattributes,
  ensureTaskfile,
  writeAgentsMd,
  writeAgentsSkills,
} from "./scaffold.js";

const itSymlink = it.skipIf(process.platform === "win32");

describe("init-deposit projection containment (#2446)", () => {
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

  function captureIo(): { io: { printf: (text: string) => void } } {
    return { io: { printf: () => {} } };
  }

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

  itSymlink("writeAgentsMd refuses when AGENTS.md is a symlink outside the project", () => {
    const project = freshRoot("scaffold-agents-symlink-");
    const deftDir = join(project, ".deft", "core");
    const escapeDir = freshEscape("scaffold-agents-escape-");
    const escapeFile = join(escapeDir, "stolen-agents.md");
    seedFramework(deftDir);
    writeFileSync(escapeFile, "victim\n", "utf8");
    symlinkSync(escapeFile, join(project, "AGENTS.md"));

    expect(() => writeAgentsMd(project, deftDir, captureIo().io)).toThrow(
      ProjectionContainmentError,
    );
    expect(readFileSync(escapeFile, "utf8")).toBe("victim\n");
  });

  itSymlink("ensureTaskfile refuses when Taskfile.yml is a symlink outside the project", () => {
    const project = freshRoot("scaffold-taskfile-symlink-");
    const escapeDir = freshEscape("scaffold-taskfile-escape-");
    const escapeFile = join(escapeDir, "stolen-taskfile.yml");
    writeFileSync(escapeFile, "victim\n", "utf8");
    symlinkSync(escapeFile, join(project, "Taskfile.yml"));

    expect(() => ensureTaskfile(project, captureIo().io)).toThrow(ProjectionContainmentError);
    expect(readFileSync(escapeFile, "utf8")).toBe("victim\n");
  });

  itSymlink(
    "ensureGitattributes refuses when .gitattributes is a symlink outside the project",
    () => {
      const project = freshRoot("scaffold-ga-symlink-");
      const escapeDir = freshEscape("scaffold-ga-escape-");
      const escapeFile = join(escapeDir, "stolen.gitattributes");
      writeFileSync(escapeFile, "victim\n", "utf8");
      symlinkSync(escapeFile, join(project, ".gitattributes"));

      expect(() => ensureGitattributes(project, captureIo().io)).toThrow(
        ProjectionContainmentError,
      );
      expect(readFileSync(escapeFile, "utf8")).toBe("victim\n");
    },
  );

  itSymlink(
    "depositNeutralization fails closed when greptile.json is a symlink outside the project",
    async () => {
      const project = freshRoot("scaffold-greptile-symlink-");
      const escapeDir = freshEscape("scaffold-greptile-escape-");
      const escapeFile = join(escapeDir, "stolen-greptile.json");
      writeFileSync(escapeFile, '{"victim":true}\n', "utf8");
      symlinkSync(escapeFile, join(project, "greptile.json"));

      await expect(depositNeutralization(project, captureIo().io)).rejects.toThrow(
        ProjectionContainmentError,
      );
      expect(readFileSync(escapeFile, "utf8")).toBe('{"victim":true}\n');
    },
  );

  itSymlink(
    "writeAgentsSkills refuses symlinked .agents even when all skills already exist outside the project",
    () => {
      const project = freshRoot("scaffold-agentsdir-prepop-");
      const escapeDir = freshEscape("scaffold-agentsdir-prepop-escape-");
      const skillDirs = [
        "deft",
        "deft-directive-setup",
        "deft-directive-build",
        "deft-directive-review-cycle",
        "deft-directive-refinement",
        "deft-directive-swarm",
        "deft-directive-interview",
        "deft-directive-pre-pr",
        "deft-directive-sync",
      ];
      for (const dir of skillDirs) {
        const skillDir = join(escapeDir, "skills", dir);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), `# ${dir}\n`, "utf8");
      }
      symlinkSync(escapeDir, join(project, ".agents"), "dir");

      expect(() => writeAgentsSkills(project, captureIo().io)).toThrow(ProjectionContainmentError);
    },
  );

  itSymlink("writeAgentsSkills refuses when .agents is a symlink outside the project", () => {
    const project = freshRoot("scaffold-agentsdir-symlink-");
    const escapeDir = freshEscape("scaffold-agentsdir-escape-");
    mkdirSync(escapeDir, { recursive: true });
    symlinkSync(escapeDir, join(project, ".agents"), "dir");

    const deftDir = join(project, ".deft", "core");
    mkdirSync(join(deftDir, ".githooks"), { recursive: true });
    writeFileSync(join(deftDir, ".githooks", "pre-commit"), "#!/bin/sh\n", "utf8");
    chmodSync(join(deftDir, ".githooks", "pre-commit"), 0o755);

    expect(() => writeAgentsSkills(project, captureIo().io)).toThrow(ProjectionContainmentError);
    expect(existsSync(join(escapeDir, "skills"))).toBe(false);
  });
});
