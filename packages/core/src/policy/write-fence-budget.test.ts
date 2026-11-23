import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRefusalDeclarations } from "../refusal-declarations/table.js";
import {
  evaluateApprovedScopeMembership,
  evaluateProductionScopeFence,
} from "../scope-provenance/base-fence.js";
import { buildApprovedScopeRecord } from "../scope-provenance/digest.js";
import type { StoryWriteFenceView } from "./write-fence.js";
import { resolveStoryWriteAllow, type WriteFenceGit } from "./write-fence-budget.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function write(root: string, rel: string, body = "x\n"): void {
  const full = join(root, ...rel.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

/** Repo with base files committed; returns root and the base sha. */
function repo(baseFiles: Record<string, string>): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "wf-budget-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  for (const [rel, body] of Object.entries(baseFiles)) write(root, rel, body);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base", "--allow-empty"]);
  return { root, sha: git(root, ["rev-parse", "HEAD"]).trim() };
}

function fence(sha: string, fileScope: string[], extra: Partial<StoryWriteFenceView> = {}) {
  return { fileScope, denyPaths: [], mergeBaseSha: sha, planId: "story-1", ...extra };
}

const BASE = {
  "packages/core/src/a.ts": "a\n",
  "packages/core/src/x/bank.test.ts": "old\n",
  "packages/core/src/y.test.ts": "old\n",
  "tests/fixtures/data.json": "{}\n",
};

describe("resolveStoryWriteAllow (#6221)", () => {
  it("keeps today's fence when the fence carries no merge base", () => {
    const d = resolveStoryWriteAllow({
      projectRoot: ".",
      fence: { fileScope: ["a.ts"], denyPaths: [] },
      targets: ["b.ts"],
    });
    expect(d.kind).toBe("unchanged");
  });

  it("admits declared targets and CHANGELOG entries without an inventory", () => {
    const calls: string[][] = [];
    const fake: WriteFenceGit = (_root, args) => {
      calls.push([...args]);
      return { code: 1, stdout: "" };
    };
    const d = resolveStoryWriteAllow({
      projectRoot: ".",
      fence: fence("abc", ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/a.ts", "changelog.d/1-x.md", null],
      git: fake,
    });
    expect(d).toEqual({
      kind: "scope",
      storyAllow: ["packages/core/src/a.ts", "changelog.d/1-x.md"],
      assessment: null,
    });
    // Only the merge-base mint probe ran.
    expect(calls.map((c) => c[0])).toEqual(["cat-file"]);
  });

  it("admits one undeclared test modify (the #5710 case)", () => {
    const { root, sha } = repo(BASE);
    const d = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/x/bank.test.ts"],
    });
    expect(d.kind).toBe("scope");
    if (d.kind !== "scope") return;
    expect(d.storyAllow).toEqual(["packages/core/src/x/bank.test.ts"]);
    expect(d.assessment?.allowance).toBe(2);
  });

  it("reads a staged deletion from the index, not the working tree, in commit mode", () => {
    const { root, sha } = repo(BASE);
    git(root, ["rm", "-q", "--cached", "packages/core/src/y.test.ts"]);
    // Recreated on disk but not staged: the staged change is still a delete.
    write(root, "packages/core/src/y.test.ts", "again\n");
    const d = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/y.test.ts"],
      mode: "commit",
    });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toContain("extra-path-not-admitted");
  });

  it("matches a non-ASCII base fixture name and spends one allowance", () => {
    const rel = "tests/fixtures/café.json";
    const { root, sha } = repo({ ...BASE, [rel]: "{}\n" });
    write(root, rel, '{"a":1}\n');
    const d = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/a.ts"]),
      targets: [rel],
    });
    expect(d.kind).toBe("scope");
  });

  it("looks up the basename-keyed mint for a brief with no plan.id", () => {
    const calls: string[][] = [];
    const fake: WriteFenceGit = (_root, args) => {
      calls.push([...args]);
      return { code: 1, stdout: "" };
    };
    resolveStoryWriteAllow({
      projectRoot: ".",
      fence: {
        fileScope: ["packages/core/src/a.ts"],
        denyPaths: [],
        mergeBaseSha: "abc",
        briefRel: "xbrief/active/story-x.xbrief.json",
      },
      targets: ["packages/core/src/b.ts"],
      git: fake,
    });
    expect(calls[0]).toEqual(["cat-file", "-e", "abc:.deft/approved-scope/story-x.json"]);
  });

  it("refuses a new undeclared test file with extra-path-not-admitted", () => {
    const { root, sha } = repo(BASE);
    const d = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/new.test.ts"],
    });
    expect(d.kind).toBe("refuse");
    if (d.kind !== "refuse") return;
    expect(d.reason).toContain("extra-path-not-admitted");
    expect(d.reason).toContain("packages/core/src/new.test.ts");
  });

  describe("continue checkpoint refusal text (#6914)", () => {
    const SPLIT = "Split the extra paths to a follow-up story";

    it("names a refused checkpoint with no split or widen remedy", () => {
      const { root, sha } = repo(BASE);
      for (const cp of ["xbrief/continue.xbrief.json", "vbrief/continue.vbrief.json"]) {
        const d = resolveStoryWriteAllow({
          projectRoot: root,
          fence: fence(sha, ["packages/core/src/a.ts"]),
          targets: [cp],
        });
        expect(d.kind).toBe("refuse");
        if (d.kind !== "refuse") continue;
        expect(d.reason).toContain("extra-path-not-admitted");
        expect(d.reason).toContain(`\`${cp}\` is the continue checkpoint`);
        expect(d.reason).toContain("Write the checkpoint separately");
        expect(d.reason).not.toContain(SPLIT);
        expect(d.reason).not.toContain("widened concrete brief");
      }
    });

    it("keeps the shared remedy for the other refused paths in a mixed write", () => {
      const { root, sha } = repo(BASE);
      const d = resolveStoryWriteAllow({
        projectRoot: root,
        fence: fence(sha, ["packages/core/src/a.ts"]),
        targets: ["xbrief/continue.xbrief.json", "docs/notes.md"],
      });
      expect(d.kind).toBe("refuse");
      if (d.kind !== "refuse") return;
      expect(d.reason).toContain("is the continue checkpoint");
      expect(d.reason).toContain(`For the other paths: ${SPLIT}`);
    });

    it("leaves a non-checkpoint refusal unchanged, including a case variant", () => {
      const { root, sha } = repo(BASE);
      for (const target of ["docs/notes.md", "XBRIEF/continue.xbrief.json"]) {
        const d = resolveStoryWriteAllow({
          projectRoot: root,
          fence: fence(sha, ["packages/core/src/a.ts"]),
          targets: [target],
        });
        expect(d.kind).toBe("refuse");
        if (d.kind !== "refuse") continue;
        expect(d.reason).toContain(SPLIT);
        expect(d.reason).not.toContain("continue checkpoint");
      }
    });

    it("never counts a saved checkpoint in the inventory, even under sourceRoots **", () => {
      const { root, sha } = repo(BASE);
      const input = {
        projectRoot: root,
        fence: fence(sha, ["packages/core/src/a.ts"]),
        targets: ["packages/core/src/c.ts"],
        roots: { sourceRoots: ["**"] },
      };
      write(root, "packages/core/src/b.ts", "b\n");
      write(root, "xbrief/continue.xbrief.json", "{}\n");
      write(root, "vbrief/continue.vbrief.json", "{}\n");
      // b.ts and c.ts spend the allowance of 2; the checkpoints spend nothing.
      const d = resolveStoryWriteAllow(input);
      expect(d.kind).toBe("scope");
      if (d.kind === "scope") {
        expect(d.assessment?.spent).toEqual(["packages/core/src/b.ts", "packages/core/src/c.ts"]);
      }
      // Control: any other untracked path under ** does spend.
      write(root, "xbrief/notes.json", "{}\n");
      expect(resolveStoryWriteAllow(input).kind).toBe("refuse");
    });

    it("uses the checkpoint text on a declared enforce-mode refusal", () => {
      const { root, sha } = repo(BASE);
      const d = resolveStoryWriteAllow({
        projectRoot: root,
        fence: fence(sha, ["xbrief/**"]),
        targets: ["xbrief/continue.xbrief.json"],
        refusalRows: loadRefusalDeclarations().map((row) => ({ ...row, mode: "enforce" as const })),
      });
      expect(d.kind).toBe("refuse");
      if (d.kind !== "refuse") return;
      expect(d.reason).toContain("is the continue checkpoint");
      expect(d.reason).not.toContain(SPLIT);
    });
  });

  it("refuses other-class undeclared paths", () => {
    const { root, sha } = repo(BASE);
    const d = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/a.ts"]),
      targets: ["docs/notes.md"],
    });
    expect(d.kind).toBe("refuse");
  });

  it("counts the cumulative change set; a new extra past the budget refuses, a rewrite does not", () => {
    const { root, sha } = repo(BASE);
    // Two extras already spent in the working tree (one staged, one untracked).
    write(root, "packages/core/src/y.test.ts", "changed\n");
    git(root, ["add", "packages/core/src/y.test.ts"]);
    write(root, "packages/core/src/b.ts", "new\n");
    const f = fence(sha, ["packages/core/src/a.ts"]);
    const over = resolveStoryWriteAllow({
      projectRoot: root,
      fence: f,
      targets: ["packages/core/src/x/bank.test.ts"],
    });
    expect(over.kind).toBe("refuse");
    if (over.kind === "refuse") expect(over.reason).toContain("extra-paths-over-budget");
    const rewrite = resolveStoryWriteAllow({
      projectRoot: root,
      fence: f,
      targets: ["packages/core/src/b.ts"],
    });
    expect(rewrite.kind).toBe("scope");
  });

  it("refuses closed when the inventory cannot be read", () => {
    const fake: WriteFenceGit = (_root, args) => {
      if (args[0] === "cat-file") return { code: 1, stdout: "" };
      return { code: 128, stdout: "" };
    };
    const d = resolveStoryWriteAllow({
      projectRoot: ".",
      fence: fence("abc", ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/b.ts"],
      git: fake,
    });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toMatch(/fail closed/);
  });

  it("refuses closed when the merge-base tree cannot be listed", () => {
    const fake: WriteFenceGit = (_root, args) => {
      if (args[0] === "cat-file") return { code: 1, stdout: "" };
      if (args[0] === "ls-tree") return { code: 128, stdout: "" };
      return { code: 0, stdout: "" };
    };
    const d = resolveStoryWriteAllow({
      projectRoot: ".",
      fence: fence("abc", ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/z.test.ts"],
      git: fake,
    });
    expect(d.kind).toBe("refuse");
  });

  it("treats a glob match as an extra without a mint", () => {
    const { root, sha } = repo(BASE);
    const input = {
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/**"]),
      targets: ["packages/core/src/c.ts", "packages/core/src/d.ts", "packages/core/src/e.ts"],
    };
    const enforced = resolveStoryWriteAllow({
      ...input,
      refusalRows: loadRefusalDeclarations().map((row) => ({ ...row, mode: "enforce" as const })),
    });
    expect(enforced.kind).toBe("refuse");
    if (enforced.kind === "refuse") expect(enforced.reason).toContain("extra-paths-over-budget");
    // The glob admitted these before #6221: the new refusal warns for one release (#6281).
    const warned = resolveStoryWriteAllow(input);
    expect(warned.kind).toBe("scope");
    if (warned.kind === "scope") {
      expect(warned.storyAllow).toEqual(input.targets);
      expect(warned.warnings?.[0]).toContain("deft gate extra-paths-over-budget");
      expect(warned.warnings?.[0]).toContain("can refuse from a later release");
    }
  });

  it("honors a basename-keyed mint only for the same-named brief (no plan.id)", () => {
    const mint = (xbriefRelPath: string) =>
      `${JSON.stringify(
        buildApprovedScopeRecord({
          xbriefRelPath,
          payload: {
            plan: { id: "story", metadata: { swarm: { file_scope: ["packages/core/src/**"] } } },
          },
          humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-01T00:00:00Z" },
        }),
      )}\n`;
    const run = (xbriefRelPath: string, briefRel = "xbrief/active/story.xbrief.json") => {
      const { root, sha } = repo({
        ...BASE,
        ".deft/approved-scope/story.json": mint(xbriefRelPath),
      });
      return resolveStoryWriteAllow({
        projectRoot: root,
        fence: {
          fileScope: ["packages/core/src/a.ts", "packages/core/src/sub/**"],
          denyPaths: [],
          mergeBaseSha: sha,
          briefRel,
        },
        targets: ["packages/core/src/sub/k.ts"],
      });
    };
    const own = run("xbrief/active/story.xbrief.json");
    expect(own).toMatchObject({ kind: "scope", assessment: null });
    const other = run("xbrief/active/other.xbrief.json");
    expect(other.kind).toBe("scope");
    if (other.kind === "scope") expect(other.assessment).not.toBeNull();
  });

  it("keeps a target ending in whitespace distinct from the trimmed declared path", () => {
    const fake: WriteFenceGit = () => ({ code: 1, stdout: "" });
    const d = resolveStoryWriteAllow({
      projectRoot: ".",
      fence: fence("abc", ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/a.ts "],
      git: (root, args) => (args[0] === "cat-file" ? fake(root, args) : { code: 0, stdout: "" }),
    });
    expect(d.kind).toBe("scope");
    if (d.kind !== "scope") return;
    // Not the declared a.ts: it is an extra and spends the allowance.
    expect(d.assessment).not.toBeNull();
    expect(d.assessment?.spent).toEqual(["packages/core/src/a.ts "]);
  });

  it("write fence, membership and the Path-independent check grant one budget under a mint (#6221)", () => {
    const brief = [1, 2, 3, 4, 5].map((n) => `packages/core/src/p${String(n)}.ts`);
    const tests = ["tests/t1.test.ts", "tests/t2.test.ts", "tests/t3.test.ts"];
    const mintScope = ["packages/core/src/**"];
    const record = `${JSON.stringify(
      buildApprovedScopeRecord({
        xbriefRelPath: "xbrief/active/story-1.xbrief.json",
        payload: { plan: { id: "story-1", metadata: { swarm: { file_scope: mintScope } } } },
        humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-01T00:00:00Z" },
      }),
    )}\n`;
    const base: Record<string, string> = {
      ".deft/approved-scope/story-1.json": record,
      ...Object.fromEntries(tests.map((t) => [t, "old\n"])),
    };
    const { root, sha } = repo(base);
    for (const t of tests) write(root, t, "new\n");
    const write3 = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, brief),
      targets: tests,
    });
    // Five concrete production paths in the brief: allowance 5, three modifies fit.
    expect(write3.kind).toBe("scope");
    if (write3.kind === "scope") expect(write3.assessment?.allowance).toBe(5);
    const changeKind = () => "modify" as const;
    const pathIndependent = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story-1.xbrief.json",
      planId: "story-1",
      baseFileScope: brief,
      mintFileScope: mintScope,
      changedFiles: tests,
      changeKind,
    });
    expect(pathIndependent).toBeNull();
    const membershipInput = {
      xbriefRelPath: "xbrief/active/story-1.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: mintScope,
      allowlistAuthority: "mint" as const,
      changedFiles: ["xbrief/active/story-1.xbrief.json", ...tests],
      changeKind,
    };
    // Without the merge-base brief the mint alone counts zero concrete paths (allowance 2).
    expect(evaluateApprovedScopeMembership(membershipInput)).not.toBeNull();
    expect(
      evaluateApprovedScopeMembership({ ...membershipInput, allowanceScope: brief }),
    ).toBeNull();
  });

  it("rejects a same-leaf mint in a different directory, as the PR check does", () => {
    const mint = `${JSON.stringify(
      buildApprovedScopeRecord({
        xbriefRelPath: "elsewhere/story.xbrief.json",
        payload: {
          plan: { id: "story", metadata: { swarm: { file_scope: ["packages/core/src/**"] } } },
        },
        humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-01T00:00:00Z" },
      }),
    )}\n`;
    const { root, sha } = repo({ ...BASE, ".deft/approved-scope/story.json": mint });
    const d = resolveStoryWriteAllow({
      projectRoot: root,
      fence: {
        fileScope: ["packages/core/src/a.ts", "packages/core/src/sub/**"],
        denyPaths: [],
        mergeBaseSha: sha,
        briefRel: "xbrief/active/story.xbrief.json",
      },
      targets: ["packages/core/src/sub/k.ts"],
    });
    expect(d.kind).toBe("scope");
    if (d.kind === "scope") expect(d.assessment).not.toBeNull();
  });

  it("honors a pre-move mint path when the brief moved to completed (lifecycle move)", () => {
    const mint = `${JSON.stringify(
      buildApprovedScopeRecord({
        xbriefRelPath: "xbrief/active/story.xbrief.json",
        payload: {
          plan: { id: "story", metadata: { swarm: { file_scope: ["packages/core/src/**"] } } },
        },
        humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-01T00:00:00Z" },
      }),
    )}\n`;
    const { root, sha } = repo({ ...BASE, ".deft/approved-scope/story.json": mint });
    const d = resolveStoryWriteAllow({
      projectRoot: root,
      fence: {
        fileScope: ["packages/core/src/a.ts", "packages/core/src/sub/**"],
        denyPaths: [],
        mergeBaseSha: sha,
        briefRel: "xbrief/completed/story.xbrief.json",
      },
      targets: ["packages/core/src/sub/k.ts"],
    });
    expect(d).toMatchObject({ kind: "scope", assessment: null });
  });

  it("uses the merge-base mint with globs, intersected with the brief", () => {
    const record = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: {
        plan: { id: "story-1", metadata: { swarm: { file_scope: ["packages/core/src/**"] } } },
      },
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-01T00:00:00Z" },
    });
    const { root, sha } = repo({
      ...BASE,
      ".deft/approved-scope/story-1.json": `${JSON.stringify(record)}\n`,
    });
    const inBoth = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/a.ts", "packages/core/src/sub/**"]),
      targets: ["packages/core/src/sub/k.ts"],
    });
    expect(inBoth).toEqual({
      kind: "scope",
      storyAllow: ["packages/core/src/sub/k.ts"],
      assessment: null,
    });
    const mintOnly = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/q.ts"],
    });
    // Matches the mint but not the brief: an extra that spends the budget.
    expect(mintOnly.kind).toBe("scope");
    if (mintOnly.kind === "scope")
      expect(mintOnly.assessment?.spent).toEqual(["packages/core/src/q.ts"]);
  });

  it("refuses closed on an invalid merge-base mint", () => {
    const { root, sha } = repo({ ...BASE, ".deft/approved-scope/story-1.json": "{ not json\n" });
    const d = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/a.ts"],
    });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toMatch(/invalid/);
  });

  it("refuses closed when the mint read fails after the probe", () => {
    const fake: WriteFenceGit = (_root, args) =>
      args[0] === "cat-file" ? { code: 0, stdout: "" } : { code: 128, stdout: "" };
    const d = resolveStoryWriteAllow({
      projectRoot: ".",
      fence: fence("abc", ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/a.ts"],
      git: fake,
    });
    expect(d.kind).toBe("refuse");
  });

  it("uses the admitted one-PR mint fence as mint authority (#6361)", () => {
    const calls: string[][] = [];
    const fake: WriteFenceGit = (_root, args) => {
      calls.push([...args]);
      return { code: 1, stdout: "" };
    };
    const d = resolveStoryWriteAllow({
      projectRoot: ".",
      fence: fence("abc", ["packages/core/src/a.ts"], { onePrMint: { admitted: true } }),
      targets: ["packages/core/src/a.ts"],
      git: fake,
    });
    expect(d.kind).toBe("scope");
    expect(calls).toEqual([]);
  });

  it("commit mode: a staged delete of an undeclared test refuses", () => {
    const { root, sha } = repo(BASE);
    git(root, ["rm", "-q", "packages/core/src/y.test.ts"]);
    const d = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/y.test.ts"],
      mode: "commit",
    });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toMatch(/delete/);
  });

  it("commit mode: a staged change past the budget refuses even though it is in the inventory", () => {
    const { root, sha } = repo(BASE);
    for (const rel of [
      "packages/core/src/b.ts",
      "packages/core/src/c.ts",
      "packages/core/src/d.ts",
    ]) {
      write(root, rel, "n\n");
      git(root, ["add", rel]);
    }
    const d = resolveStoryWriteAllow({
      projectRoot: root,
      fence: fence(sha, ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/b.ts", "packages/core/src/c.ts", "packages/core/src/d.ts"],
      mode: "commit",
      roots: {},
    });
    expect(d.kind).toBe("refuse");
  });

  it("leaves excluded paths (merge arrivals) out of the inventory", () => {
    const { root, sha } = repo(BASE);
    for (const rel of ["packages/core/src/m1.ts", "packages/core/src/m2.ts"]) {
      write(root, rel, "from master\n");
      git(root, ["add", rel]);
    }
    const f = fence(sha, ["packages/core/src/a.ts"]);
    const counted = resolveStoryWriteAllow({
      projectRoot: root,
      fence: f,
      targets: ["packages/core/src/x/bank.test.ts"],
    });
    expect(counted.kind).toBe("refuse");
    const excluded = resolveStoryWriteAllow({
      projectRoot: root,
      fence: f,
      targets: ["packages/core/src/x/bank.test.ts"],
      excludeFromInventory: ["packages/core/src/m1.ts", "packages/core/src/m2.ts"],
    });
    expect(excluded.kind).toBe("scope");
  });

  it("never throws: a git seam that throws refuses closed", () => {
    const d = resolveStoryWriteAllow({
      projectRoot: ".",
      fence: fence("abc", ["packages/core/src/a.ts"]),
      targets: ["packages/core/src/a.ts"],
      git: () => {
        throw new Error("boom");
      },
    });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toContain("boom");
  });
});
