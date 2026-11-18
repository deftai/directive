import { execFileSync } from "node:child_process";
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
import { parseManagedSectionAttrs, renderManagedSection } from "../platform/agents-md.js";
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import {
  buildInstallManifestText,
  CANONICAL_TASKFILE_INCLUDE,
  depositNeutralization,
  ensureCodeqlPathsIgnore,
  ensureGitattributes,
  ensureGreptileIgnore,
  ensurePackageJsonPin,
  ensureTaskfile,
  gitattributesDepositComment,
  MANAGED_WIRING_GITATTRIBUTES_LINES,
  PIN_DEPENDENCY_NAME,
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
    copyFileSync(
      join(process.cwd(), "content/templates/agents-consumer-header.md"),
      join(deftDir, "templates/agents-consumer-header.md"),
    );
    mkdirSync(join(deftDir, "vbrief", "schemas"), { recursive: true });
    writeFileSync(join(deftDir, "vbrief", "schemas", "example.schema.json"), "{}\n", "utf8");
    writeFileSync(
      join(deftDir, "vbrief", "schemas", "vbrief-core.schema.json"),
      "legacy\n",
      "utf8",
    );
    writeFileSync(
      join(deftDir, "vbrief", "schemas", "xbrief-core-0.8.schema.json"),
      "current\n",
      "utf8",
    );
    writeFileSync(join(deftDir, "vbrief", "vbrief.md"), "# vbrief\n", "utf8");
    mkdirSync(join(deftDir, ".githooks"), { recursive: true });
    writeFileSync(
      join(deftDir, ".githooks", "pre-commit"),
      readFileSync(join(process.cwd(), ".githooks/pre-commit"), "utf8"),
      "utf8",
    );
    chmodSync(join(deftDir, ".githooks", "pre-commit"), 0o755);
    writeFileSync(
      join(deftDir, ".githooks", "pre-push"),
      readFileSync(join(process.cwd(), ".githooks/pre-push"), "utf8"),
      "utf8",
    );
    chmodSync(join(deftDir, ".githooks", "pre-push"), 0o755);
    writeFileSync(
      join(deftDir, ".githooks", "_directive-run.sh"),
      readFileSync(join(process.cwd(), ".githooks/_directive-run.sh"), "utf8"),
      "utf8",
    );
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
    expect(agents).toContain("## Session orientation");
    expect(agents).not.toContain("## Status");
    expect(agents).not.toContain("## Known Issues");
  });

  it("deposits vbrief lifecycle dirs and schemas", async () => {
    const project = freshRoot("scaffold-vbrief-");
    const deftDir = join(project, ".deft/core");
    seedFramework(deftDir);
    const { io } = captureIo();

    expect(await writeConsumerVbrief(project, deftDir, io)).toBe(true);
    for (const sub of ["proposed", "pending", "active", "completed", "cancelled"]) {
      expect(existsSync(join(project, "xbrief", sub, ".gitkeep"))).toBe(true);
    }
    expect(existsSync(join(project, "xbrief", "schemas", "example.schema.json"))).toBe(true);
    expect(existsSync(join(project, "xbrief", "schemas", "vbrief-core.schema.json"))).toBe(false);
    expect(existsSync(join(project, "xbrief", "schemas", "xbrief-core-0.8.schema.json"))).toBe(
      true,
    );
    expect(readFileSync(join(project, "xbrief", "vbrief.md"), "utf8")).toContain("# vbrief");
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
    expect(taskfile).toContain("task deft:check");
    expect(taskfile).toContain("#3218");
    expect(taskfile).not.toContain("available from the project root");
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
    expect(readFileSync(join(project, ".githooks", "pre-commit"), "utf8")).toContain(
      "run_directive verify:encoding",
    );
    expect(readFileSync(join(project, ".githooks", "_directive-run.sh"), "utf8")).toContain(
      "run_directive()",
    );
  });

  it("deposits #1430 neutralization artifacts", async () => {
    const project = freshRoot("scaffold-neutral-");
    const { io } = captureIo();

    await depositNeutralization(project, io);

    const attrsNeutral = readFileSync(join(project, ".gitattributes"), "utf8");
    // #5961: the shared constants no longer carry the retired .deft/core lines.
    expect(attrsNeutral).not.toContain(".deft/core");
    expect(attrsNeutral).toContain(".claude/commands/** text=auto eol=lf");
    expect(readFileSync(join(project, "greptile.json"), "utf8")).toContain(".deft/core/**");
    expect(readFileSync(join(project, ".github/codeql/codeql-config.yml"), "utf8")).toContain(
      "paths-ignore",
    );
    // The retired deft-core-guard workflow is no longer written (#5835).
    expect(existsSync(join(project, ".github/workflows/deft-core-guard.yml"))).toBe(false);
  });

  it("skips AGENTS.md rewrite when the managed section is already current", () => {
    const project = freshRoot("scaffold-agents-current-");
    const deftDir = join(project, ".deft/core");
    seedFramework(deftDir);
    const { io } = captureIo();
    writeAgentsMd(project, deftDir, io);
    expect(writeAgentsMd(project, deftDir, io)).toBe(false);
  });

  it("renders AGENTS from the deposit tree when prefer-package is stale (#5013)", () => {
    const project = freshRoot("scaffold-agents-same-root-");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(join(deftDir, "templates"), { recursive: true });
    const depositTemplate = `<!-- deft:managed-section v3 -->\n# Deposit-new marker 0.119.8\n${AGENTS_MANAGED_CLOSE}\n`;
    writeFileSync(join(deftDir, "templates", "agents-entry.md"), depositTemplate, "utf8");
    writeFileSync(
      join(deftDir, "package.json"),
      JSON.stringify({ name: "@deftai/directive-content", version: "0.119.8" }),
      "utf8",
    );

    const stalePkg = join(project, "node_modules", "@deftai", "directive-content");
    mkdirSync(join(stalePkg, "templates"), { recursive: true });
    writeFileSync(
      join(stalePkg, "templates", "agents-entry.md"),
      `<!-- deft:managed-section v3 -->\n# Stale-prefer-package marker 0.119.2\n${AGENTS_MANAGED_CLOSE}\n`,
      "utf8",
    );
    writeFileSync(
      join(stalePkg, "package.json"),
      JSON.stringify({ name: "@deftai/directive-content", version: "0.119.2" }),
      "utf8",
    );

    const { io } = captureIo();
    expect(writeAgentsMd(project, deftDir, io)).toBe(true);
    const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(agents).toContain("Deposit-new marker 0.119.8");
    expect(agents).not.toContain("Stale-prefer-package marker 0.119.2");
    const attrs = parseManagedSectionAttrs(agents);
    expect(attrs?.sha).toBe("0.119.8");
    const expectedBody = renderManagedSection(depositTemplate);
    expect(expectedBody).not.toBeNull();
    expect(renderManagedSection(agents)).toBe(expectedBody);
  });

  it("returns false without throw when content-tree agents template is missing (#5013)", () => {
    const project = freshRoot("scaffold-agents-template-missing-");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    const { lines, io } = captureIo();
    expect(writeAgentsMd(project, deftDir, io)).toBe(false);
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    expect(lines.some((line) => line.includes("template-missing"))).toBe(true);
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

  /** The 19-line block setup appended before #5961 (core comment + core lines + managed lines). */
  const OLD_BLOCK = [
    "# Deft framework: the vendored payload is packaged framework code, not",
    "# consumer source. text=auto + eol=lf normalizes text only; binaries keep",
    "# byte identity. Mark generated + vendored (#1430, #2118, #5245).",
    ".deft/core/** text=auto eol=lf",
    ".deft/core/** linguist-generated=true",
    ".deft/core/** linguist-vendored=true",
    ".claude/commands/** text=auto eol=lf",
    ".cursor/commands/** text=auto eol=lf",
    ".grok/commands/** text=auto eol=lf",
    ".codex/prompts/** text=auto eol=lf",
    ".agents/skills/** text=auto eol=lf",
    ".claude/skills/** text=auto eol=lf",
    ".cursor/skills/** text=auto eol=lf",
    ".codex/skills/** text=auto eol=lf",
    ".github/skills/** text=auto eol=lf",
    ".githooks/** text=auto eol=lf",
    ".grok/hooks/** text=auto eol=lf",
    "AGENTS.md text=auto eol=lf",
  ];

  it("fresh write has the managed header and lines and no .deft/core (#5961)", () => {
    const project = freshRoot("scaffold-gitattributes-fresh-");
    const { io } = captureIo();
    expect(ensureGitattributes(project, io)).toBe(true);
    const attrs = readFileSync(join(project, ".gitattributes"), "utf8");
    expect(attrs).toBe(
      `${gitattributesDepositComment()}${MANAGED_WIRING_GITATTRIBUTES_LINES.join("\n")}\n`,
    );
    expect(attrs).not.toContain(".deft/core");
    expect(ensureGitattributes(project, io)).toBe(false);
  });

  it("strips the old block to the managed header and lines, keeping customer lines (#5961)", () => {
    const project = freshRoot("scaffold-gitattributes-strip-");
    const { io, lines } = captureIo();
    const customer = "* text=auto\n*.png binary\n";
    writeFileSync(
      join(project, ".gitattributes"),
      `${customer}\n${OLD_BLOCK.join("\n")}\n`,
      "utf8",
    );

    expect(ensureGitattributes(project, io)).toBe(true);
    const attrs = readFileSync(join(project, ".gitattributes"), "utf8");
    expect(attrs).toBe(
      `${customer}\n${gitattributesDepositComment()}${MANAGED_WIRING_GITATTRIBUTES_LINES.join("\n")}\n`,
    );
    expect(lines.join("")).toContain("removed .deft/core/** text=auto eol=lf");
    // Second run is a no-op (AC8.2).
    expect(ensureGitattributes(project, io)).toBe(false);
    expect(readFileSync(join(project, ".gitattributes"), "utf8")).toBe(attrs);
  });

  it("removes the legacy forced-text line and older comment forms (#5245 / #5961)", () => {
    const project = freshRoot("scaffold-gitattributes-legacy-");
    const { io } = captureIo();
    writeFileSync(
      join(project, ".gitattributes"),
      [
        "# consumer fixture",
        "*.md text",
        "# Deft framework: the vendored payload is packaged framework code, not",
        "# consumer source. text=auto + eol=lf normalizes text only; binaries keep",
        "# byte identity (#5245).",
        ".deft/core/** text eol=lf",
        ".deft/core/** linguist-generated=true",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(ensureGitattributes(project, io)).toBe(true);
    const attrs = readFileSync(join(project, ".gitattributes"), "utf8");
    expect(attrs.startsWith("# consumer fixture\n*.md text\n")).toBe(true);
    expect(attrs).not.toContain(".deft/core");
    expect(attrs).not.toContain("Deft framework");
    expect(attrs).not.toContain("byte identity");
  });

  it("adds missing managed lines inside the managed block when it ends the file (#6167)", () => {
    const project = freshRoot("scaffold-gitattributes-extend-");
    const { io } = captureIo();
    const older = MANAGED_WIRING_GITATTRIBUTES_LINES.filter((l) => !l.includes("deft-hook-"));
    const customer = "# customer head\n*.go diff=golang\n\n";
    writeFileSync(
      join(project, ".gitattributes"),
      `${customer}${gitattributesDepositComment()}${older.join("\n")}\n`,
      "utf8",
    );
    expect(ensureGitattributes(project, io)).toBe(true);
    const attrs = readFileSync(join(project, ".gitattributes"), "utf8");
    expect(attrs).toBe(
      `${customer}${gitattributesDepositComment()}${MANAGED_WIRING_GITATTRIBUTES_LINES.join("\n")}\n`,
    );
    expect(attrs.match(/# Deft managed wiring:/g) ?? []).toHaveLength(1);
  });

  it("moves the managed block below later customer rules so new pins take effect (#6167)", () => {
    const project = freshRoot("scaffold-gitattributes-tail-");
    const { io } = captureIo();
    execFileSync("git", ["init", "-q"], { cwd: project });
    const older = MANAGED_WIRING_GITATTRIBUTES_LINES.filter((l) => !l.includes("deft-hook-"));
    writeFileSync(
      join(project, ".gitattributes"),
      `${gitattributesDepositComment()}${older.join("\n")}\n\n# customer tail\n* text=auto eol=crlf\n`,
      "utf8",
    );
    expect(ensureGitattributes(project, io)).toBe(true);
    const attrs = readFileSync(join(project, ".gitattributes"), "utf8");
    expect(attrs).toBe(
      `# customer tail\n* text=auto eol=crlf\n\n${gitattributesDepositComment()}${MANAGED_WIRING_GITATTRIBUTES_LINES.join("\n")}\n`,
    );
    for (const rel of [".claude/deft-hook-0a1b2c3d.mjs", ".cursor/hooks/deft-hook-deadbeef.mjs"]) {
      const out = execFileSync("git", ["check-attr", "eol", "--", rel], {
        cwd: project,
        encoding: "utf8",
      });
      expect(out.trim()).toBe(`${rel}: eol: lf`);
    }
    expect(ensureGitattributes(project, io)).toBe(false);
  });

  it("keeps CRLF line endings when the file uses them", () => {
    const project = freshRoot("scaffold-gitattributes-crlf-");
    const { io } = captureIo();
    writeFileSync(
      join(project, ".gitattributes"),
      "*.md text\r\n.deft/core/** text eol=lf\r\n",
      "utf8",
    );
    expect(ensureGitattributes(project, io)).toBe(true);
    const attrs = readFileSync(join(project, ".gitattributes"), "utf8");
    expect(attrs.startsWith("*.md text\r\n")).toBe(true);
    expect(attrs.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("preserves consumer trailing blank lines when augmenting (#5463)", () => {
    const project = freshRoot("scaffold-gitattributes-blanks-");
    const { io } = captureIo();
    const pre = "# consumer attrs\n*.md text\n\n\n";
    writeFileSync(join(project, ".gitattributes"), pre, "utf8");
    expect(ensureGitattributes(project, io)).toBe(true);
    const attrs = readFileSync(join(project, ".gitattributes"), "utf8");
    expect(attrs.startsWith(pre)).toBe(true);
  });

  it("an LF rule covers every host hook outer for any hash (#6167)", () => {
    const project = freshRoot("scaffold-gitattributes-check-attr-");
    const { io } = captureIo();
    execFileSync("git", ["init", "-q"], { cwd: project });
    ensureGitattributes(project, io);
    for (const rel of [
      ".claude/deft-hook-0a1b2c3d.mjs",
      ".codex/deft-hook-12345678.mjs",
      ".cursor/hooks/deft-hook-deadbeef.mjs",
      ".grok/hooks/deft-hook-cafef00d.mjs",
    ]) {
      const out = execFileSync("git", ["check-attr", "eol", "--", rel], {
        cwd: project,
        encoding: "utf8",
      });
      expect(out.trim()).toBe(`${rel}: eol: lf`);
    }
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

  it("skips absent hook sources", () => {
    const project = freshRoot("scaffold-hooks-absent-");
    const deftDir = join(project, ".deft/core");
    const { io } = captureIo();
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

  describe("ensurePackageJsonPin (#2264 a6 / unblocks #2269)", () => {
    function readPkg(project: string): Record<string, unknown> {
      return JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    }

    it("creates a private package.json with an exact pin when absent", () => {
      const project = freshRoot("scaffold-pin-create-");
      const { lines, io } = captureIo();
      const result = ensurePackageJsonPin(project, "v0.65.0", io);
      expect(result.changed).toBe(true);
      expect(result.created).toBe(true);
      expect(result.pinVersion).toBe("0.65.0");
      const pkg = readPkg(project);
      expect(pkg.private).toBe(true);
      expect((pkg.devDependencies as Record<string, string>)[PIN_DEPENDENCY_NAME]).toBe("0.65.0");
      expect(lines.join("")).toContain("created");
    });

    it("updates an existing package.json and preserves private + other fields", () => {
      const project = freshRoot("scaffold-pin-update-");
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ name: "my-app", private: true, scripts: { build: "tsc" } }, null, 2),
        "utf8",
      );
      const { io } = captureIo();
      const result = ensurePackageJsonPin(project, "0.65.0", io);
      expect(result.changed).toBe(true);
      expect(result.created).toBe(false);
      const pkg = readPkg(project);
      expect(pkg.name).toBe("my-app");
      expect(pkg.private).toBe(true);
      expect((pkg.scripts as Record<string, string>).build).toBe("tsc");
      expect((pkg.devDependencies as Record<string, string>)[PIN_DEPENDENCY_NAME]).toBe("0.65.0");
    });

    it("does not add private to an existing package.json that omits it", () => {
      const project = freshRoot("scaffold-pin-nopriv-");
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ name: "public-lib" }, null, 2),
        "utf8",
      );
      const { io } = captureIo();
      ensurePackageJsonPin(project, "0.65.0", io);
      const pkg = readPkg(project);
      expect("private" in pkg).toBe(false);
    });

    it("does not duplicate an exact pin already in dependencies", () => {
      const project = freshRoot("scaffold-pin-prod-");
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ name: "app", dependencies: { [PIN_DEPENDENCY_NAME]: "0.65.0" } }, null, 2),
        "utf8",
      );
      const { lines, io } = captureIo();
      const result = ensurePackageJsonPin(project, "0.65.0", io);
      expect(result.changed).toBe(false);
      const pkg = readPkg(project);
      expect((pkg.dependencies as Record<string, string>)[PIN_DEPENDENCY_NAME]).toBe("0.65.0");
      expect(pkg.devDependencies).toBeUndefined();
      expect(lines.join("")).toContain("dependencies");
    });

    it("is idempotent when the exact pin already matches", () => {
      const project = freshRoot("scaffold-pin-idem-");
      const { io } = captureIo();
      ensurePackageJsonPin(project, "0.65.0", io);
      const { lines, io: io2 } = captureIo();
      const result = ensurePackageJsonPin(project, "0.65.0", io2);
      expect(result.changed).toBe(false);
      expect(lines.join("")).toContain("already pins");
    });

    it("throws on a malformed package.json instead of clobbering it", () => {
      const project = freshRoot("scaffold-pin-bad-");
      writeFileSync(join(project, "package.json"), "not-json", "utf8");
      const { io } = captureIo();
      expect(() => ensurePackageJsonPin(project, "0.65.0", io)).toThrow(/could not parse/);
    });
  });
});
