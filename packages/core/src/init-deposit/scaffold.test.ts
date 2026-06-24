import {
  chmodSync,
  copyFileSync,
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
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import {
  buildInstallManifestText,
  CANONICAL_TASKFILE_INCLUDE,
  depositNeutralization,
  ensureCodeqlPathsIgnore,
  ensureCoreGuardWorkflow,
  ensureGitattributes,
  ensureGreptileIgnore,
  ensureTaskfile,
  pruneFrameworkSelfTests,
  pruneVendoredTsTests,
  writeAgentsMd,
  writeAgentsSkills,
  writeConsumerGitHooks,
  writeConsumerVbrief,
  writeInstallManifest,
} from "./scaffold.js";

describe("init-deposit scaffold", () => {
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

  function captureIo(): { lines: string[]; io: { printf: (text: string) => void } } {
    const lines: string[] = [];
    return {
      lines,
      io: {
        printf: (text) => {
          lines.push(text);
        },
      },
    };
  }

  function seedFramework(deftDir: string): void {
    mkdirSync(join(deftDir, "templates"), { recursive: true });
    copyFileSync(
      join(process.cwd(), "content/templates/agents-entry.md"),
      join(deftDir, "templates/agents-entry.md"),
    );
    mkdirSync(join(deftDir, "vbrief", "schemas"), { recursive: true });
    writeFileSync(join(deftDir, "vbrief", "schemas", "example.schema.json"), "{}\n", "utf8");
    writeFileSync(join(deftDir, "vbrief", "vbrief.md"), "# vbrief\n", "utf8");
    mkdirSync(join(deftDir, ".githooks"), { recursive: true });
    writeFileSync(join(deftDir, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(join(deftDir, ".githooks", "pre-commit"), 0o755);
  }

  it("writes AGENTS.md managed section on greenfield", () => {
    const project = freshRoot("scaffold-agents-");
    const deftDir = join(project, ".deft/core");
    seedFramework(deftDir);
    const { io } = captureIo();

    expect(writeAgentsMd(project, deftDir, io)).toBe(true);
    const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(agents).toContain("<!-- deft:managed-section");
    expect(agents).toContain(AGENTS_MANAGED_CLOSE);
  });

  it("deposits vbrief lifecycle dirs and schemas", async () => {
    const project = freshRoot("scaffold-vbrief-");
    const deftDir = join(project, ".deft/core");
    seedFramework(deftDir);
    const { io } = captureIo();

    expect(await writeConsumerVbrief(project, deftDir, io)).toBe(true);
    for (const sub of ["proposed", "pending", "active", "completed", "cancelled"]) {
      expect(existsSync(join(project, "vbrief", sub, ".gitkeep"))).toBe(true);
    }
    expect(existsSync(join(project, "vbrief", "schemas", "example.schema.json"))).toBe(true);
    expect(readFileSync(join(project, "vbrief", "vbrief.md"), "utf8")).toContain("# vbrief");
  });

  it("creates .agents/skills pointers idempotently", () => {
    const project = freshRoot("scaffold-skills-");
    const { io } = captureIo();

    expect(writeAgentsSkills(project, io)).toBe(true);
    expect(readFileSync(join(project, ".agents/skills/deft/SKILL.md"), "utf8")).toContain(
      ".deft/core/SKILL.md",
    );
    expect(writeAgentsSkills(project, io)).toBe(false);
  });

  it("wires Taskfile include idempotently", () => {
    const project = freshRoot("scaffold-taskfile-");
    const { io } = captureIo();

    expect(ensureTaskfile(project, io)).toBe(true);
    const taskfile = readFileSync(join(project, "Taskfile.yml"), "utf8");
    expect(taskfile).toContain(CANONICAL_TASKFILE_INCLUDE);
    expect(ensureTaskfile(project, io)).toBe(false);
  });

  it("deposits consumer git hooks from framework payload", () => {
    const project = freshRoot("scaffold-hooks-");
    const deftDir = join(project, ".deft/core");
    seedFramework(deftDir);
    const { io } = captureIo();

    expect(
      writeConsumerGitHooks(project, deftDir, io, {
        getHooksPath: () => "",
        setHooksPath: () => true,
      }),
    ).toBe(true);
    expect(readFileSync(join(project, ".githooks", "pre-commit"), "utf8")).toContain("#!/bin/sh");
  });

  it("deposits #1430 neutralization artifacts", async () => {
    const project = freshRoot("scaffold-neutral-");
    const { io } = captureIo();

    await depositNeutralization(project, io);

    expect(readFileSync(join(project, ".gitattributes"), "utf8")).toContain(".deft/core/**");
    expect(readFileSync(join(project, "greptile.json"), "utf8")).toContain(".deft/core/**");
    expect(readFileSync(join(project, ".github/codeql/codeql-config.yml"), "utf8")).toContain(
      "paths-ignore",
    );
    expect(existsSync(join(project, ".github/workflows/deft-core-guard.yml"))).toBe(true);
  });

  it("skips AGENTS.md rewrite when the managed section is already current", () => {
    const project = freshRoot("scaffold-agents-current-");
    const deftDir = join(project, ".deft/core");
    seedFramework(deftDir);
    const { io } = captureIo();
    writeAgentsMd(project, deftDir, io);
    expect(writeAgentsMd(project, deftDir, io)).toBe(false);
  });

  it("inserts deft include into an existing top-level includes block", () => {
    const project = freshRoot("scaffold-taskfile-includes-");
    writeFileSync(
      join(project, "Taskfile.yml"),
      "version: '3'\nincludes:\n  app:\n    taskfile: ./app/Taskfile.yml\n",
      "utf8",
    );
    const { io } = captureIo();
    expect(ensureTaskfile(project, io)).toBe(true);
    expect(readFileSync(join(project, "Taskfile.yml"), "utf8")).toContain(
      CANONICAL_TASKFILE_INCLUDE,
    );
  });

  it("skips vbrief deposit when the scaffold already exists", async () => {
    const project = freshRoot("scaffold-vbrief-skip-");
    const deftDir = join(project, ".deft/core");
    seedFramework(deftDir);
    const { io } = captureIo();
    await writeConsumerVbrief(project, deftDir, io);
    expect(await writeConsumerVbrief(project, deftDir, io)).toBe(false);
  });

  it("neutralization and manifest helpers are idempotent", async () => {
    const project = freshRoot("scaffold-idempotent-");
    const { io } = captureIo();
    await depositNeutralization(project, io);
    expect(ensureGitattributes(project, io)).toBe(false);
    expect(ensureGreptileIgnore(project, io)).toBe(false);
    expect(ensureCodeqlPathsIgnore(project, io)).toBe(false);
    expect(ensureCoreGuardWorkflow(project, io)).toBe(false);

    const manifestPath = writeInstallManifest(project, join(project, ".deft/core"), {
      ref: "v0.53.0",
      sha: "abc",
      tag: "0.53.0",
      installRoot: ".deft/core",
      fetchedAt: "2026-06-24T12:00:00Z",
      fetchedBy: "test",
    });
    expect(readFileSync(manifestPath, "utf8")).toContain("install_root: '.deft/core'");
    expect(
      buildInstallManifestText({
        ref: "",
        sha: "abc",
        tag: "0.53.0",
        installRoot: ".deft/core",
        fetchedAt: "t",
        fetchedBy: "test",
      }),
    ).toContain("tag: 'v0.53.0'");
  });

  it("prunes framework self-tests and vendored TS test files", async () => {
    const project = freshRoot("scaffold-prune-");
    const { io } = captureIo();
    mkdirSync(join(project, ".deft/core/tests/unit"), { recursive: true });
    writeFileSync(join(project, ".deft/core/tests/unit/a.test.ts"), "export {}\n", "utf8");
    mkdirSync(join(project, ".deft/core/packages/cli/src"), { recursive: true });
    writeFileSync(join(project, ".deft/core/packages/cli/src/foo.test.ts"), "export {}\n", "utf8");
    writeFileSync(join(project, ".deft/core/packages/cli/src/index.ts"), "export {}\n", "utf8");

    expect(await pruneFrameworkSelfTests(project, io)).toBe(true);
    expect(await pruneVendoredTsTests(project, io)).toBe(1);
    expect(existsSync(join(project, ".deft/core/tests"))).toBe(false);
    expect(existsSync(join(project, ".deft/core/packages/cli/src/foo.test.ts"))).toBe(false);
    expect(existsSync(join(project, ".deft/core/packages/cli/src/index.ts"))).toBe(true);
  });

  it("updates greptile.json and appends Taskfile include when no includes block exists", () => {
    const project = freshRoot("scaffold-more-branches-");
    writeFileSync(join(project, "greptile.json"), '{"reviewRules":[]}\n', "utf8");
    writeFileSync(
      join(project, "Taskfile.yml"),
      "version: '3'\ntasks:\n  hi:\n    cmds: [echo hi]\n",
      "utf8",
    );
    const { io } = captureIo();

    expect(ensureGreptileIgnore(project, io)).toBe(true);
    expect(ensureTaskfile(project, io)).toBe(true);
    expect(readFileSync(join(project, "Taskfile.yml"), "utf8")).toContain(
      CANONICAL_TASKFILE_INCLUDE,
    );
  });

  it("skips hook wiring when consumer hooks already match the payload", () => {
    const project = freshRoot("scaffold-hooks-skip-");
    const deftDir = join(project, ".deft/core");
    seedFramework(deftDir);
    const { io } = captureIo();
    writeConsumerGitHooks(project, deftDir, io, {
      getHooksPath: () => ".githooks",
      setHooksPath: () => true,
    });
    expect(
      writeConsumerGitHooks(project, deftDir, io, {
        getHooksPath: () => ".githooks",
        setHooksPath: () => false,
      }),
    ).toBe(false);
  });

  it("warns when git config cannot wire core.hooksPath", () => {
    const project = freshRoot("scaffold-hooks-config-fail-");
    const deftDir = join(project, ".deft/core");
    seedFramework(deftDir);
    const { lines, io } = captureIo();
    expect(
      writeConsumerGitHooks(project, deftDir, io, {
        getHooksPath: () => "",
        setHooksPath: () => false,
      }),
    ).toBe(true);
    expect(lines.join("")).toContain("Warning: could not set core.hooksPath");
    expect(lines.join("")).toContain(".githooks/ deposited");
  });

  it("refreshes a stale deft-core guard and skips absent hook sources", () => {
    const project = freshRoot("scaffold-guard-refresh-");
    const deftDir = join(project, ".deft/core");
    const { io } = captureIo();
    mkdirSync(join(project, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(project, ".github/workflows/deft-core-guard.yml"),
      "name: deft-core-guard\nold: true\n",
      "utf8",
    );
    expect(ensureCoreGuardWorkflow(project, io)).toBe(true);
    expect(writeConsumerGitHooks(project, deftDir, io)).toBe(false);
  });

  it("inserts deft include after an includes line with an inline comment", () => {
    const project = freshRoot("scaffold-taskfile-comment-");
    writeFileSync(
      join(project, "Taskfile.yml"),
      "version: '3'\nincludes:  # app tasks\n  app:\n    taskfile: ./app/Taskfile.yml\n",
      "utf8",
    );
    const { io } = captureIo();
    expect(ensureTaskfile(project, io)).toBe(true);
    expect(readFileSync(join(project, "Taskfile.yml"), "utf8")).toContain(
      CANONICAL_TASKFILE_INCLUDE,
    );
  });

  it("leaves a non-deft core guard workflow untouched", () => {
    const project = freshRoot("scaffold-guard-foreign-");
    mkdirSync(join(project, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(project, ".github/workflows/deft-core-guard.yml"),
      "name: custom-guard\n",
      "utf8",
    );
    const { io } = captureIo();
    expect(ensureCoreGuardWorkflow(project, io)).toBe(false);
    expect(readFileSync(join(project, ".github/workflows/deft-core-guard.yml"), "utf8")).toContain(
      "custom-guard",
    );
  });

  it("updates an existing CodeQL config paths-ignore block", () => {
    const project = freshRoot("scaffold-codeql-update-");
    mkdirSync(join(project, ".github/codeql"), { recursive: true });
    writeFileSync(
      join(project, ".github/codeql/codeql-config.yml"),
      "name: existing\npaths-ignore:\n  - 'dist/**'\n",
      "utf8",
    );
    const { io } = captureIo();
    expect(ensureCodeqlPathsIgnore(project, io)).toBe(true);
    expect(readFileSync(join(project, ".github/codeql/codeql-config.yml"), "utf8")).toContain(
      ".deft/core/**",
    );
  });

  it("appends CodeQL paths-ignore when no paths-ignore header exists", () => {
    const project = freshRoot("scaffold-codeql-append-");
    mkdirSync(join(project, ".github/codeql"), { recursive: true });
    writeFileSync(
      join(project, ".github/codeql/codeql-config.yml"),
      "name: bare\nlanguages:\n  - javascript\n",
      "utf8",
    );
    const { lines, io } = captureIo();
    expect(ensureCodeqlPathsIgnore(project, io)).toBe(true);
    const content = readFileSync(join(project, ".github/codeql/codeql-config.yml"), "utf8");
    expect(content).toContain("paths-ignore");
    expect(content).toContain(".deft/core/**");
    expect(lines.join("")).toContain("updated");
  });

  it("continues neutralization when a step throws", async () => {
    const project = freshRoot("scaffold-neutral-error-");
    writeFileSync(join(project, "greptile.json"), "not-json", "utf8");
    const { lines, io } = captureIo();
    await depositNeutralization(project, io);
    expect(lines.join("")).toContain("Warning: neutralization step failed");
    expect(existsSync(join(project, ".gitattributes"))).toBe(true);
  });
});
