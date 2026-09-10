import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeDocsImpactBody,
  DOCS_IMPACT_SEED_BLOCK,
  detectClosedSurfaceChanges,
  docsImpactMain,
  EXIT_IMPACT,
  evaluateDocsImpact,
  extractCommandIdsFromSources,
  extractHelpKeysFromSource,
  extractSkillIdsFromPack,
  fetchPrBodyRest,
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
    const code = docsImpactMain(["--body-file", bodyPath, "--project-root", dir], {
      runGit: (args) => {
        if (args[0] === "diff") return { returncode: 0, stdout: "M\tREADME.md\n", stderr: "" };
        if (args[0] === "merge-base") return { returncode: 0, stdout: "abc123\n", stderr: "" };
        if (args[0] === "show") return { returncode: 0, stdout: "", stderr: "" };
        return { returncode: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(0);
    expect(docsImpactMain(["--body-file", join(dir, "missing.md")])).toBe(2);

    const body = fetchPrBodyRest(3, "deftai/directive", (cmd) => {
      expect(cmd.join(" ")).toContain("gh api repos/deftai/directive/pulls/3");
      return { returncode: 0, stdout: JSON.stringify({ body: "ok" }), stderr: "" };
    });
    expect(body).toBe("ok");
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
          }),
          stderr: "",
        }),
        runGit: () => ({ returncode: 0, stdout: "", stderr: "" }),
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
    const code = docsImpactMain(["--body-file", bodyPath, "--project-root", dir], {
      runGit: (args) => {
        if (args[0] === "diff") {
          return { returncode: 128, stdout: "", stderr: "fatal: bad revision origin/master" };
        }
        return { returncode: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(2);
    expect(extractSkillIdsFromPack("null")).toEqual(new Set());
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
        runGit: () => ({ returncode: 0, stdout: "", stderr: "" }),
      }),
    ).toBe(0);
  });
});
