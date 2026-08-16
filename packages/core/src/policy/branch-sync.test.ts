import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  applyCoreGuardWithBranchSync,
  BRANCH_SYNC_EXEMPTION_PREFIX,
  BRANCH_SYNC_POLICY_BLOB,
  coreGuardBranchSyncPythonBody,
  detectBranchSync,
  detectBranchSyncFromProject,
  formatBranchSyncExemptionMessage,
  renderCoreGuardBranchSyncIfBlock,
} from "./branch-sync.js";

function makeProject(policy?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "branch-sync-"));
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "P",
        status: "running",
        policy: policy ?? {},
      },
    }),
    "utf8",
  );
  return root;
}

function gitForSync(options: {
  readonly fetchOk?: boolean;
  readonly headOnIntegration?: boolean;
  readonly originDevelop?: boolean;
  readonly destRefPolicy?: Record<string, unknown> | null;
  readonly originHead?: string | null;
  readonly originBranches?: readonly string[];
  readonly localBranches?: readonly string[];
}): GitRunner {
  return (_cwd, args) => {
    if (args[0] === "fetch") {
      return { code: options.fetchOk === false ? 1 : 0, stdout: "", stderr: "" };
    }
    if (args[0] === "show" && typeof args[1] === "string" && args[1].includes(":")) {
      if (options.destRefPolicy === null) {
        return { code: 128, stdout: "", stderr: "missing dest-ref policy" };
      }
      const policy = options.destRefPolicy ?? {};
      return {
        code: 0,
        stdout: JSON.stringify({ plan: { title: "P", status: "running", policy } }),
        stderr: "",
      };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      return { code: options.headOnIntegration === false ? 1 : 0, stdout: "", stderr: "" };
    }
    if (args[0] === "symbolic-ref") {
      if (options.originHead) {
        return { code: 0, stdout: options.originHead, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "show-ref") {
      const ref = args[args.length - 1] ?? "";
      if (options.originDevelop && ref === "refs/remotes/origin/develop") {
        return { code: 0, stdout: "", stderr: "" };
      }
      for (const branch of options.originBranches ?? []) {
        if (ref === `refs/remotes/origin/${branch}`) {
          return { code: 0, stdout: "", stderr: "" };
        }
      }
      for (const branch of options.localBranches ?? []) {
        if (ref === `refs/heads/${branch}`) {
          return { code: 0, stdout: "", stderr: "" };
        }
      }
      return { code: 1, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}

describe("detectBranchSync (#3388)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("unset source equals dest is not a sync", () => {
    root = makeProject({ deliveryBranch: "master" });
    const result = detectBranchSyncFromProject({
      projectRoot: root,
      prBase: "master",
      headSha: "abc",
      runGit: gitForSync({
        destRefPolicy: { deliveryBranch: "master" },
        originDevelop: true,
        headOnIntegration: true,
      }),
    });
    expect(result.isSync).toBe(false);
    expect(result.reason).toBe("source-equals-dest");
    expect(result.source).toBe("master");
    expect(result.dest).toBe("master");
    expect(result.sourceTyped).toBe(false);
    expect(result.developHint).toMatch(/origin\/develop exists/);
  });

  it("origin/develop is never used as source identity", () => {
    root = makeProject({ deliveryBranch: "master" });
    const result = detectBranchSyncFromProject({
      projectRoot: root,
      prBase: "master",
      headSha: "abc",
      runGit: gitForSync({
        destRefPolicy: { deliveryBranch: "master" },
        originDevelop: true,
        headOnIntegration: true,
      }),
    });
    expect(result.source).not.toBe("develop");
    expect(result.isSync).toBe(false);
  });

  it("typed source equal to dest is not a sync", () => {
    const result = detectBranchSync({
      dest: "master",
      source: "master",
      sourceTyped: true,
      prBase: "master",
      headSha: "abc",
      projectRoot: "/tmp",
      runGit: gitForSync({}),
    });
    expect(result.isSync).toBe(false);
    expect(result.reason).toBe("source-equals-dest");
  });

  it("requires PR base to be dest", () => {
    const result = detectBranchSync({
      dest: "master",
      source: "develop",
      sourceTyped: true,
      prBase: "develop",
      headSha: "abc",
      projectRoot: "/tmp",
      runGit: gitForSync({ headOnIntegration: true }),
    });
    expect(result.isSync).toBe(false);
    expect(result.reason).toBe("base-is-not-dest");
  });

  it("fetch failure is not a sync", () => {
    const result = detectBranchSync({
      dest: "master",
      source: "develop",
      sourceTyped: true,
      prBase: "master",
      headSha: "abc",
      projectRoot: "/tmp",
      runGit: gitForSync({ fetchOk: false }),
    });
    expect(result.isSync).toBe(false);
    expect(result.reason).toBe("fetch-failed");
  });

  it("head not on origin/source is not a sync", () => {
    const result = detectBranchSync({
      dest: "master",
      source: "develop",
      sourceTyped: true,
      prBase: "master",
      headSha: "feature-sha",
      projectRoot: "/tmp",
      runGit: gitForSync({ headOnIntegration: false }),
    });
    expect(result.isSync).toBe(false);
    expect(result.reason).toBe("head-not-on-integration");
  });

  it("head on origin/source after fetch is a sync", () => {
    const result = detectBranchSync({
      dest: "master",
      source: "develop",
      sourceTyped: true,
      prBase: "master",
      headSha: "already-on-develop",
      projectRoot: "/tmp",
      runGit: gitForSync({ headOnIntegration: true }),
    });
    expect(result.isSync).toBe(true);
    expect(result.reason).toBe("sync");
    expect(result.message).toBe(formatBranchSyncExemptionMessage("develop"));
  });

  it("does not implement a name-only head==develop exemption", () => {
    const result = detectBranchSync({
      dest: "master",
      source: "develop",
      sourceTyped: true,
      prBase: "master",
      headSha: "unrelated-feature",
      projectRoot: "/tmp",
      runGit: gitForSync({ headOnIntegration: false }),
    });
    expect(result.isSync).toBe(false);
  });

  it("project loader uses dest-ref typed baseBranch", () => {
    root = makeProject({ baseBranch: "attacker", deliveryBranch: "master" });
    const result = detectBranchSyncFromProject({
      projectRoot: root,
      prBase: "master",
      headSha: "abc",
      runGit: gitForSync({
        destRefPolicy: { baseBranch: "develop", deliveryBranch: "master" },
        headOnIntegration: true,
      }),
    });
    expect(result.isSync).toBe(true);
    expect(result.sourceTyped).toBe(true);
    expect(result.source).toBe("develop");
  });

  it("ignores working-tree baseBranch when dest-ref has none", () => {
    root = makeProject({ baseBranch: "attacker", deliveryBranch: "master" });
    const result = detectBranchSyncFromProject({
      projectRoot: root,
      prBase: "master",
      headSha: "abc",
      runGit: gitForSync({
        destRefPolicy: { deliveryBranch: "master" },
        headOnIntegration: true,
      }),
    });
    expect(result.isSync).toBe(false);
    expect(result.reason).toBe("source-equals-dest");
    expect(result.source).toBe("master");
    expect(result.sourceTyped).toBe(false);
  });

  it("git dest fallback prefers origin/main over master", () => {
    root = makeProject({ deliveryBranch: "master" });
    const result = detectBranchSyncFromProject({
      projectRoot: root,
      prBase: "main",
      headSha: "abc",
      runGit: gitForSync({
        destRefPolicy: null,
        originBranches: ["main"],
        headOnIntegration: true,
      }),
    });
    expect(result.dest).toBe("main");
    expect(result.source).toBe("main");
    expect(result.isSync).toBe(false);
    expect(result.reason).toBe("source-equals-dest");
  });
});

describe("applyCoreGuardWithBranchSync (#3388)", () => {
  const sync = detectBranchSync({
    dest: "master",
    source: "develop",
    sourceTyped: true,
    prBase: "master",
    headSha: "abc",
    projectRoot: "/tmp",
    runGit: gitForSync({ headOnIntegration: true }),
  });
  const notSync = detectBranchSync({
    dest: "master",
    source: "develop",
    sourceTyped: true,
    prBase: "master",
    headSha: "feature",
    projectRoot: "/tmp",
    runGit: gitForSync({ headOnIntegration: false }),
  });

  it("passes loudly on a matching sync PR", () => {
    const applied = applyCoreGuardWithBranchSync({ wouldFail: true }, sync);
    expect(applied.wouldFail).toBe(false);
    expect(applied.loudMessage).toBe(formatBranchSyncExemptionMessage("develop"));
    expect(applied.loudMessage).toContain(BRANCH_SYNC_EXEMPTION_PREFIX);
  });

  it("still fails a mixed feature PR", () => {
    const applied = applyCoreGuardWithBranchSync({ wouldFail: true }, notSync);
    expect(applied.wouldFail).toBe(true);
    expect(applied.loudMessage).toBeNull();
  });

  it("does not invent a pass when there is no mix", () => {
    const applied = applyCoreGuardWithBranchSync({ wouldFail: false }, sync);
    expect(applied.wouldFail).toBe(false);
    expect(applied.loudMessage).toBeNull();
  });
});

describe("deposited core-guard detector fragment (#3388)", () => {
  it("embeds fetch + ancestor evidence and the loud message", () => {
    const body = coreGuardBranchSyncPythonBody().join("\n");
    expect(body).toContain("baseBranch");
    expect(body).toContain("deliveryBranch");
    expect(body).toContain("fetch");
    expect(body).toContain("merge-base");
    expect(body).toContain("--is-ancestor");
    expect(body).toContain(BRANCH_SYNC_EXEMPTION_PREFIX);
    expect(body).toContain(`origin/' + pr_base + ':${BRANCH_SYNC_POLICY_BLOB}'`);
    expect(body).toContain("('main', 'master')");
    expect(body).not.toContain("pathlib");
    expect(body).not.toMatch(/head\s*==\s*['"]develop['"]/);
    expect(body).not.toContain("origin/develop");
  });

  it("renders an if-block that exits 0 only on detector success", () => {
    const block = renderCoreGuardBranchSyncIfBlock("          ");
    expect(block).toContain('if python3 - "$HEAD_SHA" "$BASE_REF"');
    expect(block).toContain("then");
    expect(block).toContain("exit 0");
    expect(block).toContain("fi");
  });

  it("empty dest or source is not a sync", () => {
    const emptyDest = detectBranchSync({
      dest: "   ",
      source: "develop",
      sourceTyped: true,
      prBase: "master",
      headSha: "abc",
      projectRoot: "/tmp",
      runGit: gitForSync({}),
    });
    expect(emptyDest.isSync).toBe(false);
    expect(emptyDest.reason).toBe("source-equals-dest");
  });
});
