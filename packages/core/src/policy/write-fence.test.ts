import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateRuntimeAuthorityDirectWrite,
  evaluateRuntimeAuthorityPath,
  resolveRuntimeAuthorityPolicy,
} from "./runtime-authority.js";
import {
  clearWriteFenceMemosForTests,
  extractStoryFileScope,
  formatStoryWriteFenceBaseNote,
  isStoryWriteFenceUnreadable,
  loadStoryWriteFenceFromBaseRaw,
  loadStoryWriteFenceFromMergeBase,
  loadStoryWriteFenceFromPath,
  normalizeStoryWriteScope,
  resolveWriteFence,
} from "./write-fence.js";

describe("resolveWriteFence (#516 / #2443 / #2948 Wave 3)", () => {
  const projectOnly = resolveRuntimeAuthorityPolicy({
    enabled: true,
    allowPaths: ["src/**", "packages/**"],
    denyPaths: ["secrets/**"],
    scopes: { edits: true, push: false, merge: false },
  });

  it("project-only: empty story scope leaves project fence unchanged", () => {
    const fence = resolveWriteFence(projectOnly, []);
    expect(fence.fenceActive).toBe(true);
    expect(fence.sources).toEqual(["project"]);
    expect(fence.policy.allowPaths).toEqual(["src/**", "packages/**"]);
    expect(fence.policy.storyAllowPaths).toEqual([]);
    expect(evaluateRuntimeAuthorityPath(fence.policy, "src/a.ts")).toBe("allow");
    expect(evaluateRuntimeAuthorityPath(fence.policy, "docs/x.md")).toBe("deny-allowlist");
  });

  it("story-only: enables fence when project policy is disabled", () => {
    const disabled = resolveRuntimeAuthorityPolicy({
      enabled: false,
      allowPaths: [],
      denyPaths: [],
    });
    const fence = resolveWriteFence(disabled, ["packages/core/**"]);
    expect(fence.fenceActive).toBe(true);
    expect(fence.sources).toEqual(["story"]);
    expect(fence.policy.enabled).toBe(true);
    expect(evaluateRuntimeAuthorityPath(fence.policy, "packages/core/src/a.ts")).toBe("allow");
    expect(evaluateRuntimeAuthorityPath(fence.policy, "src/other.ts")).toBe("deny-story-scope");
    expect(
      evaluateRuntimeAuthorityDirectWrite({
        policy: fence.policy,
        relPathPosix: "src/other.ts",
      }).reason,
    ).toMatch(/story file_scope/);
  });

  it("intersection: path must match project allow AND story file_scope", () => {
    const fence = resolveWriteFence(projectOnly, ["packages/core/**"]);
    expect(fence.sources).toEqual(["project", "story"]);
    // In both project packages/** and story packages/core/**
    expect(evaluateRuntimeAuthorityPath(fence.policy, "packages/core/src/x.ts")).toBe("allow");
    // In project allow (src/**) but outside story
    expect(evaluateRuntimeAuthorityPath(fence.policy, "src/index.ts")).toBe("deny-story-scope");
    // Outside project allow even if story were broader
    const fenceStoryBroad = resolveWriteFence(projectOnly, ["**"]);
    expect(evaluateRuntimeAuthorityPath(fenceStoryBroad.policy, "docs/x.md")).toBe(
      "deny-allowlist",
    );
  });

  it("deny-wins: project and story denys beat allow lists", () => {
    const open = resolveRuntimeAuthorityPolicy({
      enabled: true,
      allowPaths: ["**"],
      denyPaths: ["secrets/**"],
    });
    const fence = resolveWriteFence(open, ["**"], { storyDenyPaths: [".env", "private/**"] });
    expect(evaluateRuntimeAuthorityPath(fence.policy, "secrets/prod.env")).toBe("deny-denylist");
    expect(evaluateRuntimeAuthorityPath(fence.policy, ".env")).toBe("deny-denylist");
    expect(evaluateRuntimeAuthorityPath(fence.policy, "private/key.pem")).toBe("deny-denylist");
    expect(evaluateRuntimeAuthorityPath(fence.policy, "src/a.ts")).toBe("allow");
  });

  it("empty project allowPaths when enabled = all paths until story narrows", () => {
    const allPaths = resolveRuntimeAuthorityPolicy({
      enabled: true,
      allowPaths: [],
      denyPaths: [],
    });
    const noStory = resolveWriteFence(allPaths, []);
    expect(evaluateRuntimeAuthorityPath(noStory.policy, "anywhere/x.ts")).toBe("allow");

    const withStory = resolveWriteFence(allPaths, ["xbrief/**"]);
    expect(evaluateRuntimeAuthorityPath(withStory.policy, "xbrief/a.json")).toBe("allow");
    expect(evaluateRuntimeAuthorityPath(withStory.policy, "src/a.ts")).toBe("deny-story-scope");
  });

  it("inactive when project disabled and no story scope", () => {
    const disabled = resolveRuntimeAuthorityPolicy({ enabled: false });
    const fence = resolveWriteFence(disabled, []);
    expect(fence.fenceActive).toBe(false);
    expect(fence.sources).toEqual([]);
    expect(fence.policy.enabled).toBe(false);
    expect(evaluateRuntimeAuthorityPath(fence.policy, "any")).toBe("allow");
  });

  it("direct-write reasons name fence source", () => {
    const fence = resolveWriteFence(projectOnly, ["packages/core/**"]);
    const projectMiss = evaluateRuntimeAuthorityDirectWrite({
      policy: fence.policy,
      relPathPosix: "docs/x.md",
    });
    expect(projectMiss.allowed).toBe(false);
    expect(projectMiss.code).toBe("runtime-policy-deny-path");
    expect(projectMiss.reason).toMatch(/source: project\+story/);
    expect(projectMiss.reason).toMatch(/project allowPaths/);

    const storyMiss = evaluateRuntimeAuthorityDirectWrite({
      policy: fence.policy,
      relPathPosix: "src/a.ts",
    });
    expect(storyMiss.allowed).toBe(false);
    expect(storyMiss.reason).toMatch(/story file_scope/);
  });
});

describe("writeScope alias normalization (no dual engine)", () => {
  it("normalizes writeScope {allow,deny} to file_scope shape", () => {
    expect(normalizeStoryWriteScope({ allow: ["src/**"], deny: [".env"] })).toEqual({
      fileScope: ["src/**"],
      denyPaths: [".env"],
    });
    expect(normalizeStoryWriteScope(["packages/**"])).toEqual({
      fileScope: ["packages/**"],
      denyPaths: [],
    });
    expect(normalizeStoryWriteScope(null)).toEqual({ fileScope: [], denyPaths: [] });
  });

  it("extractStoryFileScope prefers file_scope SoT over writeScope allow", () => {
    const data = {
      plan: {
        metadata: {
          swarm: {
            file_scope: ["packages/core/**"],
            writeScope: { allow: ["src/**"], deny: ["secrets/**"] },
          },
        },
      },
    };
    const extracted = extractStoryFileScope(data);
    expect(extracted.fileScope).toEqual(["packages/core/**"]);
    // deny from alias still merges
    expect(extracted.denyPaths).toEqual(["secrets/**"]);
  });

  it("extractStoryFileScope falls back to writeScope when file_scope empty", () => {
    const data = {
      plan: {
        metadata: {
          writeScope: { allow: ["docs/**"], deny: [".env"] },
        },
      },
    };
    expect(extractStoryFileScope(data)).toEqual({
      fileScope: ["docs/**"],
      denyPaths: [".env"],
    });
  });

  it("alias and file_scope produce identical evaluation via resolveWriteFence only", () => {
    const project = resolveRuntimeAuthorityPolicy({
      enabled: true,
      allowPaths: ["**"],
      denyPaths: [],
    });
    const fromAlias = normalizeStoryWriteScope({ allow: ["src/**"], deny: [".env"] });
    const fenceA = resolveWriteFence(project, fromAlias.fileScope, {
      storyDenyPaths: fromAlias.denyPaths,
    });
    const fenceB = resolveWriteFence(project, ["src/**"], { storyDenyPaths: [".env"] });

    // Same policy shape — one evaluation engine
    expect(fenceA.policy.allowPaths).toEqual(fenceB.policy.allowPaths);
    expect(fenceA.policy.denyPaths).toEqual(fenceB.policy.denyPaths);
    expect(fenceA.policy.storyAllowPaths).toEqual(fenceB.policy.storyAllowPaths);

    for (const path of ["src/a.ts", ".env", "docs/x.md"] as const) {
      expect(evaluateRuntimeAuthorityPath(fenceA.policy, path)).toBe(
        evaluateRuntimeAuthorityPath(fenceB.policy, path),
      );
      expect(
        evaluateRuntimeAuthorityDirectWrite({ policy: fenceA.policy, relPathPosix: path }).allowed,
      ).toBe(
        evaluateRuntimeAuthorityDirectWrite({ policy: fenceB.policy, relPathPosix: path }).allowed,
      );
    }

    // Prove evaluation is only via evaluateRuntimeAuthority* (not a second matcher).
    expect(evaluateRuntimeAuthorityPath(fenceA.policy, "src/a.ts")).toBe("allow");
    expect(evaluateRuntimeAuthorityPath(fenceA.policy, ".env")).toBe("deny-denylist");
    expect(evaluateRuntimeAuthorityPath(fenceA.policy, "docs/x.md")).toBe("deny-story-scope");
  });
});

describe("story write fence fail-closed (#4956)", () => {
  it("treats a missing live brief path as an inactive fence", () => {
    expect(loadStoryWriteFenceFromPath(join(tmpdir(), "missing-story-4956.xbrief.json"))).toEqual({
      fileScope: [],
      denyPaths: [],
    });
  });

  it("returns unreadableDetail when the live brief path exists but is unreadable JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "fence-corrupt-4956-"));
    const path = join(dir, "story.xbrief.json");
    writeFileSync(path, "{not-json");
    const loaded = loadStoryWriteFenceFromPath(path);
    expect(isStoryWriteFenceUnreadable(loaded)).toBe(true);
    expect(loaded.unreadableDetail).toMatch(/unreadable/);
  });

  it("returns unreadableDetail when base raw is malformed JSON", () => {
    const loaded = loadStoryWriteFenceFromBaseRaw("{not-json", "base:story");
    expect(isStoryWriteFenceUnreadable(loaded)).toBe(true);
    expect(loaded.unreadableDetail).toMatch(/base:story/);
  });

  it("treats a non-git project root as an inactive fence (hook fixtures)", () => {
    clearWriteFenceMemosForTests();
    const dir = mkdtempSync(join(tmpdir(), "fence-nogit-4956-"));
    const brief = join(dir, "story.xbrief.json");
    writeFileSync(
      brief,
      JSON.stringify({
        plan: { metadata: { swarm: { file_scope: ["packages/core/**"] } } },
      }),
    );
    expect(loadStoryWriteFenceFromMergeBase(dir, brief)).toEqual({
      fileScope: [],
      denyPaths: [],
    });
  });

  it("treats an outside-root stub scope path as an inactive fence", () => {
    clearWriteFenceMemosForTests();
    const dir = mkdtempSync(join(tmpdir(), "fence-escape-4956-"));
    expect(
      loadStoryWriteFenceFromMergeBase(dir, "/project/xbrief/active/story.xbrief.json"),
    ).toEqual({ fileScope: [], denyPaths: [] });
  });

  it("treats null base raw as inactive fence", () => {
    expect(loadStoryWriteFenceFromBaseRaw(null)).toEqual({ fileScope: [], denyPaths: [] });
  });

  it("parses a readable base brief", () => {
    const dir = mkdtempSync(join(tmpdir(), "fence-4956-"));
    const path = join(dir, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: { metadata: { swarm: { file_scope: ["packages/core/src/a.ts"] } } },
      }),
    );
    expect(loadStoryWriteFenceFromPath(path).fileScope).toEqual(["packages/core/src/a.ts"]);
  });
});

describe("write-fence typed deliveryBranch base (#6011)", () => {
  const roots: string[] = [];
  const prevDeft = process.env.DEFT_BASE_REF;
  const prevGithub = process.env.GITHUB_BASE_REF;

  afterEach(() => {
    clearWriteFenceMemosForTests();
    for (const r of roots.splice(0)) {
      rmSync(r, { recursive: true, force: true });
    }
    if (prevDeft === undefined) delete process.env.DEFT_BASE_REF;
    else process.env.DEFT_BASE_REF = prevDeft;
    if (prevGithub === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = prevGithub;
  });

  function writePd(root: string, policy?: Record<string, unknown>): void {
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          status: "running",
          ...(policy === undefined ? {} : { policy }),
        },
      }),
      "utf8",
    );
  }

  function briefDoc(fileScope: string[]): string {
    return JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "story",
        status: "running",
        metadata: { swarm: { file_scope: fileScope } },
      },
    });
  }

  /** master tip without brief; develop tip with brief; feature off develop. */
  function repoDevelopOnlyBrief(): { root: string; briefRel: string } {
    const root = mkdtempSync(join(tmpdir(), "wf-6011-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    writeFileSync(join(root, "README"), "base\n", "utf8");
    writePd(root, {});
    execFileSync("git", ["add", "README", "xbrief"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "master tip"], { cwd: root });

    execFileSync("git", ["branch", "develop"], { cwd: root });
    execFileSync("git", ["checkout", "-q", "develop"], { cwd: root });
    const briefRel = "xbrief/active/story-6011.xbrief.json";
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, briefRel), briefDoc(["packages/core/src/policy/**"]), "utf8");
    execFileSync("git", ["add", briefRel], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "develop activates brief"], { cwd: root });

    // Coexistence: also publish origin/main at the master tip.
    execFileSync("git", ["branch", "main", "master"], { cwd: root });

    const bare = mkdtempSync(join(tmpdir(), "wf-6011-bare-"));
    roots.push(bare);
    execFileSync("git", ["clone", "--bare", "-q", root, bare], { cwd: tmpdir() });
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: root });
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: root });

    execFileSync("git", ["checkout", "-q", "-b", "feature/6011", "develop"], { cwd: root });
    return { root, briefRel };
  }

  it("loads fence from origin/develop when typed deliveryBranch=develop and brief is develop-only", () => {
    const { root, briefRel } = repoDevelopOnlyBrief();
    writePd(root, { deliveryBranch: "develop" });
    delete process.env.DEFT_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    clearWriteFenceMemosForTests();

    const fence = loadStoryWriteFenceFromMergeBase(root, join(root, briefRel));
    expect(isStoryWriteFenceUnreadable(fence)).toBe(false);
    expect(fence.fileScope).toEqual(["packages/core/src/policy/**"]);
    expect(fence.baseRef).toBe("origin/develop");
    expect(fence.typedDeliveryBranch).toBe("develop");
    expect(formatStoryWriteFenceBaseNote(fence)).toMatch(/origin\/develop/);
    expect(formatStoryWriteFenceBaseNote(fence)).toMatch(/typed deliveryBranch=develop/);
  });

  it("keeps origin/master before origin/main when deliveryBranch is unset", () => {
    const { root, briefRel } = repoDevelopOnlyBrief();
    writePd(root, {});
    delete process.env.DEFT_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    clearWriteFenceMemosForTests();

    const fence = loadStoryWriteFenceFromMergeBase(root, join(root, briefRel));
    expect(isStoryWriteFenceUnreadable(fence)).toBe(false);
    expect(fence.baseRef).toBe("origin/master");
    expect(fence.typedDeliveryBranch).toBeUndefined();
    // Brief exists only on develop; master merge-base is empty.
    expect(fence.fileScope).toEqual([]);
  });

  it("lets DEFT_BASE_REF win over typed deliveryBranch", () => {
    const { root, briefRel } = repoDevelopOnlyBrief();
    writePd(root, { deliveryBranch: "develop" });
    process.env.DEFT_BASE_REF = "origin/master";
    delete process.env.GITHUB_BASE_REF;
    clearWriteFenceMemosForTests();

    const fence = loadStoryWriteFenceFromMergeBase(root, join(root, briefRel));
    expect(fence.baseRef).toBe("origin/master");
    expect(fence.typedDeliveryBranch).toBeUndefined();
    expect(fence.fileScope).toEqual([]);
  });

  it("invalidates merge-base memo when typed delivery appears without clearing memos", () => {
    const { root, briefRel } = repoDevelopOnlyBrief();
    writePd(root, {});
    delete process.env.DEFT_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    clearWriteFenceMemosForTests();

    const first = loadStoryWriteFenceFromMergeBase(root, join(root, briefRel));
    expect(first.baseRef).toBe("origin/master");
    expect(first.fileScope).toEqual([]);

    // Same process, within TTL: typed delivery appears; memos must not stick on master.
    writePd(root, { deliveryBranch: "develop" });
    const second = loadStoryWriteFenceFromMergeBase(root, join(root, briefRel));
    expect(second.baseRef).toBe("origin/develop");
    expect(second.typedDeliveryBranch).toBe("develop");
    expect(second.fileScope).toEqual(["packages/core/src/policy/**"]);
  });
});

