import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_CONSUMER_ENFORCEMENT_GATES } from "../consumer-check-contract/evaluate.js";
import { buildIntentConstraintRecord } from "../intent-constraint/mint.js";
import { buildObservableScopeRecord } from "../observable-scope/mint.js";
import { evaluatePresentationCoverage } from "./evaluate.js";
import { COMPOSED_GATE_IDS } from "./gates.js";

const roots: string[] = [];
function repo() {
  const root = mkdtempSync(join(tmpdir(), "deft-coverage-gates-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git("init", "--quiet", "--template=");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  const stamp = { kind: "operator", actor: "David", mintedAt: "2026-09-28T00:00:00Z" };
  const rel = "xbrief/active/story.xbrief.json";
  const brief = {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: "current",
      title: "Presentation",
      status: "running",
      items: [],
      metadata: { swarm: { file_scope: ["public/**", "db/**"] } },
      "x-directive/observableChange": { changeKind: "fields-only", allowedChanges: [] },
    },
  };
  write(rel, JSON.stringify(brief));
  write(
    ".deft/presentation-ceiling.json",
    JSON.stringify({
      changeClass: "presentation",
      extensionAmendment: { extensions: [".sql"], humanApproval: stamp },
    }),
  );
  write(
    ".deft/observable-ui.policy.json",
    JSON.stringify({ schema: "deft.observable-ui.policy.v1", surfaces: ["public/**"] }),
  );
  write(
    ".deft/observable-scope/current.json",
    JSON.stringify(
      buildObservableScopeRecord({
        planId: "current",
        xbriefRelPath: rel,
        allowedChanges: [],
        humanApproval: stamp,
      }),
    ),
  );
  write(
    "Taskfile.yml",
    `version: '3'\ntasks:\n  check:\n    deps:\n${REQUIRED_CONSUMER_ENFORCEMENT_GATES.map((id) => `      - ${id}`).join("\n")}\n`,
  );
  write(
    ".github/workflows/check.yml",
    `name: checks\non: pull_request\njobs:\n  test:\n    steps:\n${REQUIRED_CONSUMER_ENFORCEMENT_GATES.map((id) => `      - run: deft ${id}`).join("\n")}\n`,
  );
  write("public/index.html", "<h1>Hello</h1>\n");
  write("db/001.sql", "select 1;\n");
  git("add", ".");
  git("commit", "-qm", "base authority");
  const base = git("rev-parse", "HEAD");
  return { root, git, write, base };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("real required gate adapters", () => {
  it("executes all seven and admits a scoped observable change", () => {
    const { root, git, write, base } = repo();
    write("public/index.html", "<h1 class='blue'>Hello</h1>\n");
    git("add", ".");
    git("commit", "-qm", "style");
    const r = evaluatePresentationCoverage({
      projectRoot: root,
      originRef: base,
      planId: "current",
    });
    expect(r.coverage.map((c) => c.gateId).sort()).toEqual([...COMPOSED_GATE_IDS].sort());
    expect(r.code, r.message).toBe(0);
    expect(r.admissions[0]?.ruleId).toBe("observable-scope-mint");
  });
  it("observable refusal, non-adoption and parser config survive composition", () => {
    const { root, git, write, base } = repo();
    write("public/index.html", "<h1>Hello</h1><button>Delete</button>\n");
    git("add", ".");
    const r = evaluatePresentationCoverage({
      projectRoot: root,
      originRef: base,
      staged: true,
      planId: "current",
    });
    expect(r.code, r.message).toBe(1);
    expect(r.coverage.find((c) => c.gateId === "verify:observable-scope")?.code).toBe(1);
  });
  it("uses staged authority and candidate bytes despite opposite unstaged edits", () => {
    const { root, git, write, base } = repo();
    write("public/index.html", "<h1 class='blue'>Hello</h1>\n");
    git("add", ".");
    write("public/index.html", "<h1>Hello</h1><button>Unstaged</button>\n");
    write(".deft/approved-scope/current.json", "malformed unstaged authority");
    const r = evaluatePresentationCoverage({
      projectRoot: root,
      originRef: base,
      staged: true,
      planId: "current",
    });
    expect(r.code, r.message).toBe(0);
    git("add", ".deft/approved-scope/current.json");
    const invalid = evaluatePresentationCoverage({
      projectRoot: root,
      originRef: base,
      staged: true,
      planId: "current",
    });
    expect(invalid.code).toBe(2);
    expect(invalid.message).toContain("invalid approved-scope record");
  });
  it("a base human extension amendment continues only within scoped paths", () => {
    const { root, git, write, base } = repo();
    write("db/001.sql", "select 2;\n");
    git("add", ".");
    const r = evaluatePresentationCoverage({
      projectRoot: root,
      originRef: base,
      staged: true,
      planId: "current",
    });
    expect(r.code, r.message).toBe(0);
    expect(r.admissions[0]?.ruleId).toBe("presentation-extension-amendment");
  });
  it("staged artifact deletion and new artifact addition cannot erase or evade arming", () => {
    const { root, git, write, base } = repo();
    git("rm", ".deft/presentation-ceiling.json");
    expect(
      evaluatePresentationCoverage({ projectRoot: root, originRef: base, staged: true }).code,
    ).toBe(1);
    git("commit", "-qm", "remove");
    const noCeiling = git("rev-parse", "HEAD");
    write(".deft/presentation-ceiling.json", JSON.stringify({ changeClass: "presentation" }));
    write("public/index.html", "<h1>New</h1>\n");
    git("add", ".");
    const r = evaluatePresentationCoverage({
      projectRoot: root,
      originRef: noCeiling,
      staged: true,
      planId: "current",
    });
    expect(r.armed).toBe(true);
    expect(r.code).not.toBe(0);
  });
});

it("keeps invalid policy configuration and parser exceptions as real required failures", () => {
  const { root, git, write } = repo();
  write(".deft/class-checks.policy.json", "{");
  git("add", ".");
  git("commit", "-qm", "invalid baseline policy");
  const base = git("rev-parse", "HEAD");
  write("public/index.html", "<h1 class='blue'>Hello</h1>\n");
  git("add", ".");
  const r = evaluatePresentationCoverage({
    projectRoot: root,
    originRef: base,
    staged: true,
    planId: "current",
  });
  expect(r.code).toBe(2);
  expect(r.coverage.find((c) => c.gateId === "verify:class-checks")).toMatchObject({
    code: 2,
    analyzedPaths: [],
  });
  expect(r.coverage.find((c) => c.gateId === "verify:test-boundary")).toMatchObject({
    code: 2,
    analyzedPaths: [],
  });
});

it("admits a real intent mint only within base extension class and current contract", () => {
  const { root, git, write } = repo();
  const stamp = { kind: "human", actor: "David", mintedAt: "2026-09-28T00:00:00Z" };
  const rel = "xbrief/active/story.xbrief.json";
  const plan = {
    id: "current",
    status: "running",
    items: [],
    metadata: { swarm: { file_scope: ["src/**"] } },
    "x-directive/intentConstraint": { constraints: [] },
  };
  write(rel, JSON.stringify({ plan }));
  write(
    ".deft/presentation-ceiling.json",
    JSON.stringify({
      changeClass: "presentation",
      extensionAmendment: { extensions: [".ts"], humanApproval: stamp },
    }),
  );
  write(
    ".deft/intent-constraint/current.json",
    JSON.stringify(
      buildIntentConstraintRecord({
        planId: "current",
        xbriefRelPath: rel,
        constraints: [],
        humanApproval: stamp,
      }),
    ),
  );
  write("src/save.ts", "export const save = () => 'old';\n");
  git("add", ".");
  git("commit", "-qm", "intent authority");
  const base = git("rev-parse", "HEAD");
  write("src/save.ts", "export const save = () => 'new';\n");
  git("add", ".");
  mkdirSync(join(root, "node_modules"));
  symlinkSync(
    resolve(import.meta.dirname, "../../../../node_modules/typescript"),
    join(root, "node_modules/typescript"),
    "junction",
  );
  const r = evaluatePresentationCoverage({
    projectRoot: root,
    originRef: base,
    staged: true,
    planId: "current",
  });
  expect(r.code, r.message).toBe(0);
  expect(r.admissions[0]).toMatchObject({
    ruleId: "intent-constraint-mint",
    authority: `${base}:.deft/intent-constraint/current.json`,
    prerequisiteAuthority: `${base}:.deft/presentation-ceiling.json#extensionAmendment`,
  });
  write(
    rel,
    JSON.stringify({
      plan: {
        ...plan,
        "x-directive/intentConstraint": {
          constraints: [{ value: "10", unit: "items", rejectionScope: "item" }],
        },
      },
    }),
  );
  git("add", rel);
  expect(
    evaluatePresentationCoverage({
      projectRoot: root,
      originRef: base,
      staged: true,
      planId: "current",
    }).code,
  ).not.toBe(0);
});

it.each([
  "roots",
  "extension",
])("honors head %s tightening on the applicable base SQL amendment", (mode) => {
  const { root, git, write, base } = repo();
  const record = JSON.parse(readFileSync(join(root, ".deft/presentation-ceiling.json"), "utf8"));
  if (mode === "roots") record.componentRoots = ["ui/**"];
  else delete record.extensionAmendment;
  write(".deft/presentation-ceiling.json", JSON.stringify(record));
  write("db/001.sql", "select 2;\n");
  git("add", ".");
  const r = evaluatePresentationCoverage({
    projectRoot: root,
    originRef: base,
    staged: true,
    planId: "current",
  });
  expect(
    r.coverage.every((c) => c.code === 0),
    r.message,
  ).toBe(true);
  expect(r).toMatchObject({
    code: 1,
    compare: { kind: "tightening" },
    uncoveredPaths: ["db/001.sql"],
  });
});

describe("class checks scan only added lines in a composed run (#7077)", () => {
  function seeded() {
    const r = repo();
    r.write(
      ".deft/test-boundary.policy.json",
      JSON.stringify({ sourceRoots: ["public/**"], testRoots: ["tests/**"] }),
    );
    r.write("public/app.js", 'const roots = ["tests/**"];\nconst mode = 1;\n');
    r.git("add", ".");
    r.git("commit", "-qm", "base holds a test-root reference");
    return { ...r, baseline: r.git("rev-parse", "HEAD") };
  }
  const classRow = (root: string, baseline: string) =>
    evaluatePresentationCoverage({
      projectRoot: root,
      originRef: baseline,
      staged: true,
      planId: "current",
    }).coverage.find((c) => c.gateId === "verify:class-checks");

  it("passes an unrelated edit to a file whose base already holds a reference", () => {
    const { root, git, write, baseline } = seeded();
    write("public/app.js", 'const roots = ["tests/**"];\nconst mode = 2;\n');
    git("add", ".");
    expect(classRow(root, baseline)?.code).toBe(0);
  });

  it("fails an added reference line", () => {
    const { root, git, write, baseline } = seeded();
    write("public/app.js", 'const roots = ["tests/**"];\nconst mode = 1;\nconst f = "tests/x";\n');
    git("add", ".");
    expect(classRow(root, baseline)?.code).toBe(1);
  });

  it("fails a reference added after a line that starts with `++ `", () => {
    const { root, git, write, baseline } = seeded();
    write(
      "public/app.js",
      'const roots = ["tests/**"];\nconst mode = 1;\n++ mode;\nconst f = "tests/x";\n',
    );
    git("add", ".");
    const row = classRow(root, baseline);
    expect(row?.code).toBe(1);
    expect(row?.message).toContain("public/app.js");
  });
});

it("evaluates candidate test-boundary tightening against all pinned files", () => {
  const { root, git, write } = repo();
  write("public/test_widget.py", "assert True\n");
  git("add", ".");
  git("commit", "-qm", "existing fixture outside default source roots");
  const baseline = git("rev-parse", "HEAD");
  write(
    ".deft/test-boundary.policy.json",
    JSON.stringify({ sourceRoots: ["public/**"], testRoots: ["tests/**"] }),
  );
  write("public/index.html", "<h1 class='blue'>Hello</h1>\n");
  git("add", ".");
  const r = evaluatePresentationCoverage({
    projectRoot: root,
    originRef: baseline,
    staged: true,
    planId: "current",
  });
  expect(r.coverage.find((c) => c.gateId === "verify:test-boundary")).toMatchObject({
    code: 1,
    analyzedPaths: [],
  });
  expect(r.message).toContain("public/test_widget.py");
  expect(r.code).toBe(1);
});

it.each([
  "base-file",
  "head-file",
  "base-project",
  "head-project",
])("fails closed on invalid class policy shape at %s", (where) => {
  const { root, git, write, base } = repo();
  const path = where.endsWith("file")
    ? ".deft/class-checks.policy.json"
    : "xbrief/PROJECT-DEFINITION.xbrief.json";
  write(
    path,
    where.endsWith("file") ? "[]" : JSON.stringify({ plan: { policy: { classChecks: [] } } }),
  );
  git("add", ".");
  if (where.startsWith("base")) git("commit", "-qm", "invalid base class policy");
  const baseline = where.startsWith("base") ? git("rev-parse", "HEAD") : base;
  write("public/index.html", "<h1 class='blue'>Hello</h1>\n");
  git("add", ".");
  const r = evaluatePresentationCoverage({
    projectRoot: root,
    originRef: baseline,
    staged: true,
    planId: "current",
  });
  expect(r.code).toBe(2);
  expect(r.coverage.find((c) => c.gateId === "verify:class-checks")).toMatchObject({
    code: 2,
    analyzedPaths: [],
  });
  expect(r.message).toContain("must be a JSON object");
});

it("executes real gates for a nested root tightening and keeps outside paths refused", () => {
  const { root, git, write } = repo();
  const rel = ".deft/presentation-ceiling.json";
  const record = JSON.parse(readFileSync(join(root, rel), "utf8"));
  record.componentRoots = ["db/**"];
  write(rel, JSON.stringify(record));
  git("add", ".");
  git("commit", "-qm", "base root");
  const base = git("rev-parse", "HEAD");
  record.componentRoots = ["db/narrow/**"];
  write(rel, JSON.stringify(record));
  write("db/narrow/002.sql", "select 2;\n");
  git("add", ".");
  const options = { projectRoot: root, originRef: base, staged: true, planId: "current" };
  const allowed = evaluatePresentationCoverage(options);
  expect(allowed, allowed.message).toMatchObject({ code: 0, compare: { kind: "tightening" } });
  expect(allowed.coverage).toHaveLength(COMPOSED_GATE_IDS.length);
  expect(allowed.coverage.every((row) => row.code === 0)).toBe(true);
  write("db/001.sql", "select 3;\n");
  git("add", ".");
  expect(evaluatePresentationCoverage(options)).toMatchObject({
    code: 1,
    compare: { kind: "tightening" },
    uncoveredPaths: ["db/001.sql"],
  });
});
