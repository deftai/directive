import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApprovedScopeRecord } from "../scope-provenance/digest.js";
import { extractIntentFromRaw } from "../scope-provenance/extract-intent.js";
import { computeAuthHashV1 } from "../scope-provenance/forge-approval.js";
import { computeIntentDigest } from "../scope-provenance/intent-digest.js";
import type { GitRunner } from "../session/git.js";
import {
  DEFAULT_RUNTIME_AUTHORITY_POLICY,
  evaluateRuntimeAuthorityDirectWrite,
  evaluateRuntimeAuthorityPath,
  resolveRuntimeAuthorityPolicy,
} from "./runtime-authority.js";
import {
  clearWriteFenceMemosForTests,
  extractStoryFileScope,
  formatStoryWriteFenceBaseNote,
  hasPositiveGoverningStoryAllow,
  isStoryWriteFenceUnreadable,
  loadStoryWriteFenceFromBaseRaw,
  loadStoryWriteFenceFromMergeBase,
  loadStoryWriteFenceFromPath,
  newestInRangeCommitWithPath,
  normalizeStoryWriteScope,
  resolveWriteFence,
} from "./write-fence.js";

// Pass-through `spawnSync` with a per-test override, so a policy read can fail on demand (#6602).
const spawnOverride = vi.hoisted(() => ({
  fn: null as null | ((args: readonly string[]) => unknown),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: ((cmd: string, args: readonly string[], opts: object) => {
      const forced = spawnOverride.fn?.(args);
      return forced ?? (actual.spawnSync as (...a: unknown[]) => unknown)(cmd, args, opts);
    }) as typeof actual.spawnSync,
  };
});

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

  it("refuses bare local feature as typed base when origin/<feature> is missing (#6065 P1)", () => {
    const { root, briefRel } = repoDevelopOnlyBrief();
    // Widen working-tree brief on the feature tip; attack would read HEAD if
    // typed delivery accepted the bare local feature ref.
    writeFileSync(
      join(root, briefRel),
      briefDoc(["packages/**", "secrets/**", "xbrief/**"]),
      "utf8",
    );
    execFileSync("git", ["add", briefRel], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "widen feature brief"], { cwd: root });
    writePd(root, { deliveryBranch: "feature/6011" });
    delete process.env.DEFT_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    clearWriteFenceMemosForTests();

    const fence = loadStoryWriteFenceFromMergeBase(root, join(root, briefRel));
    expect(fence.baseRef).toBe("origin/master");
    expect(fence.typedDeliveryBranch).toBeUndefined();
    expect(fence.fileScope).toEqual([]);
  });
});

describe("one fence loader admits a one-PR mint brief (#6361)", () => {
  const roots: string[] = [];
  const prevDeft = process.env.DEFT_BASE_REF;
  const prevGithub = process.env.GITHUB_BASE_REF;
  const PLAN_ID = "s-6361";
  const BRIEF_REL = "xbrief/active/s-6361.xbrief.json";
  const RECORD_REL = `.deft/approved-scope/${PLAN_ID}.json`;
  const INTENT_REL = `.deft/approved-scope/${PLAN_ID}.intent.json`;
  const SCOPE = ["src/a.ts", RECORD_REL, INTENT_REL];
  const MINT = { onePrScopeProof: "mint" };

  afterEach(() => {
    spawnOverride.fn = null;
    clearWriteFenceMemosForTests();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    if (prevDeft === undefined) delete process.env.DEFT_BASE_REF;
    else process.env.DEFT_BASE_REF = prevDeft;
    if (prevGithub === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = prevGithub;
  });

  function pdText(policy: Record<string, unknown> | null, padBytes = 0): string {
    return JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "t",
        status: "running",
        ...(policy === null ? {} : { policy }),
        ...(padBytes > 0 ? { notes: "x".repeat(padBytes) } : {}),
      },
    });
  }

  function briefPayload(scope: readonly string[]): Record<string, unknown> {
    return {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: PLAN_ID,
        title: "S",
        status: "running",
        metadata: { swarm: { file_scope: [...scope] } },
      },
    };
  }

  function write(root: string, rel: string, text: string): void {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }

  /** Human mint record + preimage for exactly `scope` (same shape the mint verb writes). */
  function writeMint(root: string, scope: readonly string[]): void {
    const payload = briefPayload(scope);
    const extracted = extractIntentFromRaw(JSON.stringify(payload), {});
    if (!extracted.ok) throw new Error(extracted.error);
    const record = {
      ...buildApprovedScopeRecord({
        xbriefRelPath: BRIEF_REL,
        payload,
        humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-11-16T00:00:00Z" },
        intentDigest: computeIntentDigest(extracted.preimage),
        digestAlgo: "intent-extract-v1",
      }),
      authHashV1: computeAuthHashV1(payload, BRIEF_REL) ?? "",
    };
    write(root, RECORD_REL, JSON.stringify(record));
    write(root, INTENT_REL, JSON.stringify(extracted.preimage));
  }

  /**
   * origin/master carries PROJECT-DEFINITION (policy `basePolicy`) and no
   * brief; the working tree holds the one-PR brief and, unless `mint` is
   * false, a matching mint pair.
   */
  function repo(options: {
    basePolicy: Record<string, unknown> | null;
    headPolicy?: Record<string, unknown> | null;
    mint?: boolean;
    briefOnBase?: readonly string[];
    padBytes?: number;
  }): string {
    const root = mkdtempSync(join(tmpdir(), "wf-6361-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    write(
      root,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      pdText(options.basePolicy, options.padBytes),
    );
    if (options.briefOnBase !== undefined) {
      write(root, BRIEF_REL, JSON.stringify(briefPayload(options.briefOnBase)));
    }
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
    const bare = mkdtempSync(join(tmpdir(), "wf-6361-bare-"));
    roots.push(bare);
    execFileSync("git", ["clone", "--bare", "-q", root, bare], { cwd: tmpdir() });
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: root });
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: root });
    execFileSync("git", ["checkout", "-q", "-b", "feature/6361"], { cwd: root });
    if (options.headPolicy !== undefined) {
      write(root, "xbrief/PROJECT-DEFINITION.xbrief.json", pdText(options.headPolicy));
    }
    write(root, BRIEF_REL, JSON.stringify(briefPayload(SCOPE)));
    if (options.mint !== false) writeMint(root, SCOPE);
    delete process.env.DEFT_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    clearWriteFenceMemosForTests();
    return root;
  }

  const sorted = [...SCOPE].sort((a, b) => a.localeCompare(b));

  it("admits the working-tree file_scope when the merge-base level is mint and the record matches", () => {
    const root = repo({ basePolicy: MINT });
    const fence = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(fence.fileScope).toEqual(sorted);
    expect(fence.onePrMint).toEqual({ admitted: true });
    expect(fence.baseRef).toBe("origin/master");
    expect(hasPositiveGoverningStoryAllow(fence)).toBe(true);
    // Outside file_scope stays fenced by the same policy the hook evaluates.
    const policy = resolveWriteFence(DEFAULT_RUNTIME_AUTHORITY_POLICY, fence.fileScope).policy;
    expect(evaluateRuntimeAuthorityDirectWrite({ policy, relPathPosix: "src/a.ts" }).allowed).toBe(
      true,
    );
    expect(evaluateRuntimeAuthorityDirectWrite({ policy, relPathPosix: "src/b.ts" }).allowed).toBe(
      false,
    );
  });

  it("refuses with no record, naming the mint reject reason", () => {
    const root = repo({ basePolicy: MINT, mint: false });
    const fence = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(fence.fileScope).toEqual([]);
    expect(fence.onePrMint).toEqual({
      admitted: false,
      reason: "no same-PR approved-scope record",
    });
  });

  it("refuses a record minted for different scope", () => {
    const root = repo({ basePolicy: MINT, mint: false });
    writeMint(root, ["src/a.ts", "src/other.ts", RECORD_REL, INTENT_REL]);
    const fence = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(fence.fileScope).toEqual([]);
    expect(fence.onePrMint?.admitted).toBe(false);
  });

  it("keeps today's result when the merge-base level is off", () => {
    for (const basePolicy of [null, { onePrScopeProof: "off" }]) {
      const root = repo({ basePolicy, headPolicy: MINT });
      const fence = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
      expect(fence).toEqual({ fileScope: [], denyPaths: [], baseRef: "origin/master" });
    }
  });

  it("does not admit when the head changes onePrScopeProof or requireHumanMerge", () => {
    for (const headPolicy of [
      { onePrScopeProof: "off" },
      { onePrScopeProof: "mint", requireHumanMerge: false },
    ]) {
      const root = repo({ basePolicy: MINT, headPolicy });
      const fence = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
      expect(fence.fileScope).toEqual([]);
      const reason = fence.onePrMint?.admitted === false ? fence.onePrMint.reason : "";
      expect(reason).toMatch(/onePrScopeProof or requireHumanMerge/);
    }
  });

  it("re-reads the brief on every load: an edit after admission is refused with no memo clear", () => {
    const root = repo({ basePolicy: MINT });
    const first = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(first.onePrMint).toEqual({ admitted: true });
    write(root, BRIEF_REL, JSON.stringify(briefPayload([...SCOPE, "src/widened.ts"])));
    const second = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(second.fileScope).toEqual([]);
    const reason = second.onePrMint?.admitted === false ? second.onePrMint.reason : "";
    expect(reason).toMatch(/record fileScope differs/);
  });

  it("uses the merge-base file_scope and ignores the head copy when the brief is on the merge base", () => {
    const root = repo({ basePolicy: MINT, briefOnBase: ["src/base-only.ts"] });
    const fence = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(fence.fileScope).toEqual(["src/base-only.ts"]);
    expect(fence.onePrMint).toBeUndefined();
  });

  it("fails closed without throwing on an unreadable or missing working-tree brief", () => {
    const root = repo({ basePolicy: MINT });
    write(root, BRIEF_REL, "{not json");
    const bad = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(bad.fileScope).toEqual([]);
    expect(bad.onePrMint).toEqual({
      admitted: false,
      reason: "working-tree brief is not valid JSON",
    });
    write(root, BRIEF_REL, JSON.stringify({ plan: { title: "no id" } }));
    const noId = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(noId.onePrMint).toEqual({ admitted: false, reason: "head brief has no plan.id" });
    rmSync(join(root, ...BRIEF_REL.split("/")));
    const gone = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(gone.onePrMint).toEqual({ admitted: false, reason: "working-tree brief unreadable" });
  });

  it("refuses a signed merge-base level with the gate reason", () => {
    const signed = { onePrScopeProof: "signed" };
    const root = repo({ basePolicy: signed, headPolicy: signed });
    const fence = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    const reason = fence.onePrMint?.admitted === false ? fence.onePrMint.reason : "";
    expect(reason).toMatch(/#5862/);
  });

  it("runs the mint gate on the containing commit after an in-PR completion moves the brief (#6480)", () => {
    const root = repo({ basePolicy: MINT });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "activate"], { cwd: root });
    const completedRel = BRIEF_REL.replace("/active/", "/completed/");
    rmSync(join(root, ...BRIEF_REL.split("/")));
    // The completed copy is never the mint head, even when it says something else.
    write(root, completedRel, JSON.stringify(briefPayload([...SCOPE, "src/widened.ts"])));
    const uncommitted = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(uncommitted.fileScope).toEqual(sorted);
    expect(uncommitted.onePrMint).toEqual({ admitted: true });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "complete in PR"], { cwd: root });
    const committed = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(committed.fileScope).toEqual(sorted);
    expect(committed.onePrMint).toEqual({ admitted: true });
  });

  it("keeps the merge-base blob as the fence after the brief moves out of active/ (#6480)", () => {
    const root = repo({ basePolicy: MINT, briefOnBase: ["src/base-only.ts"] });
    rmSync(join(root, ...BRIEF_REL.split("/")));
    const fence = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
    expect(fence.fileScope).toEqual(["src/base-only.ts"]);
    expect(fence.onePrMint).toBeUndefined();
  });

  describe("merge-base policy read (#6602)", () => {
    const POLICY_LABEL = "merge-base:xbrief/PROJECT-DEFINITION.xbrief.json";
    const TWO_MIB = 2 * 1024 * 1024;

    /** Fail only the `git show <sha>:xbrief/PROJECT-DEFINITION...` read. */
    function failPolicyRead(result: Record<string, unknown>): void {
      spawnOverride.fn = (args) =>
        args[0] === "show" && String(args[1]).endsWith(":xbrief/PROJECT-DEFINITION.xbrief.json")
          ? { status: null, stdout: "", stderr: "", signal: null, ...result }
          : null;
    }

    function detailOf(fence: ReturnType<typeof loadStoryWriteFenceFromMergeBase>): string {
      expect(isStoryWriteFenceUnreadable(fence)).toBe(true);
      return fence.unreadableDetail ?? "";
    }

    it("admits a one-PR mint brief when the merge-base policy is larger than 1 MiB", () => {
      const root = repo({ basePolicy: MINT, padBytes: TWO_MIB });
      const fence = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
      expect(fence.fileScope).toEqual(sorted);
      expect(fence.onePrMint).toEqual({ admitted: true });
      expect(hasPositiveGoverningStoryAllow(fence)).toBe(true);
      const policy = resolveWriteFence(DEFAULT_RUNTIME_AUTHORITY_POLICY, fence.fileScope).policy;
      expect(
        evaluateRuntimeAuthorityDirectWrite({ policy, relPathPosix: "src/a.ts" }).allowed,
      ).toBe(true);
    });

    it("keeps the empty fence for a large policy with the level off or no policy blob", () => {
      const off = repo({ basePolicy: { onePrScopeProof: "off" }, padBytes: TWO_MIB });
      expect(loadStoryWriteFenceFromMergeBase(off, join(off, BRIEF_REL))).toEqual({
        fileScope: [],
        denyPaths: [],
        baseRef: "origin/master",
      });
      clearWriteFenceMemosForTests();
      const absent = repo({ basePolicy: null });
      execFileSync("git", ["rm", "-q", "-f", "xbrief/PROJECT-DEFINITION.xbrief.json"], {
        cwd: absent,
      });
      execFileSync("git", ["commit", "-q", "-m", "drop policy"], { cwd: absent });
      execFileSync("git", ["push", "-q", "origin", "HEAD:master"], { cwd: absent });
      execFileSync("git", ["fetch", "-q", "origin"], { cwd: absent });
      clearWriteFenceMemosForTests();
      const fence = loadStoryWriteFenceFromMergeBase(absent, join(absent, BRIEF_REL));
      expect(isStoryWriteFenceUnreadable(fence)).toBe(false);
      expect(fence.fileScope).toEqual([]);
    });

    it("fails closed with a fenced reason on a spawn error, a signal and a bare exit", () => {
      const root = repo({ basePolicy: MINT });
      const label = `story write fence unreadable at ${POLICY_LABEL}: `;
      failPolicyRead({ error: new Error("spawn EPERM") });
      expect(detailOf(loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL)))).toBe(
        `${label}«untrusted:spawn EPERM»`,
      );
      failPolicyRead({ signal: "SIGKILL" });
      expect(detailOf(loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL)))).toBe(
        `${label}«untrusted:git show killed by signal SIGKILL»`,
      );
      failPolicyRead({ status: 5 });
      expect(detailOf(loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL)))).toBe(
        `${label}«untrusted:git show exited 5»`,
      );
      failPolicyRead({ status: 128, stderr: "fatal: bad object\nsecond line\n" });
      expect(detailOf(loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL)))).toBe(
        `${label}«untrusted:fatal: bad object second line»`,
      );
    });

    it("gives no positive allow for the failed read, and does not memoize it", () => {
      const root = repo({ basePolicy: MINT });
      failPolicyRead({ status: 128, stderr: "fatal: boom" });
      const failed = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
      expect(failed.fileScope).toEqual([]);
      expect(hasPositiveGoverningStoryAllow(failed)).toBe(false);
      expect(isStoryWriteFenceUnreadable(failed)).toBe(true);
      spawnOverride.fn = null;
      const healed = loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL));
      expect(healed.onePrMint).toEqual({ admitted: true });
      expect(isStoryWriteFenceUnreadable(healed)).toBe(false);
    });

    it("cuts a 10 KB stderr to 300 characters and never carries stdout", () => {
      const root = repo({ basePolicy: MINT });
      failPolicyRead({ status: 128, stdout: "BLOB-PART-IN-STDOUT", stderr: "e".repeat(10_000) });
      const detail = detailOf(loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL)));
      const reason = detail.slice(detail.indexOf("«untrusted:") + "«untrusted:".length, -1);
      expect(detail.endsWith("»")).toBe(true);
      expect(reason).toBe("e".repeat(300));
      expect(detail).not.toContain("BLOB-PART-IN-STDOUT");
      failPolicyRead({ status: 128, stdout: "BLOB-PART-IN-STDOUT", stderr: "" });
      const quiet = detailOf(loadStoryWriteFenceFromMergeBase(root, join(root, BRIEF_REL)));
      expect(quiet).toContain("git show exited 128");
      expect(quiet).not.toContain("BLOB-PART-IN-STDOUT");
    });
  });
});

describe("newestInRangeCommitWithPath (#6480)", () => {
  it("returns null when git cannot answer or the inputs are empty", () => {
    const failing: GitRunner = () => ({ code: 1, stdout: "", stderr: "boom" });
    const throwing: GitRunner = () => {
      throw new Error("spawn failed");
    };
    expect(newestInRangeCommitWithPath("/nowhere", "", "xbrief/active/a.json")).toBeNull();
    expect(newestInRangeCommitWithPath("/nowhere", "abc", "./")).toBeNull();
    expect(newestInRangeCommitWithPath("/nowhere", "abc", "a.json", failing)).toBeNull();
    expect(newestInRangeCommitWithPath("/nowhere", "abc", "a.json", throwing)).toBeNull();
    const catFileThrows: GitRunner = (_cwd, args) => {
      if (args[0] === "rev-list") return { code: 0, stdout: "def\n", stderr: "" };
      throw new Error("spawn failed");
    };
    expect(newestInRangeCommitWithPath("/nowhere", "abc", "a.json", catFileThrows)).toBeNull();
  });

  it("falls back to probing HEAD-side commits newest first, then the merge base", () => {
    const probed: string[] = [];
    const runGit: GitRunner = (_cwd, args) => {
      if (args[0] === "log") return { code: 1, stdout: "", stderr: "no history" };
      if (args[0] === "rev-list") return { code: 0, stdout: "c2\nc1\n", stderr: "" };
      probed.push(String(args[2]));
      return { code: String(args[2]).startsWith("base:") ? 0 : 1, stdout: "", stderr: "" };
    };
    expect(newestInRangeCommitWithPath("/r", "base", "xbrief\\active\\a.json", runGit)).toBe(
      "base",
    );
    expect(probed).toEqual([
      "c2:xbrief/active/a.json",
      "c1:xbrief/active/a.json",
      "base:xbrief/active/a.json",
    ]);
    const none: GitRunner = (_cwd, args) =>
      args[0] === "rev-list"
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 128, stdout: "", stderr: "" };
    expect(newestInRangeCommitWithPath("/r", "base", "a.json", none)).toBeNull();
  });

  /** Fake history: `touch` is the last in-range commit touching the path. */
  function history(opts: {
    readonly touch: string;
    readonly has: readonly string[];
    readonly descends?: boolean;
  }): { runGit: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runGit: GitRunner = (_cwd, args) => {
      calls.push([...args]);
      const [cmd] = args;
      if (cmd === "log") return { code: 0, stdout: `${opts.touch}\n`, stderr: "" };
      if (cmd === "rev-parse") {
        const ref = String(args[3]);
        return {
          code: 0,
          stdout: ref === "HEAD" ? "head\n" : `${ref.replace("^", "-parent")}\n`,
          stderr: "",
        };
      }
      if (cmd === "cat-file") {
        const commit = String(args[2]).split(":")[0] ?? "";
        return { code: opts.has.includes(commit) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (cmd === "merge-base")
        return { code: opts.descends === false ? 1 : 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    return { runGit, calls };
  }

  it("answers from the path's own history in a fixed number of calls", () => {
    const untouched = history({ touch: "", has: ["head"] });
    expect(newestInRangeCommitWithPath("/r", "base", "a.json", untouched.runGit)).toBe("head");
    expect(untouched.calls.some((c) => c[0] === "rev-list")).toBe(false);
    const edited = history({ touch: "c3", has: ["c3", "head"] });
    expect(newestInRangeCommitWithPath("/r", "base", "a.json", edited.runGit)).toBe("head");
    const deleted = history({ touch: "c3", has: ["c3-parent"] });
    expect(newestInRangeCommitWithPath("/r", "base", "a.json", deleted.runGit)).toBe("c3-parent");
    expect(deleted.calls.length).toBeLessThanOrEqual(5);
  });

  it("does not trust a fast-path candidate outside the range or without the path", () => {
    const behind = history({ touch: "", has: ["head"], descends: false });
    expect(newestInRangeCommitWithPath("/r", "base", "a.json", behind.runGit)).toBeNull();
    expect(behind.calls.some((c) => c[0] === "rev-list")).toBe(true);
    const missing = history({ touch: "", has: [] });
    expect(newestInRangeCommitWithPath("/r", "base", "a.json", missing.runGit)).toBeNull();
  });
});
