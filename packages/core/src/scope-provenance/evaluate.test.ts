import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildApprovedScopeRecord,
  computeFileScopeDigest,
  extractFileScope,
  isHumanApprovalStamp,
  normalizeFileScope,
  scopeExpansion,
} from "./digest.js";
import {
  evaluateOneScopeProvenance,
  evaluateScopeProvenance,
  parseApprovedScopeRecordRaw,
  unquoteGitPath,
} from "./evaluate.js";

function xbrief(planId: string, fileScope: string[]): Record<string, unknown> {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: planId,
      status: "running",
      metadata: { swarm: { file_scope: fileScope } },
    },
  };
}

describe("unquoteGitPath (#3145)", () => {
  it("decodes C-quoted paths before slash normalization", () => {
    expect(unquoteGitPath("xbrief/active/story.xbrief.json")).toBe(
      "xbrief/active/story.xbrief.json",
    );
    expect(unquoteGitPath('"xbrief/active/my file.xbrief.json"')).toBe(
      "xbrief/active/my file.xbrief.json",
    );
    expect(unquoteGitPath('"weird\\tname.xbrief.json"')).toBe("weird\tname.xbrief.json");
    expect(unquoteGitPath('"path\\\\with\\\\slash"')).toBe("path/with/slash");
    expect(unquoteGitPath('"xbrief/active/caf\\303\\251.xbrief.json"')).toBe(
      "xbrief/active/café.xbrief.json",
    );
  });
});

describe("scope-provenance digest helpers", () => {
  it("normalizes and digests file_scope stably", () => {
    const a = computeFileScopeDigest(["src/b.ts", "src/a.ts", "src/a.ts"]);
    const b = computeFileScopeDigest(["src/a.ts", "src/b.ts"]);
    expect(a).toBe(b);
    expect(normalizeFileScope(["./src/a.ts", "src\\b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("computes expansion as current minus approved", () => {
    expect(scopeExpansion(["src/a.ts"], ["src/a.ts", "infra/test_x.py"])).toEqual([
      "infra/test_x.py",
    ]);
    expect(scopeExpansion(["src/a.ts"], ["src/a.ts"])).toEqual([]);
  });

  it("extracts file_scope from payload", () => {
    expect(extractFileScope(xbrief("p", ["a.ts", "b.ts"]))).toEqual(["a.ts", "b.ts"]);
  });
});

describe("evaluateOneScopeProvenance (#4956 retires mint-on-proceed)", () => {
  it("never demands scope:record-approved-scope for a modified brief without digest", () => {
    const finding = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: xbrief("story-1", ["packages/core/src/a.ts"]),
      approved: null,
      xbriefModifiedInChangeSet: true,
      enforce: true,
    });
    expect(finding).toBeNull();
  });

  it("does not return remediationForRenewedApproval on declared-list growth", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const finding = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: xbrief("story-1", ["packages/core/src/a.ts", "packages/core/src/b.ts"]),
      approved,
      xbriefModifiedInChangeSet: true,
      enforce: true,
    });
    expect(finding).toBeNull();
  });
});

describe("evaluateScopeProvenance membership (#4774)", () => {
  it("fails closed when first-story has no merge-base mint (Bound)", () => {
    const active = new Map<string, string>([
      [
        "xbrief/active/story.xbrief.json",
        JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
      ],
    ]);
    const result = evaluateScopeProvenance("/tmp/proj-c24", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        ".gitignore",
        "COST-ESTIMATE.md",
        "packages/core/src/a.ts",
      ],
      activeXbriefs: active,
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map(),
      enforce: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("active-xbrief-modified-without-digest");
    expect(result.findings[0]?.detail).toMatch(/#4774/);
    expect(result.findings[0]?.expandedPaths).toEqual(
      expect.arrayContaining([".gitignore", "COST-ESTIMATE.md", "packages/core/src/a.ts"]),
    );
  });

  it("does not treat omitting file_scope as undeclared-by-design when mint is missing", () => {
    const undeclared = {
      xBRIEFInfo: { version: "0.8" },
      plan: { id: "story-uat", status: "running", metadata: { intended_placement: { files: [] } } },
    };
    const result = evaluateScopeProvenance("/tmp/proj-uat5", {
      changedFiles: [
        "xbrief/active/2026-09-18-4-show-request-time-in-milliseconds.xbrief.json",
        ".gitignore",
        "COST-ESTIMATE.md",
        "Taskfile.yml",
        "package.json",
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/2026-09-18-4-show-request-time-in-milliseconds.xbrief.json",
          JSON.stringify(undeclared),
        ],
      ]),
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("active-xbrief-modified-without-digest");
    expect(result.findings[0]?.remediation).toMatch(/not undeclared-by-design attestation/i);
  });

  it("compares change-set paths to merge-base approved-scope, not live HEAD file_scope", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    // Live HEAD claims extras are in scope — membership must still refuse non-allowance paths.
    const head = xbrief("story-1", [
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
      ".gitignore",
    ]);
    const result = evaluateScopeProvenance("/tmp/proj-membership", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        ".gitignore",
      ],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(head)]]),
      approvedRecords: [approved],
      baseApprovedRecords: new Map([["story-1", approved]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "change-set-outside-approved-scope")).toBe(true);
    const hit = result.findings.find((f) => f.kind === "change-set-outside-approved-scope");
    // b.ts may spend production allowance; .gitignore never matches without allowlist entry.
    expect(hit?.expandedPaths).toContain(".gitignore");
    expect(hit?.expandedPaths).not.toContain("xbrief/active/story.xbrief.json");
  });

  it("exempts the bound active xBRIEF path after a merge-base mint exists", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-exempt", {
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts", "CHANGELOG.md"],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [approved],
      baseApprovedRecords: new Map([["story-1", approved]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
    });
    expect(result.exitCode).toBe(0);
  });

  it("fails closed when PR brief file_scope would self-authorize without mint", () => {
    const result = evaluateScopeProvenance("/tmp/proj-first-story", {
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts", "CHANGELOG.md"],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map(),
      enforce: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "active-xbrief-modified-without-digest")).toBe(
      true,
    );
  });

  it("empty merge-base mint is authoritative (no brief fallback)", () => {
    const emptyMint = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", []),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-empty-mint", {
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts"],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [emptyMint],
      baseApprovedRecords: new Map([["story-1", emptyMint]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      enforce: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("active-xbrief-modified-without-digest");
    expect(result.findings[0]?.expandedPaths).toContain("packages/core/src/a.ts");
  });

  it("falls back to concrete merge-base brief file_scope when mint is absent (#5192 Path B)", () => {
    const result = evaluateScopeProvenance("/tmp/proj-base-brief-fallback", {
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts"],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts", "packages/core/src/b.ts"])),
        ],
      ]),
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      enforce: false,
    });
    expect(result.exitCode).toBe(0);
  });

  it("Path B plus undeclared tests refuses with split/widen-brief remediation, not mint (#5192)", () => {
    const result = evaluateScopeProvenance("/tmp/proj-path-b-tests", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "tests/helpers/probe.ts",
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      enforce: false,
    });
    expect(result.exitCode).toBe(1);
    const hit = result.findings.find((f) => f.kind === "change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toContain("tests/helpers/probe.ts");
    expect(hit?.remediation).toMatch(/widened concrete brief|follow-up story/i);
    expect(hit?.remediation).not.toMatch(/renewed merge-base approval/i);
  });

  it("peer PR-authored file_scope does not expand another story's allowlist", () => {
    const approvedA = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story-a.xbrief.json",
      payload: xbrief("story-a", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-peer-pr-authored", {
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "xbrief/active/story-b.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/story-a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
        [
          "xbrief/active/story-b.xbrief.json",
          // Peer first-intro with PR-authored scope covering b.ts — must not widen A.
          JSON.stringify(xbrief("story-b", ["packages/core/src/b.ts"])),
        ],
      ]),
      approvedRecords: [approvedA],
      baseApprovedRecords: new Map([["story-a", approvedA]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story-a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
      ]),
      enforce: false,
    });
    expect(result.exitCode).toBe(1);
    // Without peer widening, three source extras exceed allowance 2.
    const hit = result.findings.find((f) => f.kind === "change-set-outside-approved-scope");
    expect(hit?.expandedPaths.length).toBeGreaterThan(0);
  });

  it("unchanged peer approved scope does not authorize this story's files", () => {
    const approvedA = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story-a.xbrief.json",
      payload: xbrief("story-a", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const approvedB = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story-b.xbrief.json",
      payload: xbrief("story-b", ["packages/core/src/b.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-unchanged-peer", {
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "packages/core/src/a.ts",
        "tests/peer-b-leak.ts",
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/story-a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
        [
          "xbrief/active/story-b.xbrief.json",
          JSON.stringify(xbrief("story-b", ["packages/core/src/b.ts"])),
        ],
      ]),
      approvedRecords: [approvedA, approvedB],
      baseApprovedRecords: new Map([
        ["story-a", approvedA],
        ["story-b", approvedB],
      ]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story-a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
        [
          "xbrief/active/story-b.xbrief.json",
          JSON.stringify(xbrief("story-b", ["packages/core/src/b.ts"])),
        ],
      ]),
    });
    expect(result.exitCode).toBe(1);
    const hit = result.findings.find((f) => f.kind === "change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toContain("tests/peer-b-leak.ts");
  });

  it("peer approval does not hide a missing own allowlist", () => {
    const approvedB = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story-b.xbrief.json",
      payload: xbrief("story-b", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const emptyA = {
      xBRIEFInfo: { version: "0.8" },
      plan: { id: "story-a", status: "running", metadata: { swarm: { file_scope: [] } } },
    };
    const result = evaluateScopeProvenance("/tmp/proj-peer-hide", {
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "xbrief/active/story-b.xbrief.json",
        "packages/core/src/a.ts",
      ],
      activeXbriefs: new Map([
        ["xbrief/active/story-a.xbrief.json", JSON.stringify(emptyA)],
        [
          "xbrief/active/story-b.xbrief.json",
          JSON.stringify(xbrief("story-b", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [approvedB],
      baseApprovedRecords: new Map([["story-b", approvedB]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story-b.xbrief.json",
          JSON.stringify(xbrief("story-b", ["packages/core/src/a.ts"])),
        ],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some(
        (f) =>
          f.kind === "active-xbrief-modified-without-digest" &&
          f.xbriefRelPath === "xbrief/active/story-a.xbrief.json",
      ),
    ).toBe(true);
  });

  it("unions peer merge-base approved scopes for multi-story membership", () => {
    const approvedA = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story-a.xbrief.json",
      payload: xbrief("story-a", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const approvedB = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story-b.xbrief.json",
      payload: xbrief("story-b", ["packages/core/src/b.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-multi-story", {
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "xbrief/active/story-b.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "CHANGELOG.md",
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/story-a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
        [
          "xbrief/active/story-b.xbrief.json",
          JSON.stringify(xbrief("story-b", ["packages/core/src/b.ts"])),
        ],
      ]),
      approvedRecords: [approvedA, approvedB],
      baseApprovedRecords: new Map([
        ["story-a", approvedA],
        ["story-b", approvedB],
      ]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story-a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
        [
          "xbrief/active/story-b.xbrief.json",
          JSON.stringify(xbrief("story-b", ["packages/core/src/b.ts"])),
        ],
      ]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings.some((f) => f.kind === "change-set-outside-approved-scope")).toBe(false);
  });

  it("uses continuity-resolved planId mint even when xbriefRelPath is stale (#5192)", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/old-name.xbrief.json",
      payload: xbrief("story-1", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-stale-path-mint", {
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts"],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [approved],
      baseApprovedRecords: new Map([["story-1", approved]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
    });
    expect(result.exitCode).toBe(0);
  });

  it("refuses same-path plan.id relabel before borrowing another mint (#5192)", () => {
    const otherMint = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/other.xbrief.json",
      payload: xbrief("story-other", ["packages/core/src/a.ts", "tests/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-relabel", {
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts", "tests/a.ts"],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-other", ["packages/core/src/a.ts", "tests/a.ts"])),
        ],
      ]),
      approvedRecords: [otherMint],
      baseApprovedRecords: new Map([["story-other", otherMint]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.detail).toMatch(/plan\.id rewrite|relabel/i);
  });

  it("no-plan.id basename-keyed mint at same path remains authoritative (#5192)", () => {
    const noId = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "running",
        metadata: { swarm: { file_scope: ["packages/core/src/a.ts"] } },
      },
    };
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: {
        ...noId,
        plan: { ...noId.plan, id: "story" },
      },
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    // Force basename key + path match for no-plan.id head.
    const basenameMint = {
      ...approved,
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      fileScope: ["packages/core/src/a.ts"],
    };
    const result = evaluateScopeProvenance("/tmp/proj-no-planid-mint", {
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts", "tests/out.ts"],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(noId)]]),
      approvedRecords: [basenameMint],
      baseApprovedRecords: new Map([["story", basenameMint]]),
      baseXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(noId)]]),
    });
    expect(result.exitCode).toBe(1);
    const hit = result.findings.find((f) => f.kind === "change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toContain("tests/out.ts");
  });

  it("no-plan.id pending→active brief-only with both paths listed passes (#5192)", () => {
    const noId = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "running",
        metadata: { swarm: { file_scope: ["packages/core/src/a.ts"] } },
      },
    };
    const result = evaluateScopeProvenance("/tmp/proj-no-planid-move", {
      changedFiles: [
        "xbrief/pending/story.xbrief.json",
        "xbrief/active/story.xbrief.json",
        "CHANGELOG.md",
      ],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(noId)]]),
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map([["xbrief/pending/story.xbrief.json", JSON.stringify(noId)]]),
    });
    expect(result.exitCode).toBe(0);
  });

  it("no-plan.id move plus tests fails; land the move brief-only first (#5192)", () => {
    const noId = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "running",
        metadata: { swarm: { file_scope: ["packages/core/src/a.ts"] } },
      },
    };
    const result = evaluateScopeProvenance("/tmp/proj-no-planid-move-impl", {
      changedFiles: [
        "xbrief/pending/story.xbrief.json",
        "xbrief/active/story.xbrief.json",
        "tests/a.ts",
        "tests/b.ts",
        "tests/c.ts",
        "tests/d.ts",
        "tests/e.ts",
        "tests/f.ts",
      ],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(noId)]]),
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map([["xbrief/pending/story.xbrief.json", JSON.stringify(noId)]]),
    });
    expect(result.exitCode).toBe(1);
  });

  it("peer completed move uses continuity baseRel so it does not exhaust another allowance (#5192)", () => {
    const approvedA = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/a.xbrief.json",
      payload: xbrief("story-a", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const approvedB = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/b.xbrief.json",
      payload: xbrief("story-b", [
        "packages/core/src/b1.ts",
        "packages/core/src/b2.ts",
        "packages/core/src/b3.ts",
        "packages/core/src/b4.ts",
        "packages/core/src/b5.ts",
      ]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    // A stays active (narrow). B completes with five in-scope product files.
    // Without peer continuity, A's fence would miss B's base claim and fail.
    const result = evaluateScopeProvenance("/tmp/proj-peer-completed-move", {
      changedFiles: [
        "xbrief/active/b.xbrief.json",
        "xbrief/completed/b.xbrief.json",
        "packages/core/src/b1.ts",
        "packages/core/src/b2.ts",
        "packages/core/src/b3.ts",
        "packages/core/src/b4.ts",
        "packages/core/src/b5.ts",
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
        [
          "xbrief/completed/b.xbrief.json",
          JSON.stringify(
            xbrief("story-b", [
              "packages/core/src/b1.ts",
              "packages/core/src/b2.ts",
              "packages/core/src/b3.ts",
              "packages/core/src/b4.ts",
              "packages/core/src/b5.ts",
            ]),
          ),
        ],
      ]),
      approvedRecords: [approvedA, approvedB],
      baseApprovedRecords: new Map([
        ["story-a", approvedA],
        ["story-b", approvedB],
      ]),
      baseXbriefs: new Map([
        [
          "xbrief/active/a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
        [
          "xbrief/active/b.xbrief.json",
          JSON.stringify(
            xbrief("story-b", [
              "packages/core/src/b1.ts",
              "packages/core/src/b2.ts",
              "packages/core/src/b3.ts",
              "packages/core/src/b4.ts",
              "packages/core/src/b5.ts",
            ]),
          ),
        ],
      ]),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    expect(result.findings.some((f) => f.kind === "production-scope-over-budget")).toBe(false);
  });

  it("uses continuity baseRel for production fence after active→completed move (#5192)", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    // Broader mint must not skip the restrictive base brief fence on the old path.
    const broadMint = {
      ...approved,
      fileScope: [
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
        "packages/core/src/f.ts",
        "packages/core/src/g.ts",
      ],
    };
    const result = evaluateScopeProvenance("/tmp/proj-move-fence", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "xbrief/completed/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
        "packages/core/src/f.ts",
        "packages/core/src/g.ts",
      ],
      activeXbriefs: new Map([
        [
          "xbrief/completed/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [broadMint],
      baseApprovedRecords: new Map([["story-1", broadMint]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "production-scope-over-budget")).toBe(true);
  });

  it("does not treat pending→active as a move when pending remains on HEAD (#5192)", () => {
    const result = evaluateScopeProvenance("/tmp/proj-pending-still-head", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "tests/a.ts",
        "tests/b.ts",
        "tests/c.ts",
        "tests/d.ts",
        "tests/e.ts",
        "tests/f.ts",
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map([
        [
          "xbrief/pending/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.detail).toMatch(/still present on head|not a continuity move/i);
  });

  it("rejects basename mint whose planId mismatches the basename key (#5192)", () => {
    const noId = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "running",
        metadata: { swarm: { file_scope: ["packages/core/src/a.ts"] } },
      },
    };
    const mismatched = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("other-plan", ["packages/core/src/a.ts", "packages/core/src/evil.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    expect(mismatched.planId).toBe("other-plan");
    const result = evaluateScopeProvenance("/tmp/proj-basename-mismatch", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/evil.ts",
      ],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(noId)]]),
      approvedRecords: [mismatched],
      // Keyed by basename "story" but planId is other-plan — must not authorize.
      baseApprovedRecords: new Map([["story", mismatched]]),
      baseXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(noId)]]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => /mismatched planId/i.test(f.detail))).toBe(true);
    // Mismatched mint must not become the allowlist (evil.ts would otherwise pass).
    expect(result.findings.some((f) => f.kind === "change-set-outside-approved-scope")).toBe(false);
  });

  it("injected active map does not re-bind a new pending brief over an active story (#5192)", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/a.xbrief.json",
      payload: xbrief("story-a", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-pending-not-rebound", {
      changedFiles: [
        "xbrief/pending/unrelated.xbrief.json",
        "packages/core/src/a.ts",
        "CHANGELOG.md",
      ],
      // Pinned presentation-coverage selection: active only (new pending omitted).
      activeXbriefs: new Map([
        [
          "xbrief/active/a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [approved],
      baseApprovedRecords: new Map([["story-a", approved]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
      ]),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings.some((f) => f.xbriefRelPath.includes("pending/"))).toBe(false);
  });

  it("no-plan.id completed move still uses same-basename base fence (#5192)", () => {
    const noIdNarrow = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "running",
        metadata: { swarm: { file_scope: ["packages/core/src/a.ts"] } },
      },
    };
    const broadMint = {
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      fileScope: [
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
        "packages/core/src/f.ts",
        "packages/core/src/g.ts",
      ],
      fileScopeDigest: "deadbeef",
      humanApproval: {
        kind: "operator" as const,
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    };
    const result = evaluateScopeProvenance("/tmp/proj-noid-completed-fence", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "xbrief/completed/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
        "packages/core/src/f.ts",
        "packages/core/src/g.ts",
      ],
      activeXbriefs: new Map([["xbrief/completed/story.xbrief.json", JSON.stringify(noIdNarrow)]]),
      approvedRecords: [broadMint],
      baseApprovedRecords: new Map([["story", broadMint]]),
      baseXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(noIdNarrow)]]),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    expect(result.findings.some((f) => f.kind === "production-scope-over-budget")).toBe(true);
  });

  it("no-plan.id completed move keeps concrete precommitment for membership (#5192)", () => {
    const noId = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "completed",
        metadata: { swarm: { file_scope: ["packages/core/src/a.ts"] } },
      },
    };
    const result = evaluateScopeProvenance("/tmp/proj-noid-completed-precommit", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "xbrief/completed/story.xbrief.json",
        "packages/core/src/a.ts",
        "CHANGELOG.md",
      ],
      activeXbriefs: new Map([["xbrief/completed/story.xbrief.json", JSON.stringify(noId)]]),
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(noId)]]),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    expect(result.exitCode).toBe(0);
    expect(
      result.findings.some(
        (f) =>
          f.kind === "active-xbrief-modified-without-digest" ||
          f.kind === "change-set-outside-approved-scope",
      ),
    ).toBe(false);
  });

  it("no-plan.id completed brief does not borrow a same-basename pending still on HEAD (#5192)", () => {
    const noIdNarrow = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "completed",
        metadata: { swarm: { file_scope: ["packages/core/src/a.ts"] } },
      },
    };
    const unrelatedPendingBroad = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "pending",
        metadata: {
          swarm: {
            file_scope: [
              "packages/core/src/a.ts",
              "packages/core/src/b.ts",
              "packages/core/src/c.ts",
              "packages/core/src/d.ts",
              "packages/core/src/e.ts",
              "packages/core/src/f.ts",
              "packages/core/src/g.ts",
            ],
          },
        },
      },
    };
    // New completed brief; pending with same basename remains on HEAD (not a move).
    const result = evaluateScopeProvenance("/tmp/proj-noid-no-borrow-pending", {
      changedFiles: [
        "xbrief/completed/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
        "packages/core/src/f.ts",
        "packages/core/src/g.ts",
      ],
      activeXbriefs: new Map([
        ["xbrief/completed/story.xbrief.json", JSON.stringify(noIdNarrow)],
        ["xbrief/pending/story.xbrief.json", JSON.stringify(unrelatedPendingBroad)],
      ]),
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map([
        ["xbrief/pending/story.xbrief.json", JSON.stringify(unrelatedPendingBroad)],
      ]),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    // Must not admit extras under the unrelated pending brief's broad scope.
    expect(
      result.findings.some(
        (f) =>
          f.kind === "production-scope-over-budget" ||
          f.kind === "active-xbrief-modified-without-digest" ||
          f.kind === "change-set-outside-approved-scope",
      ),
    ).toBe(true);
  });

  it("no-plan.id completed move prefers active over stale pending for fence (#5192)", () => {
    const noIdNarrow = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "completed",
        metadata: { swarm: { file_scope: ["packages/core/src/a.ts"] } },
      },
    };
    const stalePendingBroad = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "pending",
        metadata: {
          swarm: {
            file_scope: [
              "packages/core/src/a.ts",
              "packages/core/src/b.ts",
              "packages/core/src/c.ts",
              "packages/core/src/d.ts",
              "packages/core/src/e.ts",
              "packages/core/src/f.ts",
              "packages/core/src/g.ts",
            ],
          },
        },
      },
    };
    const result = evaluateScopeProvenance("/tmp/proj-noid-prefer-active", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "xbrief/completed/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
        "packages/core/src/f.ts",
        "packages/core/src/g.ts",
      ],
      activeXbriefs: new Map([["xbrief/completed/story.xbrief.json", JSON.stringify(noIdNarrow)]]),
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map([
        ["xbrief/pending/story.xbrief.json", JSON.stringify(stalePendingBroad)],
        ["xbrief/active/story.xbrief.json", JSON.stringify(noIdNarrow)],
      ]),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    expect(result.findings.some((f) => f.kind === "production-scope-over-budget")).toBe(true);
  });

  it("does not exempt a deleted peer active brief from membership (#4774)", () => {
    const approvedA = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story-a.xbrief.json",
      payload: xbrief("story-a", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    // Story A modified in-scope; peer B deleted (in change set, absent from active/).
    const result = evaluateScopeProvenance("/tmp/proj-deleted-peer", {
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "xbrief/active/story-b.xbrief.json",
        "packages/core/src/a.ts",
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/story-a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [approvedA],
      baseApprovedRecords: new Map([["story-a", approvedA]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story-a.xbrief.json",
          JSON.stringify(xbrief("story-a", ["packages/core/src/a.ts"])),
        ],
        [
          "xbrief/active/story-b.xbrief.json",
          JSON.stringify(xbrief("story-b", ["packages/core/src/b.ts"])),
        ],
      ]),
    });
    expect(result.exitCode).toBe(1);
    const hit = result.findings.find((f) => f.kind === "change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toContain("xbrief/active/story-b.xbrief.json");
  });

  it("plan.id story does not exempt deleting a different same-basename brief (#5192)", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-basename-other-delete", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "xbrief/pending/story.xbrief.json",
        "packages/core/src/a.ts",
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
      ]),
      approvedRecords: [approved],
      baseApprovedRecords: new Map([["story-1", approved]]),
      baseXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
        ],
        [
          "xbrief/pending/story.xbrief.json",
          JSON.stringify(xbrief("other-story", ["packages/core/src/other.ts"])),
        ],
      ]),
    });
    expect(result.exitCode).toBe(1);
    const hit = result.findings.find((f) => f.kind === "change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toContain("xbrief/pending/story.xbrief.json");
  });
});

describe("evaluateScopeProvenance base-brief fence (#4956)", () => {
  it("fails membership without mint even when PR brief file_scope covers product paths (#4774)", () => {
    const active = new Map<string, string>([
      [
        "xbrief/active/story.xbrief.json",
        JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts"])),
      ],
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts"],
      activeXbriefs: active,
      approvedRecords: [],
      baseApprovedRecords: new Map(),
      baseXbriefs: new Map(), // not on base yet
      enforce: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("active-xbrief-modified-without-digest");
  });

  it("fails when production extras exceed the merge-base allowance", () => {
    const base = xbrief("story-1", ["packages/core/src/a.ts"]);
    const head = xbrief("story-1", [
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
      "packages/core/src/c.ts",
      "packages/core/src/d.ts",
    ]);
    // Wide merge-base mint so #4774 membership does not mask the #4956 fence.
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: head,
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
      ],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(head)]]),
      baseXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(base)]]),
      approvedRecords: [approved],
      baseApprovedRecords: new Map([["story-1", approved]]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "production-scope-over-budget")).toBe(true);
    const fence = result.findings.find((f) => f.kind === "production-scope-over-budget");
    expect(fence?.remediation).toMatch(/follow-up story/i);
    expect(fence?.remediation).not.toMatch(/record-approved-scope/);
    expect(fence?.remediation).not.toMatch(/--kind renewed-approval/);
  });

  it("ignores head brief widening when counting the fence", () => {
    const base = xbrief("story-1", ["packages/core/src/a.ts"]);
    // Head claims the extras are in scope — check must still fail on changed files.
    const head = xbrief("story-1", [
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
      "packages/core/src/c.ts",
      "packages/core/src/d.ts",
      "packages/core/src/e.ts",
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: [
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
      ],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(head)]]),
      baseXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(base)]]),
      approvedRecords: [],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("production-scope-over-budget");
  });

  it("lets test-root and CHANGELOG changes pass under a base fence", () => {
    const base = xbrief("story-1", ["packages/core/src/a.ts"]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: [
        "packages/core/src/a.ts",
        "packages/core/src/a.test.ts",
        "tests/fixtures/sample.json",
        "CHANGELOG.md",
      ],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(base)]]),
      baseXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(base)]]),
      approvedRecords: [],
    });
    expect(result.exitCode).toBe(0);
  });

  it("hard-fails same-PR rewrite of an approved-scope record without remint copy", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["packages/core/src/a.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const expanded = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["packages/core/src/a.ts", "packages/core/src/b.ts"]),
      humanApproval: {
        kind: "renewed-approval",
        actor: "scott",
        mintedAt: "2026-08-06T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-rewrite", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        `.deft/approved-scope/${approved.planId}.json`,
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["packages/core/src/a.ts", "packages/core/src/b.ts"])),
        ],
      ]),
      approvedRecords: [expanded],
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("self-authorizing-scope-expansion");
    expect(result.findings[0]?.detail).toMatch(/rewritten|same change/i);
    expect(result.findings[0]?.remediation).not.toMatch(/--kind renewed-approval/);
    expect(result.findings[0]?.remediation).toMatch(/#4956/);
  });

  it("does not charge story A with story B production extras when both are active", () => {
    const baseA = xbrief("story-a", ["packages/core/src/a.ts"]);
    // B claims the whole cli src tree so x/y/z attribute to B, not A.
    const baseB = xbrief("story-b", ["packages/cli/src/**"]);
    const result = evaluateScopeProvenance("/tmp/proj-multi", {
      changedFiles: [
        "packages/core/src/a.ts",
        "packages/cli/src/x.ts",
        "packages/cli/src/y.ts",
        "packages/cli/src/z.ts",
      ],
      activeXbriefs: new Map([
        ["xbrief/active/a.xbrief.json", JSON.stringify(baseA)],
        ["xbrief/active/b.xbrief.json", JSON.stringify(baseB)],
      ]),
      baseXbriefs: new Map([
        ["xbrief/active/a.xbrief.json", JSON.stringify(baseA)],
        ["xbrief/active/b.xbrief.json", JSON.stringify(baseB)],
      ]),
      approvedRecords: [],
    });
    // Without per-story attribution, A's allowance (2) would be blown by B's three extras.
    expect(result.exitCode).toBe(0);
  });

  it("honors configured source/test roots for the production fence", () => {
    const base = xbrief("story-1", ["app/a.ts"]);
    const result = evaluateScopeProvenance("/tmp/proj-roots", {
      changedFiles: ["app/b.ts", "app/c.ts", "app/d.ts"],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(base)]]),
      baseXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(base)]]),
      approvedRecords: [],
      sourceRoots: ["app/**"],
      testRoots: ["spec/**"],
      fixtureRoots: ["spec/fixtures/**"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("production-scope-over-budget");
  });

  it("does not let a head-only peer claim siphon another story's extras", () => {
    const baseA = xbrief("story-a", ["packages/core/src/a.ts"]);
    const headA = xbrief("story-a", ["packages/core/src/a.ts"]);
    // Peer B exists only on HEAD and claims A's extras — must not remove them.
    const headB = xbrief("story-b", [
      "packages/core/src/extra1.ts",
      "packages/core/src/extra2.ts",
      "packages/core/src/extra3.ts",
    ]);
    const result = evaluateScopeProvenance("/tmp/proj-peer-head-only", {
      changedFiles: [
        "packages/core/src/extra1.ts",
        "packages/core/src/extra2.ts",
        "packages/core/src/extra3.ts",
      ],
      activeXbriefs: new Map([
        ["xbrief/active/a.xbrief.json", JSON.stringify(headA)],
        ["xbrief/active/b.xbrief.json", JSON.stringify(headB)],
      ]),
      baseXbriefs: new Map([["xbrief/active/a.xbrief.json", JSON.stringify(baseA)]]),
      approvedRecords: [],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "production-scope-over-budget")).toBe(true);
  });

  it("fails closed when merge-base brief read throws (not treated as missing)", () => {
    const head = xbrief("story-1", ["packages/core/src/a.ts"]);
    const result = evaluateScopeProvenance("/tmp/proj-readfail", {
      changedFiles: ["packages/core/src/b.ts"],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(head)]]),
      approvedRecords: [],
      readAtBase: () => {
        throw new Error("git show interrupted");
      },
      baseRef: "origin/master",
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.detail).toMatch(/merge-base brief read failed/i);
  });

  it("fails closed when a base-visible peer brief cannot be parsed (no silent misattribution)", () => {
    const baseA = xbrief("story-a", ["packages/core/src/a.ts"]);
    const headA = xbrief("story-a", ["packages/core/src/a.ts"]);
    const headB = xbrief("story-b", [
      "packages/core/src/extra1.ts",
      "packages/core/src/extra2.ts",
      "packages/core/src/extra3.ts",
    ]);
    const result = evaluateScopeProvenance("/tmp/proj-peer-readfail", {
      changedFiles: [
        "packages/core/src/extra1.ts",
        "packages/core/src/extra2.ts",
        "packages/core/src/extra3.ts",
      ],
      activeXbriefs: new Map([
        ["xbrief/active/a.xbrief.json", JSON.stringify(headA)],
        ["xbrief/active/b.xbrief.json", JSON.stringify(headB)],
      ]),
      baseXbriefs: new Map([
        ["xbrief/active/a.xbrief.json", JSON.stringify(baseA)],
        // Malformed JSON on base: must surface, not charge extras onto A.
        ["xbrief/active/b.xbrief.json", "{not-json"],
      ]),
      approvedRecords: [],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => /peer .*unreadable JSON/i.test(f.detail))).toBe(true);
    // Do not invent a production-extras list from the silent-discard path.
    expect(
      result.findings.some(
        (f) =>
          f.kind === "production-scope-over-budget" &&
          f.expandedPaths.includes("packages/core/src/extra1.ts"),
      ),
    ).toBe(false);
  });

  it("fails closed when readAtBase throws for a base-visible peer", () => {
    const baseA = xbrief("story-a", ["packages/core/src/a.ts"]);
    const headA = xbrief("story-a", ["packages/core/src/a.ts"]);
    const headB = xbrief("story-b", ["packages/core/src/b.ts"]);
    const result = evaluateScopeProvenance("/tmp/proj-peer-throw", {
      changedFiles: ["packages/core/src/orphan1.ts", "packages/core/src/orphan2.ts"],
      activeXbriefs: new Map([
        ["xbrief/active/a.xbrief.json", JSON.stringify(headA)],
        ["xbrief/active/b.xbrief.json", JSON.stringify(headB)],
      ]),
      approvedRecords: [],
      baseRef: "origin/master",
      readAtBase: (rel) => {
        if (rel.includes("a.xbrief")) return JSON.stringify(baseA);
        if (rel.includes("b.xbrief")) throw new Error("git show peer interrupted");
        return null;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => /peer .*read failed/i.test(f.detail))).toBe(true);
  });

  it("passes clean when no active xbriefs change and no base fence extras", () => {
    const current = xbrief("story-1", ["packages/core/src/a.ts"]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: ["README.md"],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(current)]]),
      baseXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(current)]]),
      approvedRecords: [],
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/clean/i);
  });
});

describe("parseApprovedScopeRecordRaw", () => {
  it("rejects digest/path mismatch", () => {
    const rec = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["a.ts"]),
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-01T00:00:00Z" },
    });
    const forged = { ...rec, fileScopeDigest: "deadbeef" };
    expect(parseApprovedScopeRecordRaw(JSON.stringify(forged))).toBeNull();
  });
});

describe("scope-provenance does not read authz grants", () => {
  it("keeps evaluate modules free of authz grant imports", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of [
      "evaluate.ts",
      "digest.ts",
      "index.ts",
      "intent-evaluate.ts",
      "extract-intent.ts",
      "compare-intent.ts",
      "mint-artifacts.ts",
      "base-fence.ts",
    ]) {
      const src = readFileSync(join(dir, name), "utf8");
      expect(src).not.toMatch(/authz\/grants/);
      expect(src).not.toMatch(/loadAuthzState/);
      expect(src).not.toMatch(/listActiveHumanGrants/);
      expect(src).not.toMatch(/from ["'][^"']*authz/);
    }
  });
});

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("docs and managed text after proceed (#4956)", () => {
  it("scope-provenance.md says after proceed there is no scope ceremony", () => {
    const docs = readRepo("content/docs/scope-provenance.md");
    expect(docs).toMatch(/#4956/);
    expect(docs).toMatch(/no scope ceremony/i);
    expect(docs).toMatch(/merge base/i);
    expect(docs).not.toMatch(/## Expansion remint after first mint \(#4589\)/);
  });

  it("agents-entry pins the no-ceremony proceed fence", () => {
    const entry = readRepo("content/templates/agents-entry.md");
    expect(entry).toMatch(/#4956/);
    expect(entry).toMatch(/no scope ceremony/i);
    expect(entry).not.toMatch(/--kind renewed-approval/);
  });

  it("authz grant phrase mint remains on human-presence mint", () => {
    const mint = readRepo("packages/cli/src/human-presence-mint.ts");
    expect(mint).toMatch(/AUTHZ_INTERACTIVE_CONFIRM_PHRASE = "mint"/);
  });

  it("renewed-approval stamp kind remains a human stamp for legacy records", () => {
    expect(
      isHumanApprovalStamp({
        kind: "renewed-approval",
        actor: "scott",
        mintedAt: "2026-08-06T00:00:00Z",
      }),
    ).toBe(true);
  });

  it("activate still has no approved-scope reader (#4383 open)", () => {
    const lifecycle = readRepo("packages/cli/src/scope-lifecycle.ts");
    expect(lifecycle).not.toMatch(/approved-scope/);
    expect(lifecycle).not.toMatch(/fileScopeDigest/);
    const scopeDir = join(repoRoot, "packages/core/src/scope");
    const scopeText = readdirSync(scopeDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(scopeDir, name), "utf8"))
      .join("\n");
    expect(scopeText).not.toMatch(/approved-scope/);
    expect(scopeText).not.toMatch(/fileScopeDigest/);
  });
});

describe("changed-lifecycle admission shared predicate (#5412)", () => {
  let root: string | undefined;

  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, {
      cwd,
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
    const dir = mkdtempSync(join(tmpdir(), "scope-prov-5412-"));
    git(dir, ["init", "-q"]);
    git(dir, ["checkout", "-b", "main"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "test"]);
    return dir;
  }

  function writeFile(cwd: string, rel: string, body: string): void {
    const full = join(cwd, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }

  function writeTracked(cwd: string, rel: string, body: string): void {
    writeFile(cwd, rel, body);
    git(cwd, ["add", "--", rel]);
  }

  function commit(cwd: string, msg: string): void {
    git(cwd, ["commit", "-q", "-m", msg, "--allow-empty"]);
  }

  function planningBrief(
    planId: string,
    status: "proposed" | "pending" | "running" | "completed",
    fileScope: string[],
  ): string {
    return `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          id: planId,
          status,
          metadata: { swarm: { file_scope: fileScope } },
        },
      },
      null,
      2,
    )}\n`;
  }

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("proposed→pending planning transition exits 0 under live discovery and empty Map", () => {
    root = initRepo();
    const planId = "story-a2";
    const scope = ["packages/core/src/a2.ts"];
    writeTracked(root, "xbrief/proposed/a2.xbrief.json", planningBrief(planId, "proposed", scope));
    writeTracked(
      root,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { id: "project", status: "running" } }, null, 2)}\n`,
    );
    writeTracked(
      root,
      "xbrief/specification.xbrief.json",
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { id: "spec", status: "running" } }, null, 2)}\n`,
    );
    commit(root, "base: proposed planning story");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "promote"]);
    git(root, ["rm", "-q", "--", "xbrief/proposed/a2.xbrief.json"]);
    writeTracked(root, "xbrief/pending/a2.xbrief.json", planningBrief(planId, "pending", scope));
    writeTracked(
      root,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: { id: "project", status: "running", title: "pending-promote" },
        },
        null,
        2,
      )}\n`,
    );
    writeTracked(
      root,
      "xbrief/specification.xbrief.json",
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: { id: "spec", status: "running", title: "pending-promote" },
        },
        null,
        2,
      )}\n`,
    );
    commit(root, "promote proposed to pending + registry companions");

    const live = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(live.exitCode).toBe(0);
    expect(live.findings).toEqual([]);

    const injected = evaluateScopeProvenance(root, {
      baseRef: "base",
      enforce: true,
      activeXbriefs: new Map(),
    });
    expect(injected.exitCode).toBe(0);
    expect(injected.findings).toEqual([]);
  });

  it("active-on-base→pending keeps fence under live discovery and empty-map shared predicate", () => {
    root = initRepo();
    const planId = "story-1";
    const narrow = ["packages/core/src/a.ts"];
    writeTracked(root, "xbrief/active/story.xbrief.json", planningBrief(planId, "running", narrow));
    writeTracked(root, "packages/core/src/a.ts", "export const a = 1;\n");
    commit(root, "base: active story");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "demote"]);
    git(root, ["rm", "-q", "--", "xbrief/active/story.xbrief.json"]);
    writeTracked(
      root,
      "xbrief/pending/story.xbrief.json",
      planningBrief(planId, "pending", narrow),
    );
    writeTracked(root, "packages/core/src/b.ts", "export const b = 1;\n");
    writeTracked(root, "packages/core/src/c.ts", "export const c = 1;\n");
    writeTracked(root, "packages/core/src/d.ts", "export const d = 1;\n");
    commit(root, "demote active to pending with out-of-fence extras");

    const live = evaluateScopeProvenance(root, {
      baseRef: "base",
      enforce: true,
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    expect(live.exitCode).toBe(1);
    expect(
      live.findings.some(
        (f) =>
          f.kind === "production-scope-over-budget" ||
          f.kind === "active-xbrief-modified-without-digest" ||
          f.kind === "change-set-outside-approved-scope",
      ),
    ).toBe(true);

    const injected = evaluateScopeProvenance(root, {
      baseRef: "base",
      enforce: true,
      activeXbriefs: new Map(),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    expect(injected.exitCode).toBe(1);
    expect(
      injected.findings.some(
        (f) =>
          f.kind === "production-scope-over-budget" ||
          f.kind === "active-xbrief-modified-without-digest" ||
          f.kind === "change-set-outside-approved-scope",
      ),
    ).toBe(true);
  });

  it("refining already-pending planning does not bind companions as active scope", () => {
    root = initRepo();
    const planId = "story-plan";
    const scope = ["packages/core/src/future.ts"];
    writeTracked(root, "xbrief/pending/plan.xbrief.json", planningBrief(planId, "pending", scope));
    writeTracked(
      root,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { id: "project", status: "running" } }, null, 2)}\n`,
    );
    commit(root, "base: already pending");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "refine"]);
    writeTracked(
      root,
      "xbrief/pending/plan.xbrief.json",
      planningBrief(planId, "pending", [...scope, "packages/core/src/extra.ts"]),
    );
    writeTracked(
      root,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: { id: "project", status: "running", title: "refine-pending" },
        },
        null,
        2,
      )}\n`,
    );
    commit(root, "refine pending + registry");

    const live = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(live.exitCode).toBe(0);
    expect(live.findings).toEqual([]);
  });

  it("injected brand-new pending in activeXbriefs does not bypass admission", () => {
    const pendingRel = "xbrief/pending/brand-new.xbrief.json";
    const pending = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "brand-new",
        status: "pending",
        metadata: { swarm: { file_scope: ["packages/core/src/future.ts"] } },
      },
    };
    const result = evaluateScopeProvenance("/tmp/proj-5412-injected-pending", {
      changedFiles: [
        pendingRel,
        "xbrief/PROJECT-DEFINITION.xbrief.json",
        "packages/core/src/companion.ts",
      ],
      activeXbriefs: new Map([[pendingRel, `${JSON.stringify(pending, null, 2)}\n`]]),
      baseXbriefs: new Map(),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("injected changedFiles+baseRef without baseXbriefs does not live-ls-tree admit pending", () => {
    const pendingRel = "xbrief/pending/plan.xbrief.json";
    const pendingRaw = `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          id: "story-plan",
          status: "pending",
          metadata: { swarm: { file_scope: ["packages/core/src/future.ts"] } },
        },
      },
      null,
      2,
    )}\n`;
    const result = evaluateScopeProvenance("/tmp/proj-5412-no-live-census", {
      baseRef: "origin/master",
      changedFiles: [pendingRel, "xbrief/PROJECT-DEFINITION.xbrief.json"],
      activeXbriefs: new Map([[pendingRel, pendingRaw]]),
      readAtBase: () => null,
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("activeXbriefs-only without baseXbriefs still fail-closed on live census read failure", () => {
    root = initRepo();
    const planId = "story-census";
    const scope = ["packages/core/src/a.ts"];
    const activeRel = "xbrief/active/story.xbrief.json";
    writeTracked(root, activeRel, planningBrief(planId, "running", scope));
    writeTracked(root, "xbrief/pending/peer.xbrief.json", planningBrief("peer", "pending", scope));
    writeTracked(root, "packages/core/src/a.ts", "export const a = 1;\n");
    commit(root, "base with peer");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "edit"]);
    const head = planningBrief(planId, "running", [...scope, "packages/core/src/b.ts"]);
    writeTracked(root, activeRel, head);
    commit(root, "edit active scope");

    // No changedFiles / no baseXbriefs: must still live-ls-tree. Forced read
    // failure must surface as membership refuse (Greptile P1 sticky fingerprint).
    const result = evaluateScopeProvenance(root, {
      baseRef: "base",
      enforce: true,
      activeXbriefs: new Map([[activeRel, head]]),
      readAtBase: () => {
        throw new Error("forced census read failure");
      },
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some(
        (f) =>
          f.kind === "active-xbrief-modified-without-digest" &&
          /merge-base lifecycle census/i.test(f.detail),
      ),
    ).toBe(true);
  });

  it("renamed active-on-base→pending keeps fence via plan.id census", () => {
    const narrow = ["packages/core/src/a.ts"];
    const baseActive = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "story-rename",
        status: "running",
        metadata: { swarm: { file_scope: narrow } },
      },
    };
    const headPending = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "story-rename",
        status: "pending",
        metadata: { swarm: { file_scope: narrow } },
      },
    };
    const pendingRel = "xbrief/pending/renamed-story.xbrief.json";
    const result = evaluateScopeProvenance("/tmp/proj-5412-rename-fence", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        pendingRel,
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
      ],
      activeXbriefs: new Map([[pendingRel, `${JSON.stringify(headPending, null, 2)}\n`]]),
      baseXbriefs: new Map([
        ["xbrief/active/story.xbrief.json", `${JSON.stringify(baseActive, null, 2)}\n`],
      ]),
      sourceRoots: ["packages"],
      testRoots: ["tests"],
      fixtureRoots: ["fixtures"],
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some(
        (f) =>
          f.kind === "production-scope-over-budget" ||
          f.kind === "active-xbrief-modified-without-digest" ||
          f.kind === "change-set-outside-approved-scope",
      ),
    ).toBe(true);
  });
});
