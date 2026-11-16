/**
 * Planning-publication commit admission at the hook decision (#5839 Prefer-A
 * Recut-6 Bound, P1-P4). Seam cases inject staged index entries; real-index
 * cases run `git commit` decisions against a temporary repository through the
 * default staged-path producer.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPlanSequence } from "../plan-sequence/types.js";
import { SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE } from "../scope/transition-hint.js";
import {
  decideHook,
  evaluateProspectiveScopeCover,
  type HookPolicySeams,
  isLifecycleOrInstallerRelPath,
} from "./dispatcher.js";
import type { StagedIndexEntry } from "./planning-publication.js";

const HOST_ENV_PATTERN = /^(CLAUDE|CURSOR_|GROK_|DEFT_|OPENCLAW|WARP_)/;
const savedHostEnv: Record<string, string> = {};
beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!HOST_ENV_PATTERN.test(key)) continue;
    savedHostEnv[key] = process.env[key] as string;
    delete process.env[key];
  }
});
afterAll(() => {
  Object.assign(process.env, savedHostEnv);
});

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

/** The filed denial: an inherited brief that is not ready (missing parent_plan_id). */
const NOT_READY_SCOPE = {
  ready: false,
  path: null,
  message: "Inherited B1 is not ready: missing parent_plan_id.",
};

const NO_ACTIVE_SCOPE = { ready: false, path: null, message: "No active scope." };

const UNRELATED_SCOPE = {
  ready: true,
  path: "/project/xbrief/active/b1.xbrief.json",
  message: "OK active scope",
};

const BLOB = "1".repeat(40);
const ZERO = "0".repeat(40);
const PLAN_BLOB = "2".repeat(40);
const BAD_PLAN_BLOB = "3".repeat(40);
const APPROVED_PLAN_BLOB = "4".repeat(40);

function planText(extra: Record<string, unknown> = {}): string {
  const plan = createPlanSequence({
    sequence_id: "phase-c",
    sequence_kind: "delivery",
    entries: [{ id: "c1", kind: "story", issue: 5839 }],
    authorized_by: "operator",
  });
  return JSON.stringify({ ...plan, ...extra });
}

const BLOBS: Readonly<Record<string, string>> = {
  [PLAN_BLOB]: planText(),
  [BAD_PLAN_BLOB]: planText({ extra_authority: true }),
  [APPROVED_PLAN_BLOB]: planText({
    insert_approvals: [{ entry_id: "c1", grant_id: "g-1", approved_at: "2026-11-16T00:00:00Z" }],
  }),
};

function a(path: string, mode = "100644", blob = BLOB): StagedIndexEntry {
  return { path, kind: "A", mode, blob };
}
function m(path: string, blob = BLOB): StagedIndexEntry {
  return { path, kind: "M", mode: "100644", blob };
}
function d(path: string): StagedIndexEntry {
  return { path, kind: "D", mode: "000000", blob: ZERO };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hook-5839-"));
  temps.push(root);
  return root;
}

function baseSeams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    inspectScope: () => NOT_READY_SCOPE,
    loadStoryWriteFence: () => ({ fileScope: ["src/**"], denyPaths: [] }),
    readStagedBlob: (_root, blob) => BLOBS[blob] ?? null,
    ...overrides,
  };
}

function commitDecision(root: string, seams: HookPolicySeams) {
  return decideHook(
    {
      host: "grok",
      event: "tool.before",
      projectRoot: root,
      payload: { tool_name: "Bash", tool_input: { command: "git commit -m planning" } },
    },
    seams,
  );
}

function decideStaged(
  entries: readonly StagedIndexEntry[],
  overrides: Partial<HookPolicySeams> = {},
) {
  return commitDecision(
    tempRoot(),
    baseSeams({ listStagedIndexEntries: () => ({ ok: true, entries }), ...overrides }),
  );
}

function filedPackage(): StagedIndexEntry[] {
  const entries: StagedIndexEntry[] = [];
  for (let i = 1; i <= 5; i++) {
    entries.push(a(`docs/design/c${String(i)}.md`));
    entries.push(a(`xbrief/proposed/2026-10-22-c${String(i)}.xbrief.json`));
    entries.push(a(`xbrief/decisions/2026-10-22-c${String(i)}.decision.json`));
  }
  return entries;
}

describe("planning-publication admission at the hook decision (#5839)", () => {
  it("clause 1: admits the filed package before the binding and ready-scope guard", () => {
    const inspectScope = vi.fn(() => NOT_READY_SCOPE);
    const decision = decideStaged(filedPackage(), { inspectScope });
    expect(decision.verdict).toBe("allow");
    expect(decision.code).not.toBe("prospective-scope-cover-deny");
    expect(inspectScope).not.toHaveBeenCalled();
    const resolveStoryBinding = vi.fn(() => ({ kind: "none" as const }));
    const cover = evaluateProspectiveScopeCover({
      projectRoot: tempRoot(),
      stagedRelPaths: filedPackage().map((entry) => entry.path),
      stagedEntries: filedPackage(),
      inspectScope,
      resolveStoryBinding,
    });
    expect(cover.ok).toBe(true);
    expect(cover.message).toMatch(/Planning-publication staged set \(15 path\(s\)\).*#5839/);
    expect(resolveStoryBinding).not.toHaveBeenCalled();
  });

  it("clause 1: isLifecycleOrInstallerRelPath is not widened", () => {
    for (const path of ["docs/design/c1.md", "CHANGELOG.md", ".deft/plan-sequence.json"]) {
      expect(isLifecycleOrInstallerRelPath(path), path).toBe(false);
    }
  });

  it("clause 1: the classifier reads raw paths; a paths-only seam gets no admission", () => {
    const pathsOnly = commitDecision(
      tempRoot(),
      baseSeams({ listStagedRelPaths: () => ["docs/design/c1.md"] }),
    );
    expect(pathsOnly).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    // Leading space: the old trim turned it into CHANGELOG.md; the classifier refuses it.
    const spaced = decideStaged([a(" CHANGELOG.md"), a("docs/design/c1.md")]);
    expect(spaced).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    const backslash = decideStaged([a("docs\\design\\c1.md")]);
    expect(backslash).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
  });

  it("P4: not-ready-scope positive with CHANGELOG, a design doc and a pending story", () => {
    const decision = decideStaged([
      m("CHANGELOG.md"),
      a("docs/decisions/c1.md"),
      a("xbrief/pending/c1.xbrief.json"),
    ]);
    expect(decision.verdict).toBe("allow");
  });

  it("P4: plan-sequence-only with no active brief and with an unrelated active brief", () => {
    const plan = [m(".deft/plan-sequence.json", PLAN_BLOB)];
    expect(decideStaged(plan, { inspectScope: () => NO_ACTIVE_SCOPE }).verdict).toBe("allow");
    expect(decideStaged(plan, { inspectScope: () => UNRELATED_SCOPE }).verdict).toBe("allow");
  });

  it("P4: an approved insert (insert_approvals row) can be committed (#6205 seam)", () => {
    const decision = decideStaged([m(".deft/plan-sequence.json", APPROVED_PLAN_BLOB)], {
      inspectScope: () => UNRELATED_SCOPE,
    });
    expect(decision.verdict).toBe("allow");
  });

  it("P4: proposed→completed leftover set with CHANGELOG", () => {
    const decision = decideStaged([
      d("xbrief/proposed/c1.xbrief.json"),
      a("xbrief/completed/c1.xbrief.json"),
      m("CHANGELOG.md"),
    ]);
    expect(decision.verdict).toBe("allow");
  });

  it("P4: root-only second commit keeps today's lifecycle-only return", () => {
    const cover = evaluateProspectiveScopeCover({
      projectRoot: tempRoot(),
      stagedRelPaths: ["xbrief/plan.xbrief.json", "xbrief/specification.xbrief.json"],
      stagedEntries: [m("xbrief/plan.xbrief.json"), m("xbrief/specification.xbrief.json")],
      inspectScope: () => NOT_READY_SCOPE,
    });
    expect(cover.ok).toBe(true);
    expect(cover.message).toMatch(/Lifecycle\/installer-only staged set/);
    expect(
      decideStaged([m("xbrief/plan.xbrief.json"), m("xbrief/PROJECT-DEFINITION.xbrief.json")])
        .verdict,
    ).toBe("allow");
  });

  it("P4: design doc plus a PROJECT-DEFINITION policy edit is denied", () => {
    const decision = decideStaged([
      a("docs/design/c1.md"),
      m("xbrief/PROJECT-DEFINITION.xbrief.json"),
    ]);
    expect(decision).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(decision.message).toContain("no ready running scope for staged paths (#5656)");
  });

  it.each([
    "xbrief/decisions/helper.ts",
    "xbrief/proposed/extra.json",
    "xbrief/proposed/README.md",
    "xbrief/active/.gitkeep",
    "xbrief/active/b1.xbrief.json",
  ])("P4: design doc plus %s is denied", (path) => {
    const decision = decideStaged([a("docs/design/c1.md"), a(path)]);
    expect(decision).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
  });

  it.each([
    "docs/notes.md",
    "docs/design/sub/c1.md",
    "docs/design/c1.yaml",
    "docs/decisions/c1.json",
  ])("P4: docs path outside the inventory (%s) is denied", (path) => {
    const decision = decideStaged([a("docs/design/c1.md"), a(path)]);
    expect(decision).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
  });

  it("P4: deletion polarity", () => {
    expect(
      decideStaged([d("docs/design/old.md"), d("xbrief/decisions/c1.decision.json")]).verdict,
    ).toBe("allow");
    const mixed = decideStaged([d("docs/design/old.md"), d("src/a.ts")]);
    expect(mixed).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
  });

  it("clause 4 (P2): posture-written paths outside the inventory still need a ready scope", () => {
    for (const path of ["REQUIREMENTS.md", "docs/requirements/c.md"]) {
      const cover = evaluateProspectiveScopeCover({
        projectRoot: tempRoot(),
        stagedRelPaths: [path],
        stagedEntries: [a(path)],
        inspectScope: () => NOT_READY_SCOPE,
        env: { DEFT_SESSION_POSTURE: "requirements" },
        resolveStoryBinding: () => ({ kind: "none" }),
      });
      expect(cover.ok, path).toBe(false);
      expect(cover.message).toContain("no ready running scope");
    }
  });

  it("clause 5 (P3): every refuse falls through to today's outcome", () => {
    const notReady = `Recovery: ${SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE}.`;
    for (const entries of [
      [a("docs/design/c1.md", "100755")],
      [a("docs/design/c1.md", "120000")],
      [{ path: "docs/design/c1.md", kind: "T", mode: "120000", blob: BLOB }],
      [m(".deft/plan-sequence.json", BAD_PLAN_BLOB)],
      [m(".deft/plan-sequence.json", "f".repeat(40))],
    ]) {
      const decision = decideStaged(entries);
      expect(decision, JSON.stringify(entries)).toMatchObject({
        verdict: "deny",
        code: "prospective-scope-cover-deny",
      });
      expect(decision.message).toContain(notReady);
    }
    // Ready scope: uncovered deny and covered allow are unchanged.
    const uncovered = decideStaged([a("docs/design/c1.md"), a("src/a.ts")], {
      inspectScope: () => UNRELATED_SCOPE,
    });
    expect(uncovered).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(uncovered.message).toMatch(
      /outside governing file_scope \(#5656\): docs\/design\/c1\.md/,
    );
    const covered = evaluateProspectiveScopeCover({
      projectRoot: tempRoot(),
      stagedRelPaths: ["docs/design/c1.md", "src/a.ts"],
      stagedEntries: [a("docs/design/c1.md"), a("src/a.ts")],
      inspectScope: () => UNRELATED_SCOPE,
      loadStoryWriteFence: () => ({ fileScope: ["**"], denyPaths: [] }),
      resolveStoryBinding: () => ({ kind: "none" }),
    });
    expect(covered.ok).toBe(true);
    expect(covered.message).toMatch(/Prospective scope-cover passed for 2 product staged path/);
  });

  it("clause 6: admission stamps nothing and returns no scope path", () => {
    const root = tempRoot();
    const cover = evaluateProspectiveScopeCover({
      projectRoot: root,
      stagedRelPaths: ["docs/design/c1.md"],
      stagedEntries: [a("docs/design/c1.md")],
      inspectScope: () => NOT_READY_SCOPE,
    });
    expect(cover).toMatchObject({ ok: true, uncovered: [], scopePath: null });
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("planning-publication admission on a real index (#5839 clause 6)", () => {
  function git(root: string, args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd: root, encoding: "utf8", stdio: "pipe" });
  }

  function tryGit(root: string, args: readonly string[]): boolean {
    try {
      git(root, args);
      return true;
    } catch {
      return false;
    }
  }

  function put(root: string, rel: string, text: string): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, "utf8");
  }

  function repo(): string {
    const root = tempRoot();
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@example.com"]);
    git(root, ["config", "user.name", "t"]);
    git(root, ["config", "core.hooksPath", "/dev/null"]);
    put(root, "README.md", "seed\n");
    put(root, "docs/design/t.md", "regular\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "seed"]);
    return root;
  }

  function hashed(root: string, text: string): string {
    put(root, ".tmp-blob", text);
    const sha = git(root, ["hash-object", "-w", ".tmp-blob"]).trim();
    rmSync(join(root, ".tmp-blob"));
    return sha;
  }

  /** Real seams: no staged-path seam, so the default producer and blob reader run. */
  function realSeams(): HookPolicySeams {
    const { readStagedBlob: _unused, ...rest } = baseSeams();
    return rest;
  }

  function listing(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        if (name.name === ".git") continue;
        const abs = join(dir, name.name);
        if (name.isDirectory()) walk(abs);
        else out.push(relative(root, abs));
      }
    };
    walk(root);
    return out.sort();
  }

  it("admits a staged planning set and writes nothing", () => {
    const root = repo();
    put(root, "docs/design/c1.md", "design\n");
    put(root, "xbrief/proposed/c1.xbrief.json", "{}\n");
    put(root, "xbrief/decisions/2026-10-22-c1.decision.json", "{}\n");
    git(root, ["add", "."]);
    const before = listing(root);
    expect(commitDecision(root, realSeams()).verdict).toBe("allow");
    expect(listing(root)).toEqual(before);
  });

  it("denies a symlink entry", () => {
    const root = repo();
    const sha = hashed(root, "docs/design/t.md");
    git(root, ["update-index", "--add", "--cacheinfo", `120000,${sha},docs/design/link.md`]);
    expect(commitDecision(root, realSeams())).toMatchObject({
      verdict: "deny",
      code: "prospective-scope-cover-deny",
    });
  });

  it("denies an executable entry", () => {
    const root = repo();
    put(root, "docs/design/c1.md", "design\n");
    git(root, ["add", "docs/design/c1.md"]);
    git(root, ["update-index", "--chmod=+x", "docs/design/c1.md"]);
    expect(commitDecision(root, realSeams())).toMatchObject({
      verdict: "deny",
      code: "prospective-scope-cover-deny",
    });
  });

  it("denies a typechange entry", () => {
    const root = repo();
    const sha = hashed(root, "README.md");
    git(root, ["update-index", "--cacheinfo", `120000,${sha},docs/design/t.md`]);
    expect(git(root, ["diff", "--cached", "--name-status"])).toMatch(/^T\s/m);
    expect(commitDecision(root, realSeams())).toMatchObject({
      verdict: "deny",
      code: "prospective-scope-cover-deny",
    });
  });

  it("stage-then-edit: the index blob decides, not the working tree", () => {
    const root = repo();
    put(root, ".deft/plan-sequence.json", planText());
    git(root, ["add", ".deft/plan-sequence.json"]);
    put(root, ".deft/plan-sequence.json", "{not json");
    expect(commitDecision(root, realSeams()).verdict).toBe("allow");

    const other = repo();
    put(other, ".deft/plan-sequence.json", planText({ extra_authority: true }));
    git(other, ["add", ".deft/plan-sequence.json"]);
    put(other, ".deft/plan-sequence.json", planText());
    expect(commitDecision(other, realSeams())).toMatchObject({
      verdict: "deny",
      code: "prospective-scope-cover-deny",
    });
  });

  it("denies a malformed plan-sequence", () => {
    const root = repo();
    put(root, ".deft/plan-sequence.json", "not json at all\n");
    git(root, ["add", ".deft/plan-sequence.json"]);
    expect(commitDecision(root, realSeams())).toMatchObject({
      verdict: "deny",
      code: "prospective-scope-cover-deny",
    });
  });

  it("denies a leading-space path that the old trim would turn into CHANGELOG.md", () => {
    const root = repo();
    const sha = hashed(root, "entry\n");
    git(root, ["update-index", "--add", "--cacheinfo", `100644,${sha}, CHANGELOG.md`]);
    expect(commitDecision(root, realSeams())).toMatchObject({
      verdict: "deny",
      code: "prospective-scope-cover-deny",
    });
  });

  it("trailing-CR and backslash paths never reach admission", () => {
    for (const name of ["docs/design/c1.md\r", "docs\\design\\c1.md"]) {
      const root = repo();
      const sha = hashed(root, "design\n");
      // Git for Windows refuses these names; where git stages them, the hook denies.
      const staged = tryGit(root, [
        "-c",
        "core.protectNTFS=false",
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${sha},${name}`,
      ]);
      const verdict = staged ? commitDecision(root, realSeams()).verdict : "deny";
      expect(verdict, JSON.stringify(name)).toBe("deny");
    }
  });
});
