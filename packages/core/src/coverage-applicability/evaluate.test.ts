import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP } from "../pre-pr-controller/phases.js";
import {
  classifyChangedPath,
  decodeGitQuotedPath,
  evaluateCoverageApplicability,
  isProjectDefinitionRegistryRefreshOnly,
  parseNameStatus,
} from "./evaluate.js";

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
