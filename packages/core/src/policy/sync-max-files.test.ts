import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import { detectBranchSync } from "./branch-sync.js";
import { inspectOnePolicy } from "./index.js";
import {
  countSyncChangedFiles,
  DEFAULT_SYNC_MAX_FILES,
  evaluateSyncMaxFilesWarn,
  FIELD_SYNC_MAX_FILES,
  FIELD_SYNC_MAX_FILES_CLI_ALIAS,
  inspectSyncMaxFiles,
  parseMaxFilesFlag,
  resolveSyncMaxFiles,
  SYNC_MAX_FILES_DOCS,
} from "./sync-max-files.js";

function makeProject(policy?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "sync-max-files-"));
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

function gitForCount(options: {
  readonly files?: readonly string[];
  readonly diffFail?: boolean;
}): GitRunner {
  return (_cwd, args) => {
    if (args[0] === "fetch") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "diff" && args.includes("--name-only")) {
      if (options.diffFail === true) {
        return { code: 1, stdout: "", stderr: "diff failed" };
      }
      return { code: 0, stdout: (options.files ?? []).join("\n"), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}

function gitForSyncAndCount(options: {
  readonly files?: readonly string[];
  readonly fetchOk?: boolean;
  readonly headOnIntegration?: boolean;
  readonly destRefPolicy?: Record<string, unknown>;
}): GitRunner {
  return (_cwd, args) => {
    if (args[0] === "fetch") {
      return { code: options.fetchOk === false ? 1 : 0, stdout: "", stderr: "" };
    }
    if (args[0] === "show" && typeof args[1] === "string" && args[1].includes(":")) {
      const policy = options.destRefPolicy ?? { baseBranch: "develop", deliveryBranch: "master" };
      return {
        code: 0,
        stdout: JSON.stringify({ plan: { title: "P", status: "running", policy } }),
        stderr: "",
      };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      return { code: options.headOnIntegration === false ? 1 : 0, stdout: "", stderr: "" };
    }
    if (args[0] === "diff" && args.includes("--name-only")) {
      return { code: 0, stdout: (options.files ?? []).join("\n"), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}

function manyFiles(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `f${i}.ts`);
}

describe("resolveSyncMaxFiles (#3390)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("unset threshold is 400", () => {
    root = makeProject({ wipCap: 5 });
    const resolved = resolveSyncMaxFiles(root);
    expect(resolved.maxFiles).toBe(DEFAULT_SYNC_MAX_FILES);
    expect(resolved.source).toBe("default");
    expect(resolved.provenance).toBe("default");
  });

  it("reads typed plan.policy.syncMaxFiles", () => {
    root = makeProject({ syncMaxFiles: 100 });
    const resolved = resolveSyncMaxFiles(root);
    expect(resolved.maxFiles).toBe(100);
    expect(resolved.source).toBe("typed");
    expect(resolved.provenance).toBe("policy");
  });

  it("invalid typed value falls back to 400", () => {
    root = makeProject({ syncMaxFiles: -1 });
    const resolved = resolveSyncMaxFiles(root);
    expect(resolved.maxFiles).toBe(DEFAULT_SYNC_MAX_FILES);
    expect(resolved.source).toBe("default-on-error");
    expect(resolved.provenance).toBe("default");
  });

  it("--max-files overrides one run without writing policy", () => {
    root = makeProject({ syncMaxFiles: 100 });
    const before = readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8");
    const resolved = resolveSyncMaxFiles(root, 50);
    expect(resolved.maxFiles).toBe(50);
    expect(resolved.source).toBe("flag");
    expect(resolved.provenance).toBe("flag");
    const after = readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8");
    expect(after).toBe(before);
    expect(after).toContain('"syncMaxFiles":100');
    expect(after).not.toContain("50");
  });

  it("invalid --max-files is ignored", () => {
    root = makeProject({ syncMaxFiles: 100 });
    expect(resolveSyncMaxFiles(root, -3).maxFiles).toBe(100);
    expect(resolveSyncMaxFiles(root, 1.5).source).toBe("typed");
    expect(parseMaxFilesFlag(undefined)).toBeNull();
    expect(parseMaxFilesFlag(0)).toBe(0);
  });

  it("docs name the SLizard 100 case without vendor constants", () => {
    expect(SYNC_MAX_FILES_DOCS).toContain("100");
    expect(SYNC_MAX_FILES_DOCS).toMatch(/SLizard is a required check/i);
    expect(SYNC_MAX_FILES_DOCS).not.toMatch(/greptile|api/i);
  });
});

describe("inspectSyncMaxFiles (#3390)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("registers policy:show field and alias", () => {
    root = makeProject({ syncMaxFiles: 100 });
    const byAlias = inspectOnePolicy(FIELD_SYNC_MAX_FILES_CLI_ALIAS, root);
    const byPath = inspectOnePolicy(FIELD_SYNC_MAX_FILES, root);
    expect(byAlias?.current).toBe(100);
    expect(byAlias?.source).toBe("typed");
    expect(byPath?.name).toBe(FIELD_SYNC_MAX_FILES);
    expect(inspectSyncMaxFiles(null).current).toBe(DEFAULT_SYNC_MAX_FILES);
  });
});

describe("countSyncChangedFiles (#3390)", () => {
  it("counts git diff --name-only origin/dest...origin/source", () => {
    let seen: readonly string[] = [];
    const runGit: GitRunner = (_cwd, args) => {
      seen = args;
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "diff") {
        expect(args).toEqual(["diff", "--name-only", "origin/master...origin/develop"]);
        return { code: 0, stdout: "a.ts\nb.ts\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    const counted = countSyncChangedFiles({
      dest: "master",
      source: "develop",
      projectRoot: "/tmp",
      runGit,
    });
    expect(counted.count).toBe(2);
    expect(seen).toContain("origin/master...origin/develop");
  });

  it("returns null when the diff fails", () => {
    const counted = countSyncChangedFiles({
      dest: "master",
      source: "develop",
      projectRoot: "/tmp",
      runGit: gitForCount({ diffFail: true }),
    });
    expect(counted.count).toBeNull();
  });
});

describe("evaluateSyncMaxFilesWarn (#3390)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("does not warn when the detector says no sync", () => {
    root = makeProject({ deliveryBranch: "master" });
    const result = evaluateSyncMaxFilesWarn({
      projectRoot: root,
      prBase: "master",
      headSha: "abc",
      runGit: gitForSyncAndCount({
        destRefPolicy: { deliveryBranch: "master" },
        files: manyFiles(500),
        headOnIntegration: true,
      }),
    });
    expect(result.warn).toBe(false);
    expect(result.reason).toBe("not-sync");
    expect(result.message).toBe("");
  });

  it("warns when count exceeds the default 400", () => {
    const sync = detectBranchSync({
      dest: "master",
      source: "develop",
      sourceTyped: true,
      prBase: "master",
      headSha: "abc",
      projectRoot: "/tmp",
      runGit: gitForSyncAndCount({ headOnIntegration: true }),
    });
    root = makeProject({});
    const result = evaluateSyncMaxFilesWarn({
      projectRoot: root,
      prBase: "master",
      headSha: "abc",
      sync,
      runGit: gitForCount({ files: manyFiles(401) }),
    });
    expect(result.warn).toBe(true);
    expect(result.reason).toBe("exceeds");
    expect(result.count).toBe(401);
    expect(result.threshold).toBe(400);
    expect(result.provenance).toBe("default");
    expect(result.message).toContain("401");
    expect(result.message).toContain("syncMaxFiles=400 (default)");
    expect(result.message).toContain("origin/master...origin/develop");
  });

  it("does not warn at the exact default threshold", () => {
    const sync = detectBranchSync({
      dest: "master",
      source: "develop",
      sourceTyped: true,
      prBase: "master",
      headSha: "abc",
      projectRoot: "/tmp",
      runGit: gitForSyncAndCount({ headOnIntegration: true }),
    });
    root = makeProject({});
    const result = evaluateSyncMaxFilesWarn({
      projectRoot: root,
      prBase: "master",
      headSha: "abc",
      sync,
      runGit: gitForCount({ files: manyFiles(400) }),
    });
    expect(result.warn).toBe(false);
    expect(result.reason).toBe("within-limit");
  });

  it("prints policy provenance for a typed threshold", () => {
    const sync = detectBranchSync({
      dest: "master",
      source: "develop",
      sourceTyped: true,
      prBase: "master",
      headSha: "abc",
      projectRoot: "/tmp",
      runGit: gitForSyncAndCount({ headOnIntegration: true }),
    });
    root = makeProject({ syncMaxFiles: 100 });
    const result = evaluateSyncMaxFilesWarn({
      projectRoot: root,
      prBase: "master",
      headSha: "abc",
      sync,
      runGit: gitForCount({ files: manyFiles(101) }),
    });
    expect(result.warn).toBe(true);
    expect(result.provenance).toBe("policy");
    expect(result.message).toContain("syncMaxFiles=100 (policy)");
  });

  it("--max-files overrides the typed threshold for one run", () => {
    const sync = detectBranchSync({
      dest: "master",
      source: "develop",
      sourceTyped: true,
      prBase: "master",
      headSha: "abc",
      projectRoot: "/tmp",
      runGit: gitForSyncAndCount({ headOnIntegration: true }),
    });
    root = makeProject({ syncMaxFiles: 400 });
    const before = readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8");
    const result = evaluateSyncMaxFilesWarn({
      projectRoot: root,
      prBase: "master",
      headSha: "abc",
      maxFiles: 10,
      sync,
      runGit: gitForCount({ files: manyFiles(11) }),
    });
    expect(result.warn).toBe(true);
    expect(result.provenance).toBe("flag");
    expect(result.threshold).toBe(10);
    expect(result.message).toContain("syncMaxFiles=10 (flag)");
    expect(readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8")).toBe(
      before,
    );
  });
});
