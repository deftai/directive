import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  composeDocsImpactBody,
  DOCS_IMPACT_SEED_BLOCK,
  detectClosedSurfaceChanges,
  docsImpactMain,
  EXIT_CONFIG,
  EXIT_IMPACT,
  EXIT_OK,
  evaluateDocsImpact,
  extractCommandIdsFromSources,
  extractHelpKeysFromSource,
  extractSkillIdsFromPack,
  fetchPrBodyRest,
  originQualifyBranchName,
  originQualifyGitBase,
  parseDocsImpactArgs,
  parseDocsImpactDeclaration,
  parseNameStatus,
  RATIONALE_MAX_CHARS,
  restPullsPath,
  type SurfaceChange,
  verifyDocsImpactBodyFile,
} from "./docs-impact.js";

const rationale = 'rationale: "Internal-only change."';

function body(fields: string): string {
  return `## Documentation impact\n\n${fields}\n${rationale}\n`;
}

describe("docs-impact declaration parse (#4099)", () => {
  it("parses change_class, surfaces, and quoted rationale", () => {
    const parsed = parseDocsImpactDeclaration(
      body("change_class: add\nsurfaces: command:docs:capability-map"),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.declaration?.changeClass).toBe("add");
    expect(parsed.declaration?.surfaces).toEqual([{ kind: "command", id: "docs:capability-map" }]);
  });

  it("treats no user-doc impact as change_class none", () => {
    const parsed = parseDocsImpactDeclaration(`This PR has no user-doc impact.\n${rationale}\n`);
    expect(parsed.declaration?.noUserDocImpact).toBe(true);
    expect(parsed.declaration?.changeClass).toBe("none");
  });

  it("rejects missing declaration and unquoted rationale", () => {
    expect(parseDocsImpactDeclaration("just a summary").errors.length).toBeGreaterThan(0);
    expect(
      parseDocsImpactDeclaration(
        "change_class: add\nsurfaces: none\nrationale: unquoted\n",
      ).errors.some((e) => e.includes("quoted rationale")),
    ).toBe(true);
  });

  it("bounds rationale length without scoring its prose", () => {
    const long = `change_class: none\nsurfaces: none\nrationale: "${"x".repeat(RATIONALE_MAX_CHARS + 1)}"\n`;
    expect(parseDocsImpactDeclaration(long).errors.some((e) => e.includes("exceeds"))).toBe(true);
  });
});

describe("declared-versus-touched (#4099)", () => {
  const addCommand: SurfaceChange = { kind: "command", id: "docs:capability-map", op: "add" };
  const removeSkill: SurfaceChange = {
    kind: "skill-trigger",
    id: "deft-directive-triage",
    op: "remove",
  };

  it("refuses no user-doc impact when a registered command is added", () => {
    const result = evaluateDocsImpact({
      body: `no user-doc impact\n${rationale}\n`,
      changes: [addCommand],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("no user-doc impact is refused");
  });

  it("refuses no user-doc impact for skill, help key, and docs-site add/remove", () => {
    for (const change of [
      { kind: "skill-trigger", id: "deft-directive-setup", op: "add" },
      { kind: "help", id: "task triage:summary", op: "add" },
      { kind: "docs-site", id: "docs-site/index.html", op: "remove" },
    ] as const) {
      const result = evaluateDocsImpact({
        body: `no user-doc impact\n${rationale}\n`,
        changes: [change],
      });
      expect(result.ok, surfaceKey(change)).toBe(false);
    }
  });

  it("passes no user-doc impact when the closed surface set is untouched", () => {
    const result = evaluateDocsImpact({
      body: `no user-doc impact\n${rationale}\n`,
      changes: [],
    });
    expect(result.ok).toBe(true);
  });

  it("does not use rationale text as a gate input", () => {
    const sameRationale = 'rationale: "looks thorough"';
    const fail = evaluateDocsImpact({
      body: `no user-doc impact\n${sameRationale}\n`,
      changes: [addCommand],
    });
    const pass = evaluateDocsImpact({
      body: `change_class: add\nsurfaces: command:docs:capability-map\n${sameRationale}\n`,
      changes: [addCommand],
    });
    expect(fail.ok).toBe(false);
    expect(pass.ok).toBe(true);
  });

  it("requires a closed-surface remove as the withdraw detecting event", () => {
    const missing = evaluateDocsImpact({
      body: body("change_class: withdraw\nsurfaces: skill-trigger:deft-directive-triage"),
      changes: [],
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join("\n")).toContain("withdraw");
    const ok = evaluateDocsImpact({
      body: body("change_class: withdraw\nsurfaces: skill-trigger:deft-directive-triage"),
      changes: [removeSkill],
    });
    expect(ok.ok).toBe(true);
  });

  it("fails when declared surfaces omit a touched closed-surface id", () => {
    const result = evaluateDocsImpact({
      body: body("change_class: add\nsurfaces: command:other"),
      changes: [addCommand],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("declared-versus-touched");
  });
});

function surfaceKey(change: SurfaceChange): string {
  return `${change.kind}:${change.id}`;
}

describe("syntactic closed-surface detection", () => {
  it("diffs Taskfile namespaced tasks as command add/remove", () => {
    const changes = detectClosedSurfaceChanges({
      nameStatus: [{ status: "M", path: "tasks/docs.yml" }],
      baseFiles: { "tasks/docs.yml": "tasks:\n  rule-map:\n    desc: old\n" },
      headFiles: {
        "tasks/docs.yml": "tasks:\n  rule-map:\n    desc: old\n  capability-map:\n    desc: new\n",
      },
    });
    expect(changes).toContainEqual({ kind: "command", id: "docs:capability-map", op: "add" });
  });

  it("diffs dispatch CLI_MODULE_VERBS", () => {
    const base = 'export const CLI_MODULE_VERBS = ["check"];';
    const head = 'export const CLI_MODULE_VERBS = ["check", "docs-impact"];';
    const changes = detectClosedSurfaceChanges({
      nameStatus: [{ status: "M", path: "packages/cli/src/dispatch.ts" }],
      baseFiles: { "packages/cli/src/dispatch.ts": base },
      headFiles: { "packages/cli/src/dispatch.ts": head },
    });
    expect(
      extractCommandIdsFromSources({ "packages/cli/src/dispatch.ts": head }).has("docs-impact"),
    ).toBe(true);
    expect(changes).toContainEqual({ kind: "command", id: "docs-impact", op: "add" });
  });

  it("diffs help keys, skill pack ids, and docs-site pages", () => {
    const helpBase = 'registry: {\n    "task triage:summary": {\n';
    const helpHead =
      'registry: {\n    "task triage:summary": {\n    "task docs:capability-map": {\n';
    expect(
      detectClosedSurfaceChanges({
        nameStatus: [{ status: "M", path: "packages/core/src/triage/help/registry-data.ts" }],
        baseFiles: { "packages/core/src/triage/help/registry-data.ts": helpBase },
        headFiles: { "packages/core/src/triage/help/registry-data.ts": helpHead },
      }),
    ).toContainEqual({ kind: "help", id: "task docs:capability-map", op: "add" });

    expect(
      detectClosedSurfaceChanges({
        nameStatus: [{ status: "M", path: "content/packs/skills/skills-pack-0.1.json" }],
        baseFiles: {
          "content/packs/skills/skills-pack-0.1.json": JSON.stringify({
            skills: [{ id: "deft-directive-setup" }],
          }),
        },
        headFiles: {
          "content/packs/skills/skills-pack-0.1.json": JSON.stringify({
            skills: [{ id: "deft-directive-setup" }, { id: "deft-directive-new" }],
          }),
        },
      }),
    ).toContainEqual({ kind: "skill-trigger", id: "deft-directive-new", op: "add" });

    expect(
      detectClosedSurfaceChanges({
        nameStatus: [{ status: "A", path: "docs-site/new.html" }],
        baseFiles: {},
        headFiles: {},
      }),
    ).toContainEqual({ kind: "docs-site", id: "docs-site/new.html", op: "add" });
  });
});

describe("docs-impact CLI transport", () => {
  it("requires --pr or --body-file and uses REST pulls path", () => {
    expect(parseDocsImpactArgs([]).error).toBeNull();
    expect(parseDocsImpactArgs(["--pr", "12", "--body-file", "x"]).pr).toBe(12);
    expect(parseDocsImpactArgs(["--body-file", "x", "--base-ref", "develop"]).baseRef).toBe(
      "develop",
    );
    expect(parseDocsImpactArgs(["--base-ref"]).error).toContain("--base-ref");
    expect(restPullsPath("deftai/directive", 12)).toBe("repos/deftai/directive/pulls/12");
    expect(docsImpactMain([])).toBe(2);
  });

  it("reads --body-file and does not call gh with GraphQL pr view --json", () => {
    const ghCalls: string[][] = [];
    const code = docsImpactMain(
      ["--pr", "9", "--repo", "deftai/directive", "--project-root", "/tmp"],
      {
        runGh: (cmd) => {
          ghCalls.push([...cmd]);
          return { returncode: 1, stdout: "", stderr: "nope" };
        },
        runGit: () => ({ returncode: 0, stdout: "", stderr: "" }),
      },
    );
    expect(code).toBe(2);
    expect(ghCalls[0]?.join(" ")).toContain("gh api repos/deftai/directive/pulls/9");
    expect(ghCalls.some((cmd) => cmd.includes("pr") && cmd.includes("view"))).toBe(false);
  });

  it("accepts --body-file with mocked git and REST PR bodies", () => {
    expect(docsImpactMain(["--help"])).toBe(0);
    expect(parseDocsImpactArgs(["--pr"]).error).toContain("--pr");
    expect(parseDocsImpactArgs(["--unknown"]).error).toContain("unrecognized");
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-"));
    const bodyPath = join(dir, "body.md");
    writeFileSync(
      bodyPath,
      `no user-doc impact\nrationale: "Nothing in the closed surface set moved."\n`,
    );
    const code = docsImpactMain(
      ["--body-file", bodyPath, "--project-root", dir, "--base-ref", "origin/master"],
      {
        runGit: (args) => {
          if (args[0] === "diff") return { returncode: 0, stdout: "M\tREADME.md\n", stderr: "" };
          if (args[0] === "merge-base") return { returncode: 0, stdout: "abc123\n", stderr: "" };
          if (args[0] === "show") return { returncode: 0, stdout: "", stderr: "" };
          return { returncode: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(code).toBe(0);
    expect(docsImpactMain(["--body-file", join(dir, "missing.md")])).toBe(2);

    const body = fetchPrBodyRest(3, "deftai/directive", (cmd) => {
      expect(cmd.join(" ")).toContain("gh api repos/deftai/directive/pulls/3");
      return { returncode: 0, stdout: JSON.stringify({ body: "ok" }), stderr: "" };
    });
    expect(body).toEqual({ body: "ok", baseRef: null });
    expect(
      fetchPrBodyRest(3, "deftai/directive", () => ({
        returncode: 0,
        stdout: "not-json",
        stderr: "",
      })),
    ).toBeNull();
    expect(parseNameStatus("A\tdocs-site/index.html\nR100\told\tnew.md\n")).toEqual([
      { status: "A", path: "docs-site/index.html" },
      { status: "R100", path: "new.md" },
    ]);
    expect(extractHelpKeysFromSource('registry: {\n    "task triage:summary": {\n')).toEqual(
      new Set(["task triage:summary"]),
    );

    const prCode = docsImpactMain(
      ["--pr", "4", "--repo", "deftai/directive", "--project-root", dir],
      {
        runGh: () => ({
          returncode: 0,
          stdout: JSON.stringify({
            body: `no user-doc impact\nrationale: "Closed surfaces unchanged."\n`,
            base: { ref: "master" },
          }),
          stderr: "",
        }),
        runGit: (args) => {
          if (args[0] === "merge-base") return { returncode: 0, stdout: "abc123\n", stderr: "" };
          return { returncode: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(prCode).toBe(0);
    expect(docsImpactMain(["--pr", "4"])).toBe(2);
  });

  it("fails closed when git diff --name-status errors instead of treating stdout as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-gitfail-"));
    const bodyPath = join(dir, "body.md");
    writeFileSync(
      bodyPath,
      `no user-doc impact\nrationale: "Would wrongly pass if a failed diff were empty."\n`,
    );
    const code = docsImpactMain(
      ["--body-file", bodyPath, "--project-root", dir, "--base-ref", "origin/master"],
      {
        runGit: (args) => {
          if (args[0] === "diff") {
            return { returncode: 128, stdout: "", stderr: "fatal: bad revision origin/master" };
          }
          if (args[0] === "merge-base") return { returncode: 0, stdout: "abc123\n", stderr: "" };
          return { returncode: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(code).toBe(2);
    expect(extractSkillIdsFromPack("null")).toEqual(new Set());
  });

  it("returns semantic EXIT_IMPACT for a missing declaration even when git range fails (#4356)", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-parse-first-"));
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, "## Summary\nempty file is enough to reach body parse\n");
    let gitCalls = 0;
    const code = docsImpactMain(["--body-file", bodyPath, "--project-root", dir], {
      runGit: () => {
        gitCalls += 1;
        return { returncode: 128, stdout: "", stderr: "fatal: bad revision origin/master" };
      },
    });
    expect(code).toBe(EXIT_IMPACT);
    expect(gitCalls).toBe(0);
  });
});

describe("explicit body seed then same-file verify (#4293)", () => {
  const summaryOnly = "## Summary\nLand leftover completed-tracked artifact.\n\nCloses #4293\n";

  it("fails a Summary/Closes body with no change_class the same way CI does", () => {
    const parsed = parseDocsImpactDeclaration(summaryOnly);
    expect(parsed.errors.some((e) => e.includes("missing documentation-impact declaration"))).toBe(
      true,
    );
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-summary-"));
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, summaryOnly);
    expect(
      docsImpactMain(["--body-file", bodyPath, "--project-root", dir], {
        runGit: () => ({ returncode: 0, stdout: "", stderr: "" }),
      }),
    ).toBe(EXIT_IMPACT);
  });

  it("seeds the template block and verifies those same bytes", () => {
    const composed = composeDocsImpactBody(summaryOnly);
    expect(composed).toContain("change_class: none");
    expect(composed).toContain(DOCS_IMPACT_SEED_BLOCK.trim());
    expect(parseDocsImpactDeclaration(composed).declaration).not.toBeNull();
    const already = body("change_class: none\nsurfaces: none");
    expect(composeDocsImpactBody(already)).toBe(already);
    expect(composeDocsImpactBody(`${summaryOnly}   \n\n`)).toBe(composed);
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-seeded-"));
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, composed);
    expect(
      verifyDocsImpactBodyFile(bodyPath, dir, {
        runGit: (args) => {
          if (args[0] === "merge-base") return { returncode: 0, stdout: "abc123\n", stderr: "" };
          return { returncode: 0, stdout: "", stderr: "" };
        },
        baseRef: "origin/master",
      }),
    ).toBe(0);
  });
});

const validNoneBody =
  '## Documentation impact\n\nchange_class: none\nsurfaces: none\nrationale: "No closed user-doc surface added or removed."\n';

function recordingGit(succeedOn: string): {
  readonly calls: string[][];
  readonly runGit: (args: readonly string[]) => {
    readonly returncode: number;
    readonly stdout: string;
    readonly stderr: string;
  };
} {
  const calls: string[][] = [];
  return {
    calls,
    runGit: (args) => {
      calls.push([...args]);
      if (args[0] === "merge-base") {
        if (args[1] === succeedOn) return { returncode: 0, stdout: "sha-base\n", stderr: "" };
        return { returncode: 128, stdout: "", stderr: `fatal: bad revision ${args[1]}` };
      }
      if (args[0] === "diff" || args[0] === "show") {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      return { returncode: 0, stdout: "", stderr: "" };
    },
  };
}

function seedMainOnlyRepo(root: string): void {
  const git = (args: readonly string[]): void => {
    execFileSync("git", [...args], { cwd: root, stdio: "ignore" });
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "docs-impact@example.com"]);
  git(["config", "user.name", "docs-impact"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "README.md"), "main only\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "init"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(["checkout", "-B", "feat/docs-impact"]);
  writeFileSync(join(root, "README.md"), "feature\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "feature"]);
}

describe("docs-impact comparison base (#4675)", () => {
  it("origin-qualifies a branch name and leaves origin/ and refs/ intact", () => {
    expect(originQualifyGitBase("develop")).toBe("origin/develop");
    expect(originQualifyGitBase("origin/master")).toBe("origin/master");
    expect(originQualifyGitBase("refs/heads/main")).toBe("refs/heads/main");
    expect(originQualifyGitBase("  ")).toBe("");
  });

  it("always origin-qualifies REST branch names, including origin/ and refs/ prefixes", () => {
    expect(originQualifyBranchName("develop")).toBe("origin/develop");
    expect(originQualifyBranchName("origin/release")).toBe("origin/origin/release");
    expect(originQualifyBranchName("refs/heads/release")).toBe("origin/refs/heads/release");
    expect(originQualifyBranchName("  ")).toBe("");
  });

  it("does not import origin-default resolvers or HEAD~1 fallback", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "docs-impact.ts"),
      "utf8",
    );
    expect(src).not.toContain("resolveDefaultBaseRef");
    expect(src).not.toContain("ORIGIN_DEFAULT_CANDIDATES");
    expect(src).not.toContain("HEAD~1");
  });

  it("returns EXIT_CONFIG for a valid body-file with no --base-ref and does not run git", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-missing-base-"));
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, validNoneBody);
    let gitCalls = 0;
    const code = docsImpactMain(["--body-file", bodyPath, "--project-root", dir], {
      runGit: () => {
        gitCalls += 1;
        return { returncode: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(gitCalls).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps EXIT_IMPACT for a missing declaration before git and before requiring --base-ref (#4356)", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-parse-first-base-"));
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, "## Summary\nempty file is enough to reach body parse\n");
    let gitCalls = 0;
    const code = docsImpactMain(["--body-file", bodyPath, "--project-root", dir], {
      runGit: () => {
        gitCalls += 1;
        return { returncode: 128, stdout: "", stderr: "fatal: bad revision origin/master" };
      },
    });
    expect(code).toBe(EXIT_IMPACT);
    expect(gitCalls).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses REST base.ref develop when default_branch is main, one GET, shared git base", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-develop-target-"));
    const git = recordingGit("origin/develop");
    let ghCalls = 0;
    const code = docsImpactMain(
      ["--pr", "376", "--repo", "deftai/BestiMax", "--project-root", dir],
      {
        runGh: (cmd) => {
          ghCalls += 1;
          expect(cmd.join(" ")).toBe("gh api repos/deftai/BestiMax/pulls/376");
          return {
            returncode: 0,
            stdout: JSON.stringify({
              body: validNoneBody,
              base: { ref: "develop", repo: { default_branch: "main" } },
            }),
            stderr: "",
          };
        },
        runGit: git.runGit,
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(ghCalls).toBe(1);
    expect(git.calls.some((args) => args[0] === "merge-base" && args[1] === "origin/develop")).toBe(
      true,
    );
    expect(git.calls.some((args) => args[0] === "diff" && args.includes("sha-base...HEAD"))).toBe(
      true,
    );
    expect(git.calls.some((args) => args[0] === "show" && args[1]?.startsWith("sha-base:"))).toBe(
      true,
    );
    expect(
      git.calls.some((args) => args.includes("origin/main") || args.includes("origin/master")),
    ).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("origin-qualifies REST base.ref when the branch name starts with origin/", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-origin-named-branch-"));
    const git = recordingGit("origin/origin/release");
    const code = docsImpactMain(["--pr", "376", "--repo", "owner/name", "--project-root", dir], {
      runGh: () => ({
        returncode: 0,
        stdout: JSON.stringify({
          body: validNoneBody,
          base: { ref: "origin/release", repo: { default_branch: "main" } },
        }),
        stderr: "",
      }),
      runGit: git.runGit,
    });
    expect(code).toBe(EXIT_OK);
    expect(git.calls[0]).toEqual(["merge-base", "origin/origin/release", "HEAD"]);
    expect(git.calls.some((args) => args[0] === "merge-base" && args[1] === "origin/release")).toBe(
      false,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps origin/master when that is the intended body-file base", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-master-base-"));
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, validNoneBody);
    const git = recordingGit("origin/master");
    const code = docsImpactMain(
      ["--body-file", bodyPath, "--project-root", dir, "--base-ref", "master"],
      { runGit: git.runGit },
    );
    expect(code).toBe(EXIT_OK);
    expect(git.calls[0]).toEqual(["merge-base", "origin/master", "HEAD"]);
    expect(git.calls.some((args) => args[0] === "diff" && args.includes("sha-base...HEAD"))).toBe(
      true,
    );
    expect(git.calls.some((args) => args[0] === "show" && args[1]?.startsWith("sha-base:"))).toBe(
      true,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a valid body-file in a git fixture with main and no master", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-main-only-"));
    seedMainOnlyRepo(dir);
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, validNoneBody);
    let masterFailed = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "origin/master"], {
        cwd: dir,
        stdio: "ignore",
      });
    } catch {
      masterFailed = true;
    }
    expect(masterFailed).toBe(true);
    const code = docsImpactMain([
      "--body-file",
      bodyPath,
      "--project-root",
      dir,
      "--base-ref",
      "main",
    ]);
    expect(code).toBe(EXIT_OK);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns EXIT_CONFIG for an unresolvable intended base without fabricating a ref", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-unresolvable-"));
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, validNoneBody);
    const git = recordingGit("origin/main");
    const code = docsImpactMain(
      ["--body-file", bodyPath, "--project-root", dir, "--base-ref", "develop"],
      { runGit: git.runGit },
    );
    expect(code).toBe(EXIT_CONFIG);
    expect(git.calls).toEqual([["merge-base", "origin/develop", "HEAD"]]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns EXIT_CONFIG when --pr REST JSON omits base.ref after a valid declaration", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-pr-no-base-"));
    let gitCalls = 0;
    const code = docsImpactMain(["--pr", "1", "--repo", "owner/name", "--project-root", dir], {
      runGh: () => ({
        returncode: 0,
        stdout: JSON.stringify({ body: validNoneBody, base: { repo: { default_branch: "main" } } }),
        stderr: "",
      }),
      runGit: () => {
        gitCalls += 1;
        return { returncode: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(gitCalls).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("threads helper baseRef through verifyDocsImpactBodyFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-helper-base-"));
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, validNoneBody);
    const git = recordingGit("origin/develop");
    const code = verifyDocsImpactBodyFile(bodyPath, dir, {
      runGit: git.runGit,
      baseRef: "develop",
    });
    expect(code).toBe(EXIT_OK);
    expect(git.calls[0]).toEqual(["merge-base", "origin/develop", "HEAD"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
