import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  applySyncDefault,
  cutSyncLegs,
  FORBIDDEN_SYNC_PR_RETARGET,
  formatSyncDefaultHuman,
  parseGithubOwnerRepo,
  planSyncDefault,
  type SyncDefaultForge,
  type SyncDefaultOpenPull,
  syncDefaultBranchName,
  syncDefaultPrBody,
} from "./sync-default.js";

const DEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const M1 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const M2 = "cccccccccccccccccccccccccccccccccccccccc";
const TIP = "dddddddddddddddddddddddddddddddddddddddd";

function makeProject(policy?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "sync-default-"));
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "P",
        status: "running",
        policy: policy ?? { deliveryBranch: "master", baseBranch: "develop" },
      },
    }),
    "utf8",
  );
  return root;
}

function manyFiles(n: number): string {
  return Array.from({ length: n }, (_, i) => `f${i}.ts`).join("\n");
}

function gitForPlan(options: {
  readonly counts: Readonly<Record<string, number>>;
  readonly commits?: string;
  readonly destPolicy?: Record<string, unknown>;
  readonly sourceEqualsDest?: boolean;
  readonly fetchSourceFail?: boolean;
  readonly destContainsSource?: boolean;
}): GitRunner {
  return (_cwd, args) => {
    if (args[0] === "symbolic-ref") {
      return { code: 0, stdout: "origin/master", stderr: "" };
    }
    if (args[0] === "fetch") {
      if (options.fetchSourceFail === true && args.includes("develop")) {
        return { code: 1, stdout: "", stderr: "fetch failed" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "show" && typeof args[1] === "string" && args[1].includes(":")) {
      if (options.sourceEqualsDest === true) {
        return {
          code: 0,
          stdout: JSON.stringify({
            plan: { title: "P", status: "running", policy: { deliveryBranch: "master" } },
          }),
          stderr: "",
        };
      }
      const policy = options.destPolicy ?? { deliveryBranch: "master", baseBranch: "develop" };
      return {
        code: 0,
        stdout: JSON.stringify({ plan: { title: "P", status: "running", policy } }),
        stderr: "",
      };
    }
    if (args[0] === "show-ref") {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("origin/develop")) {
      return { code: 0, stdout: TIP, stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("origin/master")) {
      return { code: 0, stdout: DEST, stderr: "" };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      const ancestor = args[2] ?? "";
      const descendant = args[3] ?? "";
      if (options.destContainsSource === true && ancestor === TIP && descendant === DEST) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (ancestor === descendant) return { code: 0, stdout: "", stderr: "" };
      if (ancestor === DEST) return { code: 0, stdout: "", stderr: "" };
      if (descendant === "origin/develop" || descendant === TIP) {
        if (ancestor === TIP || ancestor === M1 || ancestor === M2 || ancestor === DEST) {
          return { code: 0, stdout: "", stderr: "" };
        }
      }
      const order = [DEST, M1, M2, TIP];
      const ai = order.indexOf(ancestor);
      const di = order.indexOf(descendant);
      if (ai >= 0 && di >= 0 && ai < di) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "log") {
      return {
        code: 0,
        stdout: options.commits ?? `${M1}\t${DEST} other\n${M2}\t${M1} other\n${TIP}\t${M2}\n`,
        stderr: "",
      };
    }
    if (args[0] === "diff" && args.includes("--name-only")) {
      const range = args[args.length - 1] ?? "";
      const count = options.counts[range];
      if (count === undefined) {
        return { code: 1, stdout: "", stderr: `no count for ${range}` };
      }
      return { code: 0, stdout: manyFiles(count), stderr: "" };
    }
    if (args[0] === "push") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: args.join(" ") };
  };
}

describe("cutSyncLegs (#3391)", () => {
  it("returns one tip leg when the full range is under the threshold", () => {
    const cut = cutSyncLegs({
      dest: "master",
      source: "develop",
      destRef: "origin/master",
      sourceSha: TIP,
      commits: [
        { sha: M1, isMerge: true },
        { sha: TIP, isMerge: false },
      ],
      threshold: 400,
      countFiles: () => 40,
    });
    expect(cut.error).toBeNull();
    expect(cut.legs).toHaveLength(1);
    expect(cut.legs[0]?.sha).toBe(TIP);
    expect(cut.legs[0]?.cutKind).toBe("tip");
    expect(cut.legs[0]?.fileCount).toBe(40);
  });

  it("cuts at merge commits so each dest-based remaining range is at or under the threshold", () => {
    const counts: Record<string, number> = {
      [`origin/master...${TIP}`]: 900,
      [`origin/master...${M1}`]: 200,
      [`origin/master...${M2}`]: 450,
      [`${M1}...${TIP}`]: 700,
      [`${M1}...${M2}`]: 250,
      [`${M2}...${TIP}`]: 200,
    };
    const cut = cutSyncLegs({
      dest: "master",
      source: "develop",
      destRef: "origin/master",
      sourceSha: TIP,
      commits: [
        { sha: M1, isMerge: true },
        { sha: M2, isMerge: true },
        { sha: TIP, isMerge: false },
      ],
      threshold: 400,
      countFiles: (left, right) => counts[`${left}...${right}`] ?? null,
    });
    expect(cut.error).toBeNull();
    expect(cut.legs.map((leg) => [leg.sha, leg.fileCount, leg.cutKind])).toEqual([
      [M1, 200, "merge"],
      [M2, 250, "merge"],
      [TIP, 200, "tip"],
    ]);
    for (const leg of cut.legs) {
      expect(leg.fileCount).toBeLessThanOrEqual(400);
      expect(leg.branchName).toContain(`leg-${leg.index}-`);
    }
  });

  it("skips side-branch commits that are not descendants of the previous cut", () => {
    const side = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const cut = cutSyncLegs({
      dest: "master",
      source: "develop",
      destRef: "origin/master",
      sourceSha: TIP,
      commits: [
        { sha: M1, isMerge: true },
        { sha: side, isMerge: true },
        { sha: M2, isMerge: true },
        { sha: TIP, isMerge: false },
      ],
      threshold: 400,
      countFiles: (left, right) => {
        if (left === "origin/master" && right === side) return 500;
        if (left === "origin/master" && right === M1) return 200;
        if (left === "origin/master" && right === M2) return 450;
        if (left === "origin/master" && right === TIP) return 900;
        if (left === M1 && right === M2) return 250;
        if (left === M1 && right === TIP) return 700;
        if (left === M2 && right === TIP) return 200;
        return 900;
      },
      isAncestor: (ancestor, descendant) => {
        if (ancestor === M1) return descendant === M2 || descendant === TIP;
        return true;
      },
    });
    expect(cut.legs.map((leg) => leg.sha)).toEqual([M1, M2, TIP]);
    expect(cut.legs.some((leg) => leg.sha === side)).toBe(false);
  });

  it("falls back to a non-merge commit when no merge fits", () => {
    const c1 = "1111111111111111111111111111111111111111";
    const cut = cutSyncLegs({
      dest: "master",
      source: "develop",
      destRef: "origin/master",
      sourceSha: TIP,
      commits: [
        { sha: c1, isMerge: false },
        { sha: TIP, isMerge: false },
      ],
      threshold: 10,
      countFiles: (left, right) => {
        if (right === c1) return 8;
        if (left === c1 && right === TIP) return 7;
        return 20;
      },
    });
    expect(cut.legs[0]?.cutKind).toBe("commit");
    expect(cut.legs[0]?.sha).toBe(c1);
    expect(cut.legs[1]?.sha).toBe(TIP);
  });
});

describe("planSyncDefault (#3391)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("no-ops when the detector says source equals dest", () => {
    root = makeProject({ deliveryBranch: "master" });
    const plan = planSyncDefault({
      projectRoot: root,
      runGit: gitForPlan({
        sourceEqualsDest: true,
        counts: { "origin/master...origin/develop": 900 },
      }),
    });
    expect(plan.action).toBe("noop");
    expect(plan.noopReason).toBe("not-sync");
    expect(plan.legs).toEqual([]);
    expect(plan.message).toContain("no-op");
  });

  it("no-ops when dest already contains the source tip", () => {
    root = makeProject();
    const plan = planSyncDefault({
      projectRoot: root,
      runGit: gitForPlan({
        destContainsSource: true,
        counts: { "origin/master...origin/develop": 12 },
      }),
    });
    expect(plan.action).toBe("noop");
    expect(plan.noopReason).toBe("already-synced");
  });

  it("fetches the typed dest after dest-ref resolve", () => {
    root = makeProject();
    const fetched: string[] = [];
    const base = gitForPlan({
      counts: {
        "origin/master...origin/develop": 12,
        [`origin/master...${TIP}`]: 12,
      },
    });
    const runGit: GitRunner = (cwd, args) => {
      if (args[0] === "fetch") fetched.push(args[args.length - 1] ?? "");
      return base(cwd, args);
    };
    planSyncDefault({ projectRoot: root, runGit });
    expect(fetched).toContain("master");
    expect(fetched).toContain("develop");
  });

  it("plans one dest-targeted PR when the file count is under the limit", () => {
    root = makeProject();
    const plan = planSyncDefault({
      projectRoot: root,
      runGit: gitForPlan({
        counts: {
          "origin/master...origin/develop": 12,
          [`origin/master...${TIP}`]: 12,
        },
      }),
    });
    expect(plan.action).toBe("single");
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]?.sha).toBe(TIP);
    expect(plan.nextLegIndex).toBe(1);
    expect(plan.message).toContain("one new PR");
  });

  it("plans merge-commit legs when over syncMaxFiles", () => {
    root = makeProject();
    const plan = planSyncDefault({
      projectRoot: root,
      runGit: gitForPlan({
        counts: {
          "origin/master...origin/develop": 900,
          [`origin/master...${TIP}`]: 900,
          [`origin/master...${M1}`]: 200,
          [`origin/master...${M2}`]: 450,
          [`${M1}...${TIP}`]: 700,
          [`${M1}...${M2}`]: 250,
          [`${M2}...${TIP}`]: 200,
        },
      }),
    });
    expect(plan.action).toBe("staged");
    expect(plan.legs).toHaveLength(3);
    expect(plan.legs.every((leg) => leg.fileCount <= 400)).toBe(true);
    expect(plan.nextLegIndex).toBe(1);
    expect(plan.message).toContain("new PR");
    expect(plan.message).toContain(FORBIDDEN_SYNC_PR_RETARGET);
  });

  it("no-ops on zero changed files", () => {
    root = makeProject();
    const plan = planSyncDefault({
      projectRoot: root,
      runGit: gitForPlan({
        counts: { "origin/master...origin/develop": 0 },
      }),
    });
    expect(plan.action).toBe("noop");
    expect(plan.noopReason).toBe("zero-files");
  });

  it("treats a source fetch failure as fetch-failed", () => {
    root = makeProject();
    const plan = planSyncDefault({
      projectRoot: root,
      runGit: gitForPlan({
        fetchSourceFail: true,
        counts: { "origin/master...origin/develop": 12 },
      }),
    });
    expect(plan.action).toBe("noop");
    expect(plan.noopReason).toBe("fetch-failed");
  });

  it("--max-files overrides the threshold for one plan", () => {
    root = makeProject({ deliveryBranch: "master", baseBranch: "develop", syncMaxFiles: 400 });
    const plan = planSyncDefault({
      projectRoot: root,
      maxFiles: 10,
      runGit: gitForPlan({
        counts: {
          "origin/master...origin/develop": 12,
          [`origin/master...${TIP}`]: 12,
          [`origin/master...${M1}`]: 6,
          [`${M1}...${TIP}`]: 6,
          [`origin/master...${M2}`]: 9,
          [`${M1}...${M2}`]: 3,
          [`${M2}...${TIP}`]: 3,
        },
      }),
    });
    expect(plan.threshold).toBe(10);
    expect(plan.provenance).toBe("flag");
    expect(plan.action).toBe("staged");
  });
});

describe("applySyncDefault (#3391)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function forgeSpy(existing: readonly SyncDefaultOpenPull[] = []): {
    forge: SyncDefaultForge;
    created: { base: string; head: string }[];
    patched: string[];
  } {
    const created: { base: string; head: string }[] = [];
    const patched: string[] = [];
    return {
      created,
      patched,
      forge: {
        listOpenPulls: () => existing,
        createPull: (_repo, input) => {
          created.push({ base: input.base, head: input.head });
          expect(input.base).toBe("master");
          expect(input.body).toContain("new branch and a new PR");
          expect(input.body).not.toContain("gh pr edit --base to reuse");
          return { number: 42, htmlUrl: "https://github.com/o/r/pull/42" };
        },
      },
    };
  }

  it("opens one new dest-targeted PR at the source tip when under the limit", () => {
    root = makeProject();
    const spy = forgeSpy();
    const result = applySyncDefault({
      projectRoot: root,
      repo: "o/r",
      runGit: gitForPlan({
        counts: {
          "origin/master...origin/develop": 12,
          [`origin/master...${TIP}`]: 12,
        },
      }),
      forge: spy.forge,
    });
    expect(result.retargeted).toBe(false);
    expect(result.opened).toHaveLength(1);
    expect(result.opened[0]?.prNumber).toBe(42);
    expect(result.opened[0]?.reusedExisting).toBe(false);
    expect(spy.created).toEqual([
      { base: "master", head: syncDefaultBranchName("master", "develop", 1, TIP) },
    ]);
    expect(spy.patched).toEqual([]);
  });

  it("opens only the next dest-based prefix as a new PR and never retargets", () => {
    root = makeProject();
    const spy = forgeSpy();
    const runGit = gitForPlan({
      counts: {
        "origin/master...origin/develop": 900,
        [`origin/master...${TIP}`]: 900,
        [`origin/master...${M1}`]: 200,
        [`origin/master...${M2}`]: 450,
        [`${M1}...${TIP}`]: 700,
        [`${M1}...${M2}`]: 250,
        [`${M2}...${TIP}`]: 200,
      },
    });
    const first = applySyncDefault({
      projectRoot: root,
      repo: "o/r",
      runGit,
      forge: spy.forge,
    });
    expect(first.plan.legs).toHaveLength(3);
    expect(first.opened).toHaveLength(1);
    expect(first.opened[0]?.leg.sha).toBe(M1);
    expect(first.retargeted).toBe(false);

    const afterMerge = applySyncDefault({
      projectRoot: root,
      repo: "o/r",
      destTipSha: M1,
      runGit,
      forge: spy.forge,
    });
    expect(afterMerge.opened).toHaveLength(1);
    expect(afterMerge.opened[0]?.leg.sha).toBe(M2);
    expect(afterMerge.opened[0]?.branch).not.toBe(first.opened[0]?.branch);
    expect(spy.created).toHaveLength(2);
    expect(spy.patched).toEqual([]);
  });

  it("does not treat a same-SHA PR on another branch as the generated sync PR", () => {
    root = makeProject();
    const otherBranch: SyncDefaultOpenPull = {
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      headRef: "develop",
      headSha: M1,
      baseRef: "master",
    };
    const spy = forgeSpy([otherBranch]);
    const result = applySyncDefault({
      projectRoot: root,
      repo: "o/r",
      runGit: gitForPlan({
        counts: {
          "origin/master...origin/develop": 900,
          [`origin/master...${TIP}`]: 900,
          [`origin/master...${M1}`]: 200,
          [`origin/master...${M2}`]: 450,
          [`${M1}...${TIP}`]: 700,
          [`${M1}...${M2}`]: 250,
          [`${M2}...${TIP}`]: 200,
        },
      }),
      forge: spy.forge,
    });
    expect(result.opened[0]?.prNumber).toBe(42);
    expect(result.opened[0]?.leg.sha).toBe(M1);
    expect(result.opened[0]?.prNumber).not.toBe(9);
    expect(spy.created[0]?.head).not.toBe("develop");
  });

  it("reuses an already-open new-PR at the same cut without editing base", () => {
    root = makeProject();
    const branch = syncDefaultBranchName("master", "develop", 1, M1);
    const existing: SyncDefaultOpenPull = {
      number: 7,
      htmlUrl: "https://github.com/o/r/pull/7",
      headRef: branch,
      headSha: M1,
      baseRef: "master",
    };
    const spy = forgeSpy([existing]);
    const result = applySyncDefault({
      projectRoot: root,
      repo: "o/r",
      runGit: gitForPlan({
        counts: {
          "origin/master...origin/develop": 900,
          [`origin/master...${TIP}`]: 900,
          [`origin/master...${M1}`]: 200,
          [`origin/master...${M2}`]: 450,
          [`${M1}...${TIP}`]: 700,
          [`${M1}...${M2}`]: 250,
          [`${M2}...${TIP}`]: 200,
        },
      }),
      forge: spy.forge,
    });
    expect(result.opened[0]?.prNumber).toBe(7);
    expect(result.opened[0]?.reusedExisting).toBe(true);
    expect(spy.created).toEqual([]);
  });

  it("throws when git push of the new leg branch fails", () => {
    root = makeProject();
    const spy = forgeSpy();
    const base = gitForPlan({
      counts: {
        "origin/master...origin/develop": 12,
        [`origin/master...${TIP}`]: 12,
      },
    });
    const runGit: GitRunner = (cwd, args) => {
      if (args[0] === "push") return { code: 1, stdout: "", stderr: "push denied" };
      return base(cwd, args);
    };
    expect(() =>
      applySyncDefault({
        projectRoot: root,
        repo: "o/r",
        runGit,
        forge: spy.forge,
      }),
    ).toThrow(/push denied/);
  });

  it("dry-run does not push or create a PR", () => {
    root = makeProject();
    const spy = forgeSpy();
    const result = applySyncDefault({
      projectRoot: root,
      repo: "o/r",
      dryRun: true,
      runGit: gitForPlan({
        counts: {
          "origin/master...origin/develop": 12,
          [`origin/master...${TIP}`]: 12,
        },
      }),
      forge: spy.forge,
    });
    expect(result.opened).toEqual([]);
    expect(spy.created).toEqual([]);
  });
});

describe("formatSyncDefaultHuman (#3391)", () => {
  it("names opened new PRs and remaining staged legs", () => {
    const text = formatSyncDefaultHuman({
      retargeted: false,
      opened: [
        {
          leg: {
            index: 1,
            sha: M1,
            fileCount: 200,
            cutKind: "merge",
            branchName: "sync/master-from-develop/leg-1-bbbbbbb",
          },
          prNumber: 8,
          prUrl: "https://github.com/o/r/pull/8",
          branch: "sync/master-from-develop/leg-1-bbbbbbb",
          reusedExisting: false,
        },
      ],
      plan: {
        action: "staged",
        noopReason: null,
        dest: "master",
        source: "develop",
        threshold: 400,
        provenance: "default",
        totalCount: 900,
        legs: [
          {
            index: 1,
            sha: M1,
            fileCount: 200,
            cutKind: "merge",
            branchName: "sync/master-from-develop/leg-1-bbbbbbb",
          },
        ],
        nextLegIndex: 1,
        message: "scm:sync-default: staged 2 new-PR legs",
        detectorReason: "sync",
      },
    });
    expect(text).toContain("new PR #8");
    expect(text).toContain("remaining legs open as new PRs");
  });
});

describe("docs helpers (#3391)", () => {
  it("parses github remotes", () => {
    expect(parseGithubOwnerRepo("git@github.com:deftai/directive.git")).toBe("deftai/directive");
    expect(parseGithubOwnerRepo("https://github.com/deftai/directive.git")).toBe(
      "deftai/directive",
    );
    expect(parseGithubOwnerRepo("not-github")).toBeNull();
  });

  it("PR body says each leg is new when the reviewer first sees it", () => {
    const body = syncDefaultPrBody(
      {
        action: "staged",
        noopReason: null,
        dest: "master",
        source: "develop",
        threshold: 400,
        provenance: "default",
        totalCount: 900,
        legs: [
          {
            index: 1,
            sha: M1,
            fileCount: 200,
            cutKind: "merge",
            branchName: "sync/master-from-develop/leg-1-bbbbbbb",
          },
        ],
        nextLegIndex: 1,
        message: "x",
        detectorReason: "sync",
      },
      {
        index: 1,
        sha: M1,
        fileCount: 200,
        cutKind: "merge",
        branchName: "sync/master-from-develop/leg-1-bbbbbbb",
      },
    );
    expect(body).toMatch(/new when the reviewer first sees it/i);
    expect(body).toContain(FORBIDDEN_SYNC_PR_RETARGET);
    expect(body).toMatch(/core-guard/i);
  });
});
