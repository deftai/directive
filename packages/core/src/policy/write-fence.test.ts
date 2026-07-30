import { describe, expect, it } from "vitest";
import {
  evaluateRuntimeAuthorityDirectWrite,
  evaluateRuntimeAuthorityPath,
  resolveRuntimeAuthorityPolicy,
} from "./runtime-authority.js";
import {
  extractStoryFileScope,
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
