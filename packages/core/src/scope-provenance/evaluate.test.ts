import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

describe("evaluateScopeProvenance base-brief fence (#4956)", () => {
  it("passes when proceed adds a brief with file_scope and no approved-scope digest", () => {
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
      baseXbriefs: new Map(), // not on base yet
      enforce: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).not.toMatch(/record-approved-scope/);
  });

  it("fails when production extras exceed the merge-base allowance", () => {
    const base = xbrief("story-1", ["packages/core/src/a.ts"]);
    const head = xbrief("story-1", [
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
      "packages/core/src/c.ts",
      "packages/core/src/d.ts",
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
      ],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(head)]]),
      baseXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(base)]]),
      approvedRecords: [],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("production-scope-over-budget");
    expect(result.findings[0]?.remediation).toMatch(/follow-up story/i);
    expect(result.findings[0]?.remediation).not.toMatch(/record-approved-scope/);
    expect(result.findings[0]?.remediation).not.toMatch(/--kind renewed-approval/);
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
