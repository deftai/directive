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
  coreGuardCheckoutUsesLine,
  depositNeutralization,
  ensureCodeqlPathsIgnore,
  ensureCoreGuardWorkflow,
  ensureGitattributes,
  ensureGreptileIgnore,
  ensurePackageJsonPin,
  ensureTaskfile,
  extractCoreGuardCheckoutUsesLine,
  mergeCoreGuardWorkflowRefresh,
  PIN_DEPENDENCY_NAME,
  pruneFrameworkSelfTests,
  pruneVendoredTsTests,
  shouldPreserveCoreGuardCheckoutPin,
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
      join(deftDir, ".githooks", "_deft-run.sh"),
      readFileSync(join(process.cwd(), ".githooks/_deft-run.sh"), "utf8"),
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
      "deft verify:branch",
    );
    expect(readFileSync(join(project, ".githooks", "_deft-run.sh"), "utf8")).toContain(
      "run_deft()",
    );
  });

  it("deposits #1430 neutralization artifacts", async () => {
    const project = freshRoot("scaffold-neutral-");
    const { io } = captureIo();

    await depositNeutralization(project, io);

    expect(readFileSync(join(project, ".gitattributes"), "utf8")).toContain(
      ".deft/core/** text eol=lf",
    );
    expect(readFileSync(join(project, "greptile.json"), "utf8")).toContain(".deft/core/**");
    expect(readFileSync(join(project, ".github/codeql/codeql-config.yml"), "utf8")).toContain(
      "paths-ignore",
    );
    const guard = readFileSync(join(project, ".github/workflows/deft-core-guard.yml"), "utf8");
    expect(extractCoreGuardCheckoutUsesLine(guard)).toBe(coreGuardCheckoutUsesLine());
    // Content-aware pin unit (#3193) deposited with the path allowlist (#3127).
    expect(guard).toContain("#3193");
    expect(guard).toContain("python3 -");
    expect(guard).toContain("@deftai/directive");
    expect(guard).toContain("package-lock.json");
    expect(guard).toContain("pnpm-lock.yaml");
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

  it("repairs old .gitattributes entries with the LF pin", () => {
    const project = freshRoot("scaffold-gitattributes-lf-");
    const { io } = captureIo();
    writeFileSync(
      join(project, ".gitattributes"),
      ".deft/core/** linguist-generated=true\n.deft/core/** linguist-vendored=true\n",
      "utf8",
    );

    expect(ensureGitattributes(project, io)).toBe(true);
    const attrs = readFileSync(join(project, ".gitattributes"), "utf8");
    expect(attrs).toContain(".deft/core/** text eol=lf");
    expect(attrs.match(/linguist-generated=true/g) ?? []).toHaveLength(1);
    expect(attrs.match(/linguist-vendored=true/g) ?? []).toHaveLength(1);
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

  describe("deft-core-guard checkout pin (#1672)", () => {
    it("deposits a commit-SHA checkout pin on greenfield guard creation", () => {
      const project = freshRoot("scaffold-guard-sha-");
      const { io } = captureIo();
      expect(ensureCoreGuardWorkflow(project, io)).toBe(true);
      const guard = readFileSync(join(project, ".github/workflows/deft-core-guard.yml"), "utf8");
      expect(guard).toContain(coreGuardCheckoutUsesLine());
      expect(extractCoreGuardCheckoutUsesLine(guard)).toBe(coreGuardCheckoutUsesLine());
    });

    it("preserves a Dependabot-bumped checkout pin on refresh", () => {
      const project = freshRoot("scaffold-guard-preserve-");
      mkdirSync(join(project, ".github/workflows"), { recursive: true });
      const bumped =
        "name: deft-core-guard\n\non:\n  pull_request:\n\njobs:\n" +
        "  no-mixed-core-and-app:\n    runs-on: ubuntu-latest\n    steps:\n" +
        "      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3\n" +
        "        with:\n          fetch-depth: 0\n" +
        "      - name: Refuse PRs that mix .deft/core/** with non-framework paths\n" +
        "        run: echo stale-body\n";
      writeFileSync(join(project, ".github/workflows/deft-core-guard.yml"), bumped, "utf8");
      const { io } = captureIo();
      expect(ensureCoreGuardWorkflow(project, io)).toBe(true);
      const guard = readFileSync(join(project, ".github/workflows/deft-core-guard.yml"), "utf8");
      expect(extractCoreGuardCheckoutUsesLine(guard)).toBe(
        "      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3",
      );
      expect(guard).toContain("deft-core guard (#1430)");
      expect(guard).not.toContain("echo stale-body");
    });

    it("migrates a legacy framework @v4 pin to the SHA template on refresh", () => {
      const project = freshRoot("scaffold-guard-migrate-v4-");
      mkdirSync(join(project, ".github/workflows"), { recursive: true });
      const legacy =
        "name: deft-core-guard\n\non:\n  pull_request:\n\njobs:\n" +
        "  no-mixed-core-and-app:\n    runs-on: ubuntu-latest\n    steps:\n" +
        "      - uses: actions/checkout@v4\n" +
        "        with:\n          fetch-depth: 0\n" +
        "      - name: Refuse PRs that mix .deft/core/** with non-framework paths\n" +
        "        run: echo stale-body\n";
      writeFileSync(join(project, ".github/workflows/deft-core-guard.yml"), legacy, "utf8");
      const { io } = captureIo();
      expect(ensureCoreGuardWorkflow(project, io)).toBe(true);
      const guard = readFileSync(join(project, ".github/workflows/deft-core-guard.yml"), "utf8");
      expect(extractCoreGuardCheckoutUsesLine(guard)).toBe(coreGuardCheckoutUsesLine());
      expect(guard).not.toContain("actions/checkout@v4");
    });

    it("mergeCoreGuardWorkflowRefresh keeps the existing pin when only checkout differs", () => {
      const existing =
        "steps:\n" +
        "      - uses: actions/checkout@v6\n" +
        "        with:\n          fetch-depth: 0\n" +
        "      - name: step\n        run: old\n";
      const desired =
        "steps:\n" +
        `${coreGuardCheckoutUsesLine()}\n` +
        "        with:\n          fetch-depth: 0\n" +
        "      - name: step\n        run: new\n";
      const merged = mergeCoreGuardWorkflowRefresh(existing, desired);
      expect(extractCoreGuardCheckoutUsesLine(merged)).toBe("      - uses: actions/checkout@v6");
      expect(merged).toContain("run: new");
    });

    it("shouldPreserveCoreGuardCheckoutPin rejects legacy @v4 but accepts consumer bumps", () => {
      const desired = coreGuardCheckoutUsesLine();
      expect(shouldPreserveCoreGuardCheckoutPin("      - uses: actions/checkout@v4", desired)).toBe(
        false,
      );
      expect(
        shouldPreserveCoreGuardCheckoutPin(
          "      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3",
          desired,
        ),
      ).toBe(true);
      expect(shouldPreserveCoreGuardCheckoutPin("      - uses: actions/checkout@v6", desired)).toBe(
        true,
      );
    });
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
