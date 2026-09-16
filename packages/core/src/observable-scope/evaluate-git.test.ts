import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateObservableScope, resolveMergeBase } from "./evaluate.js";
import { buildObservableScopeRecord, writeObservableScopeRecord } from "./mint.js";

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "obs-scope-git-"));
  git(root, ["init", "-q"]);
  git(root, ["checkout", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  return root;
}

function writeTracked(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
  git(root, ["add", "--", rel]);
}

function commit(root: string, msg: string): void {
  git(root, ["commit", "-q", "-m", msg, "--allow-empty"]);
}

const BASE_HTML = `<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;

const POLICY = `{
  "schema": "deft.observable-ui.policy.v1",
  "surfaces": ["ui.html"]
}
`;

const human = {
  kind: "operator" as const,
  actor: "david",
  mintedAt: "2026-09-13T00:00:00Z",
  mintedVia: "scope:record-observable-scope",
};

describe("evaluateObservableScope real git (#4495)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("warns (exit 0) when merge-base has no surfaces policy and UI files change", () => {
    root = initRepo();
    writeTracked(root, "README.md", "hi\n");
    commit(root, "base");
    git(root, ["checkout", "-q", "-b", "feat"]);
    writeTracked(root, "ui.html", BASE_HTML);
    commit(root, "ui");
    const result = evaluateObservableScope({ projectRoot: root, originRef: "main" });
    expect(result.code).toBe(0);
    expect(result.skipped).not.toBe(true);
    expect(result.findings?.some((f) => f.kind === "non-adoption")).toBe(true);
  });

  it("fails matched UI change without a merge-base mint", () => {
    root = initRepo();
    writeTracked(root, ".deft/observable-ui.policy.json", POLICY);
    writeTracked(root, "ui.html", BASE_HTML);
    commit(root, "base policy");
    git(root, ["checkout", "-q", "-b", "feat"]);
    writeTracked(root, "ui.html", `${BASE_HTML}<input name="email" />\n`);
    commit(root, "fields");
    const result = evaluateObservableScope({ projectRoot: root, originRef: "main" });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/without a merge-base/);
  });

  it("passes minted bound-field adds and fails same-PR mint rewrite", () => {
    root = initRepo();
    writeTracked(root, ".deft/observable-ui.policy.json", POLICY);
    writeTracked(root, "ui.html", BASE_HTML);
    const rec = buildObservableScopeRecord({
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [
        { kind: "control", op: "add", name: "email" },
        { kind: "control", op: "add", name: "phone" },
      ],
      humanApproval: human,
    });
    if ("error" in rec) throw new Error(rec.error);
    writeObservableScopeRecord(root, rec);
    git(root, ["add", "--", ".deft/observable-scope/story-1.json"]);
    commit(root, "base mint");
    git(root, ["checkout", "-q", "-b", "feat"]);
    writeTracked(
      root,
      "ui.html",
      `<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<input name="email" />
<input name="phone" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`,
    );
    commit(root, "fields only");
    const pass = evaluateObservableScope({ projectRoot: root, originRef: "main" });
    expect(pass.code).toBe(0);

    writeTracked(
      root,
      ".deft/observable-scope/story-1.json",
      `${JSON.stringify({ ...rec, approvedAt: "2099-01-01T00:00:00Z" }, null, 2)}\n`,
    );
    commit(root, "rewrite mint");
    const rewrite = evaluateObservableScope({ projectRoot: root, originRef: "main" });
    expect(rewrite.code).toBe(1);
    expect(rewrite.message).toMatch(/same-PR rewrite/);
  });

  it("reads HEAD not the dirty working tree in normal mode", () => {
    root = initRepo();
    writeTracked(root, ".deft/observable-ui.policy.json", POLICY);
    writeTracked(root, "ui.html", BASE_HTML);
    const rec = buildObservableScopeRecord({
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: human,
    });
    if ("error" in rec) throw new Error(rec.error);
    writeObservableScopeRecord(root, rec);
    git(root, ["add", "--", ".deft/observable-scope/story-1.json"]);
    commit(root, "base mint");
    git(root, ["checkout", "-q", "-b", "feat"]);
    writeTracked(root, "ui.html", `${BASE_HTML}<input name="email" />\n`);
    commit(root, "fields");
    writeFileSync(
      join(root, "ui.html"),
      `${BASE_HTML}<input name="email" /><button>Extra</button>\n`,
    );
    const result = evaluateObservableScope({ projectRoot: root, originRef: "main" });
    expect(result.code).toBe(0);
  });

  it("reads the index not the dirty working tree in staged mode", () => {
    root = initRepo();
    writeTracked(root, ".deft/observable-ui.policy.json", POLICY);
    writeTracked(root, "ui.html", BASE_HTML);
    const rec = buildObservableScopeRecord({
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: human,
    });
    if ("error" in rec) throw new Error(rec.error);
    writeObservableScopeRecord(root, rec);
    git(root, ["add", "--", ".deft/observable-scope/story-1.json"]);
    commit(root, "base mint");
    git(root, ["checkout", "-q", "-b", "feat"]);
    writeFileSync(join(root, "ui.html"), `${BASE_HTML}<input name="email" />\n`);
    git(root, ["add", "--", "ui.html"]);
    writeFileSync(
      join(root, "ui.html"),
      `${BASE_HTML}<input name="email" /><button>Extra</button>\n`,
    );
    const result = evaluateObservableScope({ projectRoot: root, originRef: "main", staged: true });
    expect(result.code).toBe(0);
  });

  it("resolveMergeBase errors when git has no origin default", () => {
    root = mkdtempSync(join(tmpdir(), "obs-scope-nogit-"));
    const resolved = resolveMergeBase(root);
    expect(resolved).toMatchObject({ error: expect.stringMatching(/merge-base|origin default/) });
  });

  it("does not treat a working-tree mint as merge-base authority (#4588)", () => {
    root = initRepo();
    writeTracked(root, ".deft/observable-ui.policy.json", POLICY);
    writeTracked(root, "ui.html", BASE_HTML);
    commit(root, "base policy");
    git(root, ["checkout", "-q", "-b", "feat"]);
    writeTracked(root, "ui.html", `${BASE_HTML}<input name=email />`);
    commit(root, "fields");
    const rec = buildObservableScopeRecord({
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: human,
    });
    if ("error" in rec) throw new Error(rec.error);
    writeObservableScopeRecord(root, rec);
    const result = evaluateObservableScope({ projectRoot: root, originRef: "main" });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/without a merge-base/);
    expect(result.message).toMatch(/#4588/);
  });

  it("does not treat approved-scope digest as observable mint (#4588)", () => {
    root = initRepo();
    writeTracked(root, ".deft/observable-ui.policy.json", POLICY);
    writeTracked(root, "ui.html", BASE_HTML);
    writeTracked(root, ".deft/approved-scope/story-1.json", '{ "planId": "story-1" }');
    commit(root, "base policy plus approved-scope");
    git(root, ["checkout", "-q", "-b", "feat"]);
    writeTracked(root, "ui.html", `${BASE_HTML}<input name=email />`);
    commit(root, "fields");
    const result = evaluateObservableScope({ projectRoot: root, originRef: "main" });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/without a merge-base/);
    expect(result.message).not.toMatch(/approved-scope/);
  });
});
