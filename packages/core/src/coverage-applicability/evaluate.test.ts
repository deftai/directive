import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DIRECT_WRITE_HOOK_MATCHER,
  KILL_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
} from "../hooks/tools.js";
import {
  CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
  CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS,
} from "../init-deposit/agent-hooks.js";
import {
  isClosedPlanSequenceShape,
  PLAN_SEQUENCE_CONTRACT,
  PLAN_SEQUENCE_REL_PATH,
} from "../plan-sequence/types.js";
import { COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP } from "../pre-pr-controller/phases.js";
import {
  classifyChangedPath,
  decodeGitQuotedPath,
  evaluateCoverageApplicability,
  isCoverageHeadroomNotApplicable,
  isPlanInterviewContinuationRefreshOnly,
  isProjectDefinitionRegistryRefreshOnly,
  isSpecificationNarrativeRefreshOnly,
  parseNameStatus,
} from "./evaluate.js";

const AGGREGATE_IT_TIMEOUT = process.platform === "win32" ? 240_000 : 120_000;

const CURSOR_MATCHERS = [
  DIRECT_WRITE_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  KILL_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
] as const;

function canonicalCursorRegistration(extras?: { readonly customSession?: unknown }): string {
  const sessionStart: unknown[] = [
    {
      command: "deft-hook --host cursor --event session.start",
      timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
    },
  ];
  if (extras?.customSession !== undefined) sessionStart.unshift(extras.customSession);
  return `${JSON.stringify(
    {
      version: 1,
      hooks: {
        sessionStart,
        preToolUse: CURSOR_MATCHERS.map((matcher) => ({
          command: "deft-hook --host cursor --event tool.before",
          matcher,
          failClosed: true,
          timeout: CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS,
        })),
        preCompact: [
          {
            command: "deft-hook --host cursor --event session.compact",
            timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
          },
        ],
        beforeSubmitPrompt: [
          {
            command: "deft-hook --host cursor --event prompt.submit",
            timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
          },
        ],
        afterAgentResponse: [
          {
            command: "deft-hook --host cursor --event agent.response",
            timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

const PROJECT_DEF_PATH = "xbrief/PROJECT-DEFINITION.xbrief.json";

function projectDefDoc(options: {
  readonly items?: unknown[];
  readonly updated?: string;
  readonly stalenessFlags?: string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly policy?: unknown;
  readonly extraPlan?: Record<string, unknown>;
  readonly infoRoot?: "xBRIEFInfo" | "vBRIEFInfo";
}): string {
  const infoRoot = options.infoRoot ?? "xBRIEFInfo";
  const plan: Record<string, unknown> = {
    title: "Consumer",
    status: "active",
    items: options.items ?? [],
    ...(options.extraPlan ?? {}),
  };
  if (options.policy !== undefined) {
    plan.policy = options.policy;
  }
  if (options.metadata !== undefined) {
    plan.metadata = options.metadata;
  } else if (options.stalenessFlags !== undefined) {
    plan.metadata = { staleness_flags: options.stalenessFlags };
  }
  return `${JSON.stringify(
    {
      [infoRoot]: { version: "0.8", updated: options.updated ?? "2026-10-01T00:00:00Z" },
      plan,
    },
    null,
    2,
  )}\n`;
}

function registryItem(
  id: string,
  extras?: { readonly unknownMeta?: boolean; readonly refs?: unknown[] },
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    source_path: `proposed/${id}.xbrief.json`,
    lifecycle_folder: "proposed",
  };
  if (extras?.refs) metadata.references = extras.refs;
  if (extras?.unknownMeta) metadata.executable = "rm -rf /";
  return { id, title: id, status: "draft", metadata };
}
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function gitRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cov-app-"));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  childProcess.execFileSync("git", ["init", "-q"], { cwd: root });
  childProcess.execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: root });
  childProcess.execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
  childProcess.execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
  return root;
}

function bindingFor(
  root: string,
  baseSha: string,
): {
  projectRoot: string;
  baseSha: string;
  headSha: string;
  treeHash: string;
} {
  const headSha = childProcess
    .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
    .trim();
  const treeHash = childProcess
    .execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" })
    .trim();
  return { projectRoot: root, baseSha, headSha, treeHash };
}

describe("classifyChangedPath", () => {
  it("classifies executable and config paths as coverable", () => {
    expect(classifyChangedPath("packages/core/src/foo.ts", "M", null)).toBe("coverable");
    expect(classifyChangedPath("src/Program.cs", "A", null)).toBe("coverable");
    expect(classifyChangedPath("package.json", "M", null)).toBe("coverable");
    expect(classifyChangedPath(".github/workflows/ci.yml", "M", null)).toBe("coverable");
    expect(classifyChangedPath("vitest.config.ts", "M", null)).toBe("coverable");
  });

  it("classifies planning/docs paths as inert under closed rules", () => {
    expect(classifyChangedPath("docs/design/overview.md", "A", null)).toBe("inert");
    expect(classifyChangedPath("xbrief/proposed/story.xbrief.json", "A", null)).toBe("inert");
    expect(classifyChangedPath("xbrief/decisions/d1.json", "A", null)).toBe("inert");
    expect(classifyChangedPath("CHANGELOG.md", "M", null)).toBe("inert");
    expect(classifyChangedPath("content/packs/skills/skills-pack-0.1.json", "M", null)).toBe(
      "inert",
    );
  });

  it("keeps MDX/HTML coverable (executable embeds; never inert N/A)", () => {
    expect(classifyChangedPath("docs/guide.mdx", "A", null)).toBe("coverable");
    expect(classifyChangedPath("src/pages/index.mdx", "M", null)).toBe("coverable");
    expect(classifyChangedPath("index.html", "M", null)).toBe("coverable");
    expect(classifyChangedPath("docs/page.htm", "A", null)).toBe("coverable");
  });

  it("keeps live xbrief settings coverable (not inert planning prose)", () => {
    expect(classifyChangedPath("xbrief/PROJECT-DEFINITION.xbrief.json", "M", null)).toBe(
      "coverable",
    );
    expect(classifyChangedPath("xbrief/plan.xbrief.json", "M", null)).toBe("coverable");
    expect(classifyChangedPath("xbrief/specification.xbrief.json", "M", null)).toBe("coverable");
  });

  it("does not treat arbitrary json as inherently inert", () => {
    expect(classifyChangedPath("mystery/data.bin", "A", null)).toBe("unknown");
    expect(classifyChangedPath("config/unknown.dat", "M", null)).toBe("unknown");
  });

  it("classifies coverage tool output as inert measurement artifacts", () => {
    expect(classifyChangedPath("coverage/coverage-final.json", "A", null)).toBe("inert");
    expect(classifyChangedPath("coverage/lcov.info", "M", null)).toBe("inert");
  });

  it("classifies Bun locks coverable and .gitignore / fixtures JSON inert (#5541)", () => {
    expect(classifyChangedPath("bun.lock", "M", null)).toBe("coverable");
    expect(classifyChangedPath("bun.lockb", "A", null)).toBe("coverable");
    expect(classifyChangedPath("fixtures/bun.lock", "M", null)).toBe("coverable");
    expect(classifyChangedPath("fixtures/package.json", "M", null)).toBe("coverable");
    expect(classifyChangedPath("fixtures/helper.ts", "A", null)).toBe("coverable");
    expect(classifyChangedPath("fixtures/page.html", "M", null)).toBe("coverable");
    expect(classifyChangedPath("fixtures/guide.mdx", "A", null)).toBe("coverable");
    expect(classifyChangedPath(".gitignore", "M", null)).toBe("inert");
    expect(classifyChangedPath("fixtures/catalog.json", "A", null)).toBe("inert");
    expect(classifyChangedPath("fixtures/nested/data.json", "M", null)).toBe("inert");
    // Negatives stay unknown: peer ignores, non-fixtures JSON, mystery binaries.
    expect(classifyChangedPath(".customignore", "M", null)).toBe("unknown");
    expect(classifyChangedPath(".dockerignore", "M", null)).toBe("unknown");
    expect(classifyChangedPath("config/settings.json", "A", null)).toBe("unknown");
    expect(classifyChangedPath("packages/core/fixtures/data.json", "A", null)).toBe("unknown");
    expect(classifyChangedPath("fixtures/data.yaml", "A", null)).toBe("unknown");
    expect(classifyChangedPath("mystery.bin", "A", null)).toBe("unknown");
  });

  it("classifies Prefer-A limb-1 managed stamps/ledger inert and keeps peers unknown (#5665)", () => {
    expect(classifyChangedPath(".deft/GENERATION.json", "A", null)).toBe("inert");
    expect(classifyChangedPath(".deft/GENERATION.json", "M", null)).toBe("inert");
    expect(classifyChangedPath("meta/policy-changes.log", "A", null)).toBe("inert");
    expect(classifyChangedPath("meta/policy-changes.log", "M", null)).toBe("inert");
    expect(classifyChangedPath("xbrief/.deft-version", "A", null)).toBe("inert");
    expect(classifyChangedPath(".deft-version", "M", null)).toBe("inert");
    expect(classifyChangedPath("vbrief/.deft-version", "A", null)).toBe("inert");
    // Keep-unknown: authority/membership and non-listed peers (no blanket .deft/ or meta/).
    expect(classifyChangedPath(".deft/approved-scope/x.json", "A", null)).toBe("unknown");
    expect(classifyChangedPath(".deft/other.json", "A", null)).toBe("unknown");
    expect(classifyChangedPath(".deft/plan-sequence.json", "A", null)).toBe("unknown");
    expect(classifyChangedPath("meta/other.log", "M", null)).toBe("unknown");
  });

  it("classifies exact VERSION + lifecycle gitkeep inert; keeps run/approved-scope unknown (#5674)", () => {
    expect(classifyChangedPath(".deft/core/VERSION", "A", null)).toBe("inert");
    expect(classifyChangedPath(".deft/core/VERSION", "M", null)).toBe("inert");
    for (const root of ["xbrief", "vbrief"] as const) {
      for (const sub of ["proposed", "pending", "active", "completed", "cancelled"] as const) {
        expect(classifyChangedPath(`${root}/${sub}/.gitkeep`, "A", null)).toBe("inert");
      }
    }
    // Path-level keep-unknown; #5677 owns content-bound run D + registration proofs.
    expect(classifyChangedPath(".deft/core/run", "A", null)).toBe("unknown");
    expect(classifyChangedPath(".deft/core/run/hooks.json", "M", null)).toBe("unknown");
    expect(classifyChangedPath(".deft/approved-scope/x.json", "A", null)).toBe("unknown");
    expect(classifyChangedPath(".deft/core/payload.bin", "A", null)).toBe("unknown");
  });

  it("classifies CODEQL + HOOK_FILENAMES inert; keeps support/adapters coverable (#5677)", () => {
    expect(classifyChangedPath(".github/codeql/codeql-config.yml", "M", null)).toBe("inert");
    expect(classifyChangedPath(".githooks/pre-commit", "M", null)).toBe("inert");
    expect(classifyChangedPath(".githooks/pre-push", "A", null)).toBe("inert");
    // HOOK_SUPPORT + adapters/wrapper stay coverable under coverable-first.
    expect(classifyChangedPath(".githooks/_directive-run.sh", "M", null)).toBe("coverable");
    expect(classifyChangedPath(".cursor/hooks/deft-cursor-hook-adapter.mjs", "M", null)).toBe(
      "coverable",
    );
    expect(classifyChangedPath(".cursor/hooks/deft-cursor-hook-adapter.test.mjs", "A", null)).toBe(
      "coverable",
    );
    expect(classifyChangedPath(".grok/hooks/deft-pretooluse-wrapper.sh", "M", null)).toBe(
      "coverable",
    );
    expect(classifyChangedPath(".cursor/hooks/custom.js", "A", null)).toBe("coverable");
    expect(classifyChangedPath(".githooks/extra-hook", "M", null)).toBe("unknown");
    expect(classifyChangedPath(".cursor/hooks.json", "M", null)).toBe("unknown");
  });
});

describe("parseNameStatus", () => {
  it("keeps rename old and new paths", () => {
    expect(parseNameStatus("R100\told.ts\tnew.md\nA\tdocs/a.md\n")).toEqual([
      { status: "R100", oldPath: "old.ts", path: "new.md" },
      { status: "A", oldPath: null, path: "docs/a.md" },
    ]);
  });

  it("parses NUL-separated -z output and decodes quoted fallbacks", () => {
    expect(parseNameStatus("A\0docs/a.md\0R100\0old.ts\0new.md\0")).toEqual([
      { status: "A", oldPath: null, path: "docs/a.md" },
      { status: "R100", oldPath: "old.ts", path: "new.md" },
    ]);
    expect(decodeGitQuotedPath('"docs/caf\\303\\251.md"')).toBe("docs/café.md");
    expect(parseNameStatus('A\t"docs/caf\\303\\251.md"\n')).toEqual([
      { status: "A", oldPath: null, path: "docs/café.md" },
    ]);
  });
});

describe("evaluateCoverageApplicability", () => {
  it("returns not-applicable for an inert refinement-only diff", () => {
    const root = gitRepo({ "README.md": "# base\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/design.md"), "# design\n");
    mkdirSync(join(root, "xbrief/decisions"), { recursive: true });
    mkdirSync(join(root, "xbrief/proposed"), { recursive: true });
    writeFileSync(join(root, "xbrief/decisions/d1.json"), "{}\n");
    writeFileSync(join(root, "xbrief/proposed/story.xbrief.json"), "{}\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "refinement"], { cwd: root });
    const result = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(result.outcome).toBe("not-applicable");
    if (result.outcome === "not-applicable") {
      expect(result.reason).toBe(COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP);
    }
  });

  it("returns applicable when any path is coverable", () => {
    const root = gitRepo({ "README.md": "# base\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export const n = 1;\n");
    writeFileSync(join(root, "docs/note.md"), "note\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "mixed"], { cwd: root });
    const result = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(result.outcome).toBe("applicable");
    if (result.outcome === "applicable") {
      expect(result.coverablePaths).toContain("src/app.ts");
    }
  });

  it("refuses unknown paths, empty selection, invalid base, and rename-to-document", () => {
    const root = gitRepo({ "README.md": "# base\n", "src/a.ts": "export const a = 1;\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();

    writeFileSync(join(root, "mystery.bin"), "x");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "unknown"], { cwd: root });
    expect(evaluateCoverageApplicability(bindingFor(root, baseSha)).outcome).toBe("refuse");

    const empty = evaluateCoverageApplicability({
      ...bindingFor(root, baseSha),
      baseSha,
      headSha: baseSha,
      treeHash: childProcess
        .execFileSync("git", ["rev-parse", `${baseSha}^{tree}`], {
          cwd: root,
          encoding: "utf8",
        })
        .trim(),
    });
    expect(empty.outcome).toBe("refuse");
    if (empty.outcome === "refuse") expect(empty.code).toBe("empty-selection");

    expect(
      evaluateCoverageApplicability({
        ...bindingFor(root, baseSha),
        baseSha: "not-a-real-sha",
      }).outcome,
    ).toBe("refuse");

    const renameRoot = gitRepo({ "src/code.ts": "export const c = 1;\n" });
    const renameHead = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: renameRoot, encoding: "utf8" })
      .trim();
    const renameBind = bindingFor(renameRoot, renameHead);
    const renamed = evaluateCoverageApplicability(renameBind, {
      runGit: (args) => {
        const joined = args.join(" ");
        if (joined.includes("^{tree}")) return { ok: true as const, stdout: renameBind.treeHash };
        if (joined.includes("rev-parse")) return { ok: true as const, stdout: renameBind.headSha };
        if (joined.includes("name-status")) {
          return { ok: true as const, stdout: "R100\tsrc/code.ts\tdocs/code.md\n" };
        }
        return { ok: true as const, stdout: "" };
      },
    });
    expect(renamed.outcome).toBe("refuse");
    if (renamed.outcome === "refuse") expect(renamed.code).toBe("rename-to-document");

    const unknownRename = evaluateCoverageApplicability(renameBind, {
      runGit: (args) => {
        const joined = args.join(" ");
        if (joined.includes("^{tree}")) return { ok: true as const, stdout: renameBind.treeHash };
        if (joined.includes("rev-parse")) return { ok: true as const, stdout: renameBind.headSha };
        if (joined.includes("name-status")) {
          return { ok: true as const, stdout: "R100\tmystery.bin\tdocs/guide.md\n" };
        }
        return { ok: true as const, stdout: "" };
      },
    });
    expect(unknownRename.outcome).toBe("refuse");
    if (unknownRename.outcome === "refuse") expect(unknownRename.code).toBe("rename-to-document");
  });

  it("refuses a treeHash that does not match the reviewed head", () => {
    const root = gitRepo({ "docs/a.md": "a\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    writeFileSync(join(root, "docs/b.md"), "b\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "b"], { cwd: root });
    const head = bindingFor(root, baseSha);
    const stale = evaluateCoverageApplicability({
      ...head,
      treeHash: "0".repeat(40),
    });
    expect(stale.outcome).toBe("refuse");
    if (stale.outcome === "refuse") expect(stale.code).toBe("tree-mismatch");
  });

  it("refuses when the working tree is dirty relative to the bound head", () => {
    const root = gitRepo({ "README.md": "# base\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/design.md"), "# design\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "docs"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export const n = 1;\n");
    const dirty = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(dirty.outcome).toBe("refuse");
    if (dirty.outcome === "refuse") expect(dirty.code).toBe("dirty-tree");
  });

  it("keeps committed unknown-path refuse ahead of dirty-tree", () => {
    const root = gitRepo({ "README.md": "# base\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    writeFileSync(join(root, "mystery.bin"), "x");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "unknown"], { cwd: root });
    writeFileSync(join(root, "docs-note.md"), "note\n");
    const result = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(result.outcome).toBe("refuse");
    if (result.outcome === "refuse") expect(result.code).toBe("unknown-path");
  });

  it("ignores caller-style path filters (not an input) and uses status-aware enumeration", () => {
    const root = gitRepo({ "README.md": "# base\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "src/secret.ts"), "export const s = 1;\n");
    writeFileSync(join(root, "docs/only.md"), "docs\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "filtered-mixed"], { cwd: root });
    // No pathFilter input exists on the evaluator — mixed coverable still applicable.
    const result = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(result.outcome).toBe("applicable");
  });

  it("demotes PROJECT-DEFINITION registry/timestamp/flags refresh to not-applicable (#5479)", () => {
    const root = gitRepo({
      "README.md": "# base\n",
      [PROJECT_DEF_PATH]: projectDefDoc({
        items: [],
        updated: "2026-10-01T00:00:00Z",
        // no metadata yet — first-time staleness_flags create
      }),
    });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    writeFileSync(
      join(root, PROJECT_DEF_PATH),
      projectDefDoc({
        items: [registryItem("story-a")],
        updated: "2026-10-09T12:00:00Z",
        stalenessFlags: [],
      }),
    );
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/design.md"), "# design\n");
    mkdirSync(join(root, "xbrief/proposed"), { recursive: true });
    writeFileSync(join(root, "xbrief/proposed/story-a.xbrief.json"), "{}\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "registry-refresh"], { cwd: root });
    const result = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(result.outcome).toBe("not-applicable");
    if (result.outcome === "not-applicable") {
      expect(result.reason).toBe(COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP);
      const pd = result.changes.find((c) => c.path === PROJECT_DEF_PATH);
      expect(pd?.classification).toBe("inert");
      expect(pd?.status).toBe("M");
    }
  });

  it("keeps PROJECT-DEFINITION policy edits applicable (#5479)", () => {
    const root = gitRepo({
      [PROJECT_DEF_PATH]: projectDefDoc({
        items: [],
        updated: "2026-10-01T00:00:00Z",
        stalenessFlags: [],
        policy: { wipCap: 20 },
      }),
    });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    writeFileSync(
      join(root, PROJECT_DEF_PATH),
      projectDefDoc({
        items: [registryItem("story-a")],
        updated: "2026-10-09T12:00:00Z",
        stalenessFlags: [],
        policy: { wipCap: 5 },
      }),
    );
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "policy"], { cwd: root });
    const result = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(result.outcome).toBe("applicable");
  });

  it("refuses demotion on unknown nested metadata and malformed JSON (#5479)", () => {
    const unknownMeta = evaluateCoverageApplicability(
      {
        projectRoot: "/tmp",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        requireTreeMatch: false,
      },
      {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: `M\t${PROJECT_DEF_PATH}\n` };
          }
          if (joined.includes("status")) return { ok: true as const, stdout: "" };
          if (joined.includes("show") && joined.includes("base:")) {
            return {
              ok: true as const,
              stdout: projectDefDoc({ items: [], stalenessFlags: [] }),
            };
          }
          if (joined.includes("show")) {
            return {
              ok: true as const,
              stdout: projectDefDoc({
                items: [registryItem("x", { unknownMeta: true })],
                updated: "2026-10-09T12:00:00Z",
                stalenessFlags: [],
              }),
            };
          }
          return { ok: true as const, stdout: "base" };
        },
      },
    );
    expect(unknownMeta.outcome).toBe("applicable");

    const malformed = evaluateCoverageApplicability(
      {
        projectRoot: "/tmp",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        requireTreeMatch: false,
      },
      {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: `M\t${PROJECT_DEF_PATH}\n` };
          }
          if (joined.includes("status")) return { ok: true as const, stdout: "" };
          if (joined.includes("show") && joined.includes("base:")) {
            return { ok: true as const, stdout: projectDefDoc({ items: [], stalenessFlags: [] }) };
          }
          if (joined.includes("show")) return { ok: true as const, stdout: "{not-json" };
          return { ok: true as const, stdout: "base" };
        },
      },
    );
    expect(malformed.outcome).toBe("applicable");
  });

  it("does not demote A/D/R PROJECT-DEFINITION without M proof (#5479)", () => {
    const added = evaluateCoverageApplicability(
      {
        projectRoot: "/tmp",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        requireTreeMatch: false,
      },
      {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: `A\t${PROJECT_DEF_PATH}\n` };
          }
          if (joined.includes("status")) return { ok: true as const, stdout: "" };
          return { ok: true as const, stdout: "base" };
        },
      },
    );
    expect(added.outcome).toBe("applicable");
  });

  it("keeps mixed src/*.ts with registry refresh applicable (#5479)", () => {
    const root = gitRepo({
      "README.md": "# base\n",
      [PROJECT_DEF_PATH]: projectDefDoc({ items: [], stalenessFlags: [] }),
    });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    writeFileSync(
      join(root, PROJECT_DEF_PATH),
      projectDefDoc({
        items: [registryItem("story-a")],
        updated: "2026-10-09T12:00:00Z",
        stalenessFlags: ["review"],
      }),
    );
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export const n = 1;\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "mixed"], { cwd: root });
    const result = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(result.outcome).toBe("applicable");
    if (result.outcome === "applicable") {
      expect(result.coverablePaths).toContain("src/app.ts");
    }
  });

  it(
    "aggregates Bun lock applicable and fixtures/.gitignore N/A (#5541)",
    () => {
      const bunRoot = gitRepo({ "README.md": "# base\n" });
      const bunBase = childProcess
        .execFileSync("git", ["rev-parse", "HEAD"], { cwd: bunRoot, encoding: "utf8" })
        .trim();
      writeFileSync(join(bunRoot, "bun.lock"), "lock\n");
      writeFileSync(join(bunRoot, "bun.lockb"), "binary\n");
      mkdirSync(join(bunRoot, "docs"), { recursive: true });
      writeFileSync(join(bunRoot, "docs/note.md"), "note\n");
      childProcess.execFileSync("git", ["add", "-A"], { cwd: bunRoot });
      childProcess.execFileSync("git", ["commit", "-q", "-m", "bun-locks"], { cwd: bunRoot });
      const bunResult = evaluateCoverageApplicability(bindingFor(bunRoot, bunBase));
      expect(bunResult.outcome).toBe("applicable");
      if (bunResult.outcome === "applicable") {
        expect(bunResult.coverablePaths).toEqual(expect.arrayContaining(["bun.lock", "bun.lockb"]));
      }

      const inertRoot = gitRepo({ "README.md": "# base\n" });
      const inertBase = childProcess
        .execFileSync("git", ["rev-parse", "HEAD"], { cwd: inertRoot, encoding: "utf8" })
        .trim();
      writeFileSync(join(inertRoot, ".gitignore"), "node_modules/\n");
      mkdirSync(join(inertRoot, "fixtures"), { recursive: true });
      writeFileSync(join(inertRoot, "fixtures/catalog.json"), "{}\n");
      mkdirSync(join(inertRoot, "docs"), { recursive: true });
      writeFileSync(join(inertRoot, "docs/design.md"), "# design\n");
      childProcess.execFileSync("git", ["add", "-A"], { cwd: inertRoot });
      childProcess.execFileSync("git", ["commit", "-q", "-m", "inert-ordinary"], {
        cwd: inertRoot,
      });
      const inertResult = evaluateCoverageApplicability(bindingFor(inertRoot, inertBase));
      expect(inertResult.outcome).toBe("not-applicable");
      if (inertResult.outcome === "not-applicable") {
        expect(inertResult.reason).toBe(COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP);
      }

      const unknownRoot = gitRepo({ "README.md": "# base\n" });
      const unknownBase = childProcess
        .execFileSync("git", ["rev-parse", "HEAD"], { cwd: unknownRoot, encoding: "utf8" })
        .trim();
      mkdirSync(join(unknownRoot, "config"), { recursive: true });
      writeFileSync(join(unknownRoot, "config/settings.json"), "{}\n");
      writeFileSync(join(unknownRoot, ".customignore"), "tmp/\n");
      childProcess.execFileSync("git", ["add", "-A"], { cwd: unknownRoot });
      childProcess.execFileSync("git", ["commit", "-q", "-m", "unknown-ordinary"], {
        cwd: unknownRoot,
      });
      const unknownResult = evaluateCoverageApplicability(bindingFor(unknownRoot, unknownBase));
      expect(unknownResult.outcome).toBe("refuse");
      if (unknownResult.outcome === "refuse") expect(unknownResult.code).toBe("unknown-path");
    },
    AGGREGATE_IT_TIMEOUT,
  );

  it(
    "aggregates limb-1 stamp/ledger subsets N/A, coverable mix applicable, unknown peer refuse (#5665)",
    () => {
      const limb1Paths = [
        ".deft/GENERATION.json",
        "meta/policy-changes.log",
        "xbrief/.deft-version",
        ".deft-version",
        "vbrief/.deft-version",
      ] as const;

      const freshRoot = gitRepo({ "README.md": "# base\n" });
      const freshBase = childProcess
        .execFileSync("git", ["rev-parse", "HEAD"], { cwd: freshRoot, encoding: "utf8" })
        .trim();
      mkdirSync(join(freshRoot, ".deft"), { recursive: true });
      mkdirSync(join(freshRoot, "meta"), { recursive: true });
      mkdirSync(join(freshRoot, "xbrief"), { recursive: true });
      mkdirSync(join(freshRoot, "vbrief"), { recursive: true });
      mkdirSync(join(freshRoot, "docs"), { recursive: true });
      mkdirSync(join(freshRoot, "fixtures"), { recursive: true });
      writeFileSync(join(freshRoot, ".deft/GENERATION.json"), '{"generation":1}\n');
      writeFileSync(join(freshRoot, "meta/policy-changes.log"), "policy\n");
      writeFileSync(join(freshRoot, "xbrief/.deft-version"), "0.125.2\n");
      writeFileSync(join(freshRoot, ".deft-version"), "0.125.2\n");
      writeFileSync(join(freshRoot, "vbrief/.deft-version"), "0.125.2\n");
      writeFileSync(join(freshRoot, "docs/note.md"), "note\n");
      writeFileSync(join(freshRoot, "fixtures/catalog.json"), "{}\n");
      childProcess.execFileSync("git", ["add", "-A"], { cwd: freshRoot });
      childProcess.execFileSync("git", ["commit", "-q", "-m", "limb1-fresh"], { cwd: freshRoot });
      const freshResult = evaluateCoverageApplicability(bindingFor(freshRoot, freshBase));
      expect(freshResult.outcome).toBe("not-applicable");
      if (freshResult.outcome === "not-applicable") {
        expect(freshResult.reason).toBe(COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP);
        for (const path of limb1Paths) {
          expect(freshResult.changes.find((c) => c.path === path)?.classification).toBe("inert");
        }
      }

      const upgradeRoot = gitRepo({
        "README.md": "# base\n",
        ".deft/GENERATION.json": '{"generation":1}\n',
        "meta/policy-changes.log": "old\n",
        "xbrief/.deft-version": "0.125.0\n",
        ".deft-version": "0.125.0\n",
        "vbrief/.deft-version": "0.125.0\n",
      });
      const upgradeBase = childProcess
        .execFileSync("git", ["rev-parse", "HEAD"], { cwd: upgradeRoot, encoding: "utf8" })
        .trim();
      writeFileSync(join(upgradeRoot, ".deft/GENERATION.json"), '{"generation":2}\n');
      writeFileSync(join(upgradeRoot, "meta/policy-changes.log"), "old\nnew\n");
      writeFileSync(join(upgradeRoot, "xbrief/.deft-version"), "0.125.2\n");
      writeFileSync(join(upgradeRoot, ".deft-version"), "0.125.2\n");
      writeFileSync(join(upgradeRoot, "vbrief/.deft-version"), "0.125.2\n");
      mkdirSync(join(upgradeRoot, "docs"), { recursive: true });
      writeFileSync(join(upgradeRoot, "docs/upgrade.md"), "upgrade\n");
      childProcess.execFileSync("git", ["add", "-A"], { cwd: upgradeRoot });
      childProcess.execFileSync("git", ["commit", "-q", "-m", "limb1-upgrade"], {
        cwd: upgradeRoot,
      });
      const upgradeResult = evaluateCoverageApplicability(bindingFor(upgradeRoot, upgradeBase));
      expect(upgradeResult.outcome).toBe("not-applicable");
      if (upgradeResult.outcome === "not-applicable") {
        expect(upgradeResult.reason).toBe(COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP);
      }

      const mixedRoot = gitRepo({ "README.md": "# base\n" });
      const mixedBase = childProcess
        .execFileSync("git", ["rev-parse", "HEAD"], { cwd: mixedRoot, encoding: "utf8" })
        .trim();
      mkdirSync(join(mixedRoot, ".deft"), { recursive: true });
      mkdirSync(join(mixedRoot, "meta"), { recursive: true });
      mkdirSync(join(mixedRoot, "xbrief"), { recursive: true });
      mkdirSync(join(mixedRoot, "src"), { recursive: true });
      writeFileSync(join(mixedRoot, ".deft/GENERATION.json"), '{"generation":1}\n');
      writeFileSync(join(mixedRoot, "meta/policy-changes.log"), "policy\n");
      writeFileSync(join(mixedRoot, "xbrief/.deft-version"), "0.125.2\n");
      writeFileSync(join(mixedRoot, "bun.lock"), "lock\n");
      writeFileSync(join(mixedRoot, "src/app.ts"), "export const n = 1;\n");
      childProcess.execFileSync("git", ["add", "-A"], { cwd: mixedRoot });
      childProcess.execFileSync("git", ["commit", "-q", "-m", "limb1-mixed"], { cwd: mixedRoot });
      const mixedResult = evaluateCoverageApplicability(bindingFor(mixedRoot, mixedBase));
      expect(mixedResult.outcome).toBe("applicable");
      if (mixedResult.outcome === "applicable") {
        expect(mixedResult.coverablePaths).toEqual(
          expect.arrayContaining(["src/app.ts", "bun.lock"]),
        );
        expect(
          mixedResult.changes.find((c) => c.path === ".deft/GENERATION.json")?.classification,
        ).toBe("inert");
        expect(
          mixedResult.changes.find((c) => c.path === "meta/policy-changes.log")?.classification,
        ).toBe("inert");
        expect(
          mixedResult.changes.find((c) => c.path === "xbrief/.deft-version")?.classification,
        ).toBe("inert");
      }

      const refuseRoot = gitRepo({ "README.md": "# base\n" });
      const refuseBase = childProcess
        .execFileSync("git", ["rev-parse", "HEAD"], { cwd: refuseRoot, encoding: "utf8" })
        .trim();
      mkdirSync(join(refuseRoot, ".deft"), { recursive: true });
      mkdirSync(join(refuseRoot, "meta"), { recursive: true });
      writeFileSync(join(refuseRoot, ".deft/GENERATION.json"), '{"generation":1}\n');
      writeFileSync(join(refuseRoot, "meta/policy-changes.log"), "policy\n");
      writeFileSync(join(refuseRoot, "meta/other.log"), "peer\n");
      childProcess.execFileSync("git", ["add", "-A"], { cwd: refuseRoot });
      childProcess.execFileSync("git", ["commit", "-q", "-m", "limb1-unknown-peer"], {
        cwd: refuseRoot,
      });
      const refuseResult = evaluateCoverageApplicability(bindingFor(refuseRoot, refuseBase));
      expect(refuseResult.outcome).toBe("refuse");
      if (refuseResult.outcome === "refuse") expect(refuseResult.code).toBe("unknown-path");
    },
    AGGREGATE_IT_TIMEOUT,
  );

  it("aggregates VERSION + lifecycle gitkeep as N/A; run peer refuses (#5674)", () => {
    const residualRoot = gitRepo({ "README.md": "# base\n" });
    const residualBase = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: residualRoot, encoding: "utf8" })
      .trim();
    mkdirSync(join(residualRoot, ".deft/core"), { recursive: true });
    writeFileSync(join(residualRoot, ".deft/core/VERSION"), "0.0.0-test\n");
    for (const root of ["xbrief", "vbrief"] as const) {
      for (const sub of ["proposed", "pending", "active", "completed", "cancelled"] as const) {
        mkdirSync(join(residualRoot, root, sub), { recursive: true });
        writeFileSync(join(residualRoot, root, sub, ".gitkeep"), "");
      }
    }
    childProcess.execFileSync("git", ["add", "-A"], { cwd: residualRoot });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "residual-inert"], {
      cwd: residualRoot,
    });
    const residual = evaluateCoverageApplicability(bindingFor(residualRoot, residualBase));
    expect(residual.outcome).toBe("not-applicable");

    const refuseRoot = gitRepo({ "README.md": "# base\n" });
    const refuseBase = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: refuseRoot, encoding: "utf8" })
      .trim();
    mkdirSync(join(refuseRoot, ".deft/core"), { recursive: true });
    writeFileSync(join(refuseRoot, ".deft/core/VERSION"), "0.0.0-test\n");
    writeFileSync(join(refuseRoot, ".deft/core/run"), "keep-unknown\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: refuseRoot });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "run-unknown"], { cwd: refuseRoot });
    const refused = evaluateCoverageApplicability(bindingFor(refuseRoot, refuseBase));
    expect(refused.outcome).toBe("refuse");
    if (refused.outcome === "refuse") expect(refused.code).toBe("unknown-path");
  });
});

describe("isProjectDefinitionRegistryRefreshOnly", () => {
  it("accepts closed refresh set and rejects policy/unknown fields", () => {
    const base = JSON.parse(
      projectDefDoc({ items: [], updated: "2026-10-01T00:00:00Z" }),
    ) as unknown;
    const head = JSON.parse(
      projectDefDoc({
        items: [registryItem("a")],
        updated: "2026-10-09T00:00:00Z",
        stalenessFlags: [],
      }),
    ) as unknown;
    expect(isProjectDefinitionRegistryRefreshOnly(base, head)).toBe(true);

    const withPolicy = JSON.parse(
      projectDefDoc({
        items: [registryItem("a")],
        updated: "2026-10-09T00:00:00Z",
        stalenessFlags: [],
        policy: { wipCap: 1 },
      }),
    ) as unknown;
    expect(isProjectDefinitionRegistryRefreshOnly(base, withPolicy)).toBe(false);

    const unknownItem = JSON.parse(
      projectDefDoc({
        items: [registryItem("a", { unknownMeta: true })],
        updated: "2026-10-09T00:00:00Z",
        stalenessFlags: [],
      }),
    ) as unknown;
    expect(isProjectDefinitionRegistryRefreshOnly(base, unknownItem)).toBe(false);
  });
});

const PLAN_PATH = "xbrief/plan.xbrief.json";
const SPEC_PATH = "xbrief/specification.xbrief.json";

function closedSequenceDoc(overrides?: Record<string, unknown>): string {
  return `${JSON.stringify(
    {
      sequence_id: "phase-a-publication",
      sequence_kind: "delivery",
      entries: [
        { id: "parked-prefix", kind: "pr", status: "completed" },
        { id: "pr:phase-a-refinement", kind: "pr", status: "pending" },
      ],
      current_index: 1,
      batching_allowed: false,
      continuation_past_final: false,
      exhausted: false,
      authorized_by: "operator",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-09T00:00:00Z",
      contract: PLAN_SEQUENCE_CONTRACT,
      ...overrides,
    },
    null,
    2,
  )}\n`;
}

function planDoc(options: {
  readonly updated?: string;
  readonly interviewContinuation?: Record<string, unknown>;
  readonly policy?: unknown;
  readonly extraPlan?: Record<string, unknown>;
}): string {
  const plan: Record<string, unknown> = {
    title: "Work plan",
    status: "active",
    ...(options.extraPlan ?? {}),
  };
  if (options.policy !== undefined) plan.policy = options.policy;
  if (options.interviewContinuation !== undefined) {
    plan["x-directive/interviewContinuation"] = options.interviewContinuation;
  }
  return `${JSON.stringify(
    {
      xBRIEFInfo: { version: "0.8", updated: options.updated ?? "2026-10-01T00:00:00Z" },
      plan,
    },
    null,
    2,
  )}\n`;
}

function specDoc(options: {
  readonly updated?: string;
  readonly narratives?: Record<string, unknown>;
  readonly extraPlan?: Record<string, unknown>;
}): string {
  const plan: Record<string, unknown> = {
    title: "Specification",
    status: "approved",
    ...(options.extraPlan ?? {}),
  };
  if (options.narratives !== undefined) plan.narratives = options.narratives;
  return `${JSON.stringify(
    {
      xBRIEFInfo: { version: "0.8", updated: options.updated ?? "2026-10-01T00:00:00Z" },
      plan,
    },
    null,
    2,
  )}\n`;
}

describe("isClosedPlanSequenceShape (#5551)", () => {
  it("accepts closed shape and refuses parsePlanSequence-soft malformations", () => {
    expect(isClosedPlanSequenceShape(JSON.parse(closedSequenceDoc()))).toBe(true);
    expect(
      isClosedPlanSequenceShape(
        JSON.parse(closedSequenceDoc({ sequence_kind: "not-a-kind", contract: undefined })),
      ),
    ).toBe(false);
    expect(isClosedPlanSequenceShape(JSON.parse(closedSequenceDoc({ current_index: 1.5 })))).toBe(
      false,
    );
    expect(
      isClosedPlanSequenceShape(JSON.parse(closedSequenceDoc({ extra_authority: true }))),
    ).toBe(false);
    expect(isClosedPlanSequenceShape(JSON.parse(closedSequenceDoc({ contract: "forged" })))).toBe(
      false,
    );
  });
});

describe("plan/spec closed-pointer demotion helpers (#5551)", () => {
  it("demotes interviewContinuation allowlist and refuses policy/phase", () => {
    const base = JSON.parse(
      planDoc({
        updated: "2026-10-01T00:00:00Z",
        interviewContinuation: {
          targetDeliverable: "phase-a",
          reopenableDecisionSet: ["a"],
          confirmations: [{ scope: "answer", target: "q1" }],
          phase: "planning-draft-approved",
        },
      }),
    ) as unknown;
    const headOk = JSON.parse(
      planDoc({
        updated: "2026-10-09T00:00:00Z",
        interviewContinuation: {
          targetDeliverable: "phase-a-refinement",
          reopenableDecisionSet: ["a", "b"],
          confirmations: [{ scope: "artifact", target: "plan", revisionId: "r1" }],
          phase: "planning-draft-approved",
        },
      }),
    ) as unknown;
    expect(isPlanInterviewContinuationRefreshOnly(base, headOk)).toBe(true);

    const headPhase = JSON.parse(
      planDoc({
        updated: "2026-10-09T00:00:00Z",
        interviewContinuation: {
          targetDeliverable: "phase-a",
          reopenableDecisionSet: ["a"],
          confirmations: [{ scope: "answer", target: "q1" }],
          phase: "correction-or-gap-review",
        },
      }),
    ) as unknown;
    expect(isPlanInterviewContinuationRefreshOnly(base, headPhase)).toBe(false);

    const headPolicy = JSON.parse(
      planDoc({
        updated: "2026-10-09T00:00:00Z",
        policy: { wipCap: 1 },
        interviewContinuation: {
          targetDeliverable: "phase-a",
          reopenableDecisionSet: ["a"],
          confirmations: [{ scope: "answer", target: "q1" }],
        },
      }),
    ) as unknown;
    expect(isPlanInterviewContinuationRefreshOnly(base, headPolicy)).toBe(false);
  });

  it("demotes Requirements/Design narrative strings and refuses Architecture", () => {
    const base = JSON.parse(
      specDoc({
        updated: "2026-10-01T00:00:00Z",
        narratives: { Requirements: "old", Design: "old", Architecture: "keep" },
      }),
    ) as unknown;
    const headOk = JSON.parse(
      specDoc({
        updated: "2026-10-09T00:00:00Z",
        narratives: { Requirements: "new", Design: "new", Architecture: "keep" },
      }),
    ) as unknown;
    expect(isSpecificationNarrativeRefreshOnly(base, headOk)).toBe(true);

    const headArch = JSON.parse(
      specDoc({
        updated: "2026-10-09T00:00:00Z",
        narratives: { Requirements: "new", Design: "new", Architecture: "changed" },
      }),
    ) as unknown;
    expect(isSpecificationNarrativeRefreshOnly(base, headArch)).toBe(false);
  });

  it("demotes first-time Requirements/Design narratives create and refuses Architecture create", () => {
    const base = JSON.parse(specDoc({ updated: "2026-10-01T00:00:00Z" })) as unknown;
    const headOk = JSON.parse(
      specDoc({
        updated: "2026-10-09T00:00:00Z",
        narratives: { Requirements: "new", Design: "new" },
      }),
    ) as unknown;
    expect(isSpecificationNarrativeRefreshOnly(base, headOk)).toBe(true);

    const headArch = JSON.parse(
      specDoc({
        updated: "2026-10-09T00:00:00Z",
        narratives: { Architecture: "new" },
      }),
    ) as unknown;
    expect(isSpecificationNarrativeRefreshOnly(base, headArch)).toBe(false);

    const headMixed = JSON.parse(
      specDoc({
        updated: "2026-10-09T00:00:00Z",
        narratives: { Requirements: "new", Architecture: "new" },
      }),
    ) as unknown;
    expect(isSpecificationNarrativeRefreshOnly(base, headMixed)).toBe(false);
  });
});

describe("evaluateCoverageApplicability #5551 Prefer-A Bound", { timeout: 30_000 }, () => {
  it("classifies closed-shape plan-sequence A/M as inert N/A (report-absent shape)", () => {
    const root = gitRepo({ "README.md": "# base\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, PLAN_SEQUENCE_REL_PATH), closedSequenceDoc());
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/note.md"), "planning\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "sequence-closed"], { cwd: root });
    const result = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(result.outcome).toBe("not-applicable");
    if (result.outcome === "not-applicable") {
      expect(result.reason).toBe(COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP);
      const seq = result.changes.find((c) => c.path === PLAN_SEQUENCE_REL_PATH);
      expect(seq?.classification).toBe("inert");
      expect(seq?.status).toBe("A");
    }
  });

  it("keeps malformed sequence and approved-scope unknown", () => {
    const malformed = evaluateCoverageApplicability(
      {
        projectRoot: "/tmp",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        requireTreeMatch: false,
      },
      {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: `A\t${PLAN_SEQUENCE_REL_PATH}\n` };
          }
          if (joined.includes("status")) return { ok: true as const, stdout: "" };
          if (joined.includes("show")) {
            return {
              ok: true as const,
              stdout: closedSequenceDoc({ sequence_kind: "forged-kind", contract: undefined }),
            };
          }
          return { ok: true as const, stdout: "base" };
        },
      },
    );
    expect(malformed.outcome).toBe("refuse");
    if (malformed.outcome === "refuse") expect(malformed.code).toBe("unknown-path");

    const approved = evaluateCoverageApplicability(
      {
        projectRoot: "/tmp",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        requireTreeMatch: false,
      },
      {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: "A\t.deft/approved-scope/x.json\n" };
          }
          if (joined.includes("status")) return { ok: true as const, stdout: "" };
          return { ok: true as const, stdout: "base" };
        },
      },
    );
    expect(approved.outcome).toBe("refuse");
    if (approved.outcome === "refuse") expect(approved.code).toBe("unknown-path");
  });

  it("keeps mixed sequence plus src applicable (report-present measured path retained)", () => {
    const root = gitRepo({ "README.md": "# base\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, PLAN_SEQUENCE_REL_PATH), closedSequenceDoc());
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export const n = 1;\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "mixed-seq"], { cwd: root });
    const result = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(result.outcome).toBe("applicable");
    if (result.outcome === "applicable") {
      expect(result.coverablePaths).toContain("src/app.ts");
      const seq = result.changes.find((c) => c.path === PLAN_SEQUENCE_REL_PATH);
      expect(seq?.classification).toBe("inert");
    }
  });

  it("demotes plan/spec allowlisted M rows to N/A and keeps policy/LIVE_SETTINGS default coverable", () => {
    const root = gitRepo({
      "README.md": "# base\n",
      [PLAN_PATH]: planDoc({
        updated: "2026-10-01T00:00:00Z",
        interviewContinuation: {
          targetDeliverable: "old",
          reopenableDecisionSet: [],
          confirmations: [],
        },
      }),
      [SPEC_PATH]: specDoc({
        updated: "2026-10-01T00:00:00Z",
        narratives: { Requirements: "old", Design: "old" },
      }),
    });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    writeFileSync(
      join(root, PLAN_PATH),
      planDoc({
        updated: "2026-10-09T00:00:00Z",
        interviewContinuation: {
          targetDeliverable: "new",
          reopenableDecisionSet: ["k"],
          confirmations: [{ scope: "answer", target: "q" }],
        },
      }),
    );
    writeFileSync(
      join(root, SPEC_PATH),
      specDoc({
        updated: "2026-10-09T00:00:00Z",
        narratives: { Requirements: "new", Design: "new" },
      }),
    );
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/plan.md"), "note\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "plan-spec-refresh"], {
      cwd: root,
    });
    const na = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(na.outcome).toBe("not-applicable");
    if (na.outcome === "not-applicable") {
      expect(na.changes.find((c) => c.path === PLAN_PATH)?.classification).toBe("inert");
      expect(na.changes.find((c) => c.path === SPEC_PATH)?.classification).toBe("inert");
    }

    const policyRoot = gitRepo({
      [PLAN_PATH]: planDoc({
        updated: "2026-10-01T00:00:00Z",
        interviewContinuation: {
          targetDeliverable: "old",
          reopenableDecisionSet: [],
          confirmations: [],
        },
        policy: { wipCap: 20 },
      }),
    });
    const policyBase = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: policyRoot, encoding: "utf8" })
      .trim();
    writeFileSync(
      join(policyRoot, PLAN_PATH),
      planDoc({
        updated: "2026-10-09T00:00:00Z",
        interviewContinuation: {
          targetDeliverable: "new",
          reopenableDecisionSet: [],
          confirmations: [],
        },
        policy: { wipCap: 5 },
      }),
    );
    childProcess.execFileSync("git", ["add", "-A"], { cwd: policyRoot });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "plan-policy"], { cwd: policyRoot });
    const policyResult = evaluateCoverageApplicability(bindingFor(policyRoot, policyBase));
    expect(policyResult.outcome).toBe("applicable");
  });

  it("does not treat coverage inertness as membership authorization (docs contract fixture)", () => {
    // Path A: planning package without active brief → coverage N/A; sequence never
    // membership-freed (documented in content/docs/scope-provenance.md § Membership).
    expect(classifyChangedPath(PLAN_SEQUENCE_REL_PATH, "A", null)).toBe("unknown");
    expect(classifyChangedPath(".deft/approved-scope/x.json", "A", null)).toBe("unknown");
    expect(classifyChangedPath(PLAN_PATH, "M", null)).toBe("coverable");
    expect(classifyChangedPath(SPEC_PATH, "M", null)).toBe("coverable");
  });

  it("refuses delete/rename of plan-sequence without closed-shape A/M proof", () => {
    const deleted = evaluateCoverageApplicability(
      {
        projectRoot: "/tmp",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        requireTreeMatch: false,
      },
      {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: `D\t${PLAN_SEQUENCE_REL_PATH}\n` };
          }
          if (joined.includes("status")) return { ok: true as const, stdout: "" };
          return { ok: true as const, stdout: "base" };
        },
      },
    );
    expect(deleted.outcome).toBe("refuse");
    if (deleted.outcome === "refuse") expect(deleted.code).toBe("unknown-path");
  });

  it("demotes plan-sequence M and first-time demotion-only interviewContinuation create", () => {
    const root = gitRepo({
      "README.md": "# base\n",
      [PLAN_SEQUENCE_REL_PATH]: closedSequenceDoc({ current_index: 0 }),
      [PLAN_PATH]: planDoc({ updated: "2026-10-01T00:00:00Z" }),
    });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    writeFileSync(join(root, PLAN_SEQUENCE_REL_PATH), closedSequenceDoc({ current_index: 1 }));
    writeFileSync(
      join(root, PLAN_PATH),
      planDoc({
        updated: "2026-10-09T00:00:00Z",
        interviewContinuation: {
          targetDeliverable: "phase-a",
          reopenableDecisionSet: ["a"],
          confirmations: [],
        },
      }),
    );
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/m.md"), "m\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "seq-m-plan-create"], { cwd: root });
    const result = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(result.outcome).toBe("not-applicable");
    if (result.outcome === "not-applicable") {
      expect(result.changes.find((c) => c.path === PLAN_SEQUENCE_REL_PATH)?.status).toBe("M");
      expect(result.changes.find((c) => c.path === PLAN_PATH)?.classification).toBe("inert");
    }
  });

  it("refuses first-time interviewContinuation create that includes phase", () => {
    const base = JSON.parse(planDoc({ updated: "2026-10-01T00:00:00Z" })) as unknown;
    const head = JSON.parse(
      planDoc({
        updated: "2026-10-09T00:00:00Z",
        interviewContinuation: {
          targetDeliverable: "x",
          reopenableDecisionSet: [],
          confirmations: [],
          phase: "planning-draft-approved",
        },
      }),
    ) as unknown;
    expect(isPlanInterviewContinuationRefreshOnly(base, head)).toBe(false);
  });

  it("refuses non-string Design narrative and bad confirmation shapes", () => {
    const base = JSON.parse(
      specDoc({ updated: "2026-10-01T00:00:00Z", narratives: { Design: "old" } }),
    ) as unknown;
    const head = JSON.parse(
      specDoc({
        updated: "2026-10-09T00:00:00Z",
        narratives: { Design: { nested: true } },
      }),
    ) as unknown;
    expect(isSpecificationNarrativeRefreshOnly(base, head)).toBe(false);

    const planBase = JSON.parse(
      planDoc({
        updated: "2026-10-01T00:00:00Z",
        interviewContinuation: { confirmations: [{ scope: "answer", target: "q" }] },
      }),
    ) as unknown;
    const planHead = JSON.parse(
      planDoc({
        updated: "2026-10-09T00:00:00Z",
        interviewContinuation: { confirmations: [{ scope: "artifact" }] },
      }),
    ) as unknown;
    // artifact without target+revisionId still type-checks as entry shape for demotion
    // field validity; scope-only artifact is still an object with valid scope enum.
    expect(isPlanInterviewContinuationRefreshOnly(planBase, planHead)).toBe(true);

    const badConfirm = JSON.parse(
      planDoc({
        updated: "2026-10-09T00:00:00Z",
        interviewContinuation: { confirmations: [{ scope: "nope" }] },
      }),
    ) as unknown;
    expect(isPlanInterviewContinuationRefreshOnly(planBase, badConfirm)).toBe(false);

    const unknownConfirmKey = JSON.parse(
      planDoc({
        updated: "2026-10-09T00:00:00Z",
        interviewContinuation: {
          confirmations: [{ scope: "answer", target: "q", extra: { nested: true } }],
        },
      }),
    ) as unknown;
    expect(isPlanInterviewContinuationRefreshOnly(planBase, unknownConfirmKey)).toBe(false);
  });

  it("exposes isCoverageHeadroomNotApplicable for closed-shape sequence N/A", () => {
    const root = gitRepo({ "README.md": "# base\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, PLAN_SEQUENCE_REL_PATH), closedSequenceDoc());
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/h.md"), "h\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "headroom-na"], { cwd: root });
    expect(isCoverageHeadroomNotApplicable(bindingFor(root, baseSha))).toBe(true);
  });
});

describe("evaluateCoverageApplicability #5677 Prefer-A Bound Recut-1", { timeout: 30_000 }, () => {
  it("marks CODEQL + official githooks inert N/A and keeps _directive-run.sh applicable", () => {
    const root = gitRepo({ "README.md": "# base\n" });
    const baseSha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .trim();
    mkdirSync(join(root, ".github/codeql"), { recursive: true });
    mkdirSync(join(root, ".githooks"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, ".github/codeql/codeql-config.yml"), "paths-ignore: []\n");
    writeFileSync(join(root, ".githooks/pre-commit"), "#!/bin/sh\n");
    writeFileSync(join(root, ".githooks/pre-push"), "#!/bin/sh\n");
    writeFileSync(join(root, "docs/n.md"), "n\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "codeql-hooks"], { cwd: root });
    const na = evaluateCoverageApplicability(bindingFor(root, baseSha));
    expect(na.outcome).toBe("not-applicable");

    const supportRoot = gitRepo({ "README.md": "# base\n" });
    const supportBase = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: supportRoot, encoding: "utf8" })
      .trim();
    mkdirSync(join(supportRoot, ".githooks"), { recursive: true });
    writeFileSync(join(supportRoot, ".githooks/_directive-run.sh"), "#!/bin/sh\necho run\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: supportRoot });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "support-sh"], { cwd: supportRoot });
    const applicable = evaluateCoverageApplicability(bindingFor(supportRoot, supportBase));
    expect(applicable.outcome).toBe("applicable");
    if (applicable.outcome === "applicable") {
      expect(applicable.coverablePaths).toContain(".githooks/_directive-run.sh");
    }
  });

  it("demotes managed-only registration A/M and keeps consumer-delta / marker-custom non-inert", () => {
    const addRoot = gitRepo({ "README.md": "# base\n" });
    const addBase = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: addRoot, encoding: "utf8" })
      .trim();
    mkdirSync(join(addRoot, ".cursor"), { recursive: true });
    mkdirSync(join(addRoot, "docs"), { recursive: true });
    writeFileSync(join(addRoot, ".cursor/hooks.json"), canonicalCursorRegistration());
    writeFileSync(join(addRoot, "docs/a.md"), "a\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: addRoot });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "reg-a"], { cwd: addRoot });
    const addResult = evaluateCoverageApplicability(bindingFor(addRoot, addBase));
    expect(addResult.outcome).toBe("not-applicable");
    if (addResult.outcome === "not-applicable") {
      expect(addResult.changes.find((c) => c.path === ".cursor/hooks.json")?.classification).toBe(
        "inert",
      );
    }

    const modRoot = gitRepo({
      "README.md": "# base\n",
      ".cursor/hooks.json": canonicalCursorRegistration({
        customSession: { command: "./custom-session.sh" },
      }),
    });
    const modBase = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: modRoot, encoding: "utf8" })
      .trim();
    const refreshed = JSON.parse(
      canonicalCursorRegistration({ customSession: { command: "./custom-session.sh" } }),
    ) as { version: number; hooks: { preToolUse: unknown[] } & Record<string, unknown> };
    // Deposit-style rewrite: reverse matcher order (multiset-complete) + same consumer.
    refreshed.hooks.preToolUse = [...refreshed.hooks.preToolUse].reverse();
    writeFileSync(join(modRoot, ".cursor/hooks.json"), `${JSON.stringify(refreshed, null, 2)}\n`);
    mkdirSync(join(modRoot, "docs"), { recursive: true });
    writeFileSync(join(modRoot, "docs/m.md"), "m\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: modRoot });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "reg-m"], { cwd: modRoot });
    const modResult = evaluateCoverageApplicability(bindingFor(modRoot, modBase));
    expect(modResult.outcome).toBe("not-applicable");
    if (modResult.outcome === "not-applicable") {
      expect(modResult.changes.find((c) => c.path === ".cursor/hooks.json")?.classification).toBe(
        "inert",
      );
    }

    const customRoot = gitRepo({
      "README.md": "# base\n",
      ".cursor/hooks.json": canonicalCursorRegistration(),
    });
    const customBase = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: customRoot, encoding: "utf8" })
      .trim();
    writeFileSync(
      join(customRoot, ".cursor/hooks.json"),
      canonicalCursorRegistration({
        customSession: { command: "deft-hook --host cursor --event session.start --evil" },
      }),
    );
    childProcess.execFileSync("git", ["add", "-A"], { cwd: customRoot });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "marker-custom"], { cwd: customRoot });
    const customResult = evaluateCoverageApplicability(bindingFor(customRoot, customBase));
    expect(customResult.outcome).toBe("refuse");
    if (customResult.outcome === "refuse") expect(customResult.code).toBe("unknown-path");

    const addCustom = gitRepo({ "README.md": "# base\n" });
    const addCustomBase = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: addCustom, encoding: "utf8" })
      .trim();
    mkdirSync(join(addCustom, ".cursor"), { recursive: true });
    writeFileSync(
      join(addCustom, ".cursor/hooks.json"),
      canonicalCursorRegistration({ customSession: { command: "./custom-session.sh" } }),
    );
    childProcess.execFileSync("git", ["add", "-A"], { cwd: addCustom });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "reg-a-custom"], { cwd: addCustom });
    const addCustomResult = evaluateCoverageApplicability(bindingFor(addCustom, addCustomBase));
    expect(addCustomResult.outcome).toBe("refuse");
    if (addCustomResult.outcome === "refuse") expect(addCustomResult.code).toBe("unknown-path");
  });

  it("relieves run D with python shebang base and refuses A/M / non-python / unreadable", () => {
    const delRoot = gitRepo({
      "README.md": "# base\n",
      ".deft/core/run": "#!/usr/bin/env python3\nprint('legacy')\n",
    });
    const delBase = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: delRoot, encoding: "utf8" })
      .trim();
    childProcess.execFileSync("git", ["rm", "-q", ".deft/core/run"], { cwd: delRoot });
    mkdirSync(join(delRoot, "docs"), { recursive: true });
    writeFileSync(join(delRoot, "docs/d.md"), "d\n");
    childProcess.execFileSync("git", ["add", "-A"], { cwd: delRoot });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "run-d"], { cwd: delRoot });
    const delResult = evaluateCoverageApplicability(bindingFor(delRoot, delBase));
    expect(delResult.outcome).toBe("not-applicable");
    if (delResult.outcome === "not-applicable") {
      expect(delResult.changes.find((c) => c.path === ".deft/core/run")?.classification).toBe(
        "inert",
      );
    }

    const nonPy = gitRepo({
      "README.md": "# base\n",
      ".deft/core/run": "#!/bin/sh\necho hi\n",
    });
    const nonPyBase = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: nonPy, encoding: "utf8" })
      .trim();
    childProcess.execFileSync("git", ["rm", "-q", ".deft/core/run"], { cwd: nonPy });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "run-d-sh"], { cwd: nonPy });
    const nonPyResult = evaluateCoverageApplicability(bindingFor(nonPy, nonPyBase));
    expect(nonPyResult.outcome).toBe("refuse");
    if (nonPyResult.outcome === "refuse") expect(nonPyResult.code).toBe("unknown-path");

    const addRun = evaluateCoverageApplicability(
      {
        projectRoot: "/tmp",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        requireTreeMatch: false,
      },
      {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: "A\t.deft/core/run\n" };
          }
          if (joined.includes("status")) return { ok: true as const, stdout: "" };
          return { ok: true as const, stdout: "base" };
        },
      },
    );
    expect(addRun.outcome).toBe("refuse");
    if (addRun.outcome === "refuse") expect(addRun.code).toBe("unknown-path");

    const unread = evaluateCoverageApplicability(
      {
        projectRoot: "/tmp",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        requireTreeMatch: false,
      },
      {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: "D\t.deft/core/run\n" };
          }
          if (joined.includes("status")) return { ok: true as const, stdout: "" };
          if (joined.includes("show")) {
            return { ok: false as const, message: "missing blob" };
          }
          return { ok: true as const, stdout: "base" };
        },
      },
    );
    expect(unread.outcome).toBe("refuse");
    if (unread.outcome === "refuse") expect(unread.code).toBe("unknown-path");
  });

  it("keeps approved-scope and unlisted peers unknown-path refuse", () => {
    const approved = evaluateCoverageApplicability(
      {
        projectRoot: "/tmp",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        requireTreeMatch: false,
      },
      {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: "A\t.deft/approved-scope/x.json\n" };
          }
          if (joined.includes("status")) return { ok: true as const, stdout: "" };
          return { ok: true as const, stdout: "base" };
        },
      },
    );
    expect(approved.outcome).toBe("refuse");
    if (approved.outcome === "refuse") expect(approved.code).toBe("unknown-path");

    const extra = evaluateCoverageApplicability(
      {
        projectRoot: "/tmp",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        requireTreeMatch: false,
      },
      {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: "A\t.githooks/extra-hook\n" };
          }
          if (joined.includes("status")) return { ok: true as const, stdout: "" };
          return { ok: true as const, stdout: "base" };
        },
      },
    );
    expect(extra.outcome).toBe("refuse");
    if (extra.outcome === "refuse") expect(extra.code).toBe("unknown-path");
  });
});
