import { describe, expect, it } from "vitest";
import {
  buildApprovedScopeRecord,
  computeFileScopeDigest,
  extractFileScope,
  normalizeFileScope,
  scopeExpansion,
} from "./digest.js";
import {
  evaluateOneScopeProvenance,
  evaluateScopeProvenance,
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
    // Escaped quote / tab must decode; backslashes must not be wiped before decode
    expect(unquoteGitPath('"weird\\tname.xbrief.json"')).toBe("weird\tname.xbrief.json");
    expect(unquoteGitPath('"path\\\\with\\\\slash"')).toBe("path/with/slash");
  });
});

describe("scope-provenance digest (#3145)", () => {
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

describe("evaluateOneScopeProvenance (#3145)", () => {
  it("fails when same-PR xBRIEF expansion self-authorizes new paths", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
      approvedAt: "2026-08-01T00:00:00Z",
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const finding = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: xbrief("story-1", ["src/app.ts", "infra/scripts/test_release.py"]),
      approved,
      xbriefModifiedInChangeSet: true,
      enforce: true,
    });
    expect(finding).not.toBeNull();
    expect(finding?.kind).toBe("self-authorizing-scope-expansion");
    expect(finding?.expandedPaths).toContain("infra/scripts/test_release.py");
    expect(finding?.remediation).toMatch(/human approval/i);
  });

  it("does not treat the original activation stamp as renewal for expansion", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    // Passing original stamp as renewedHumanApproval is the anti-pattern we reject
    // at the evaluateScopeProvenance layer; unit-level renewed stamp DOES authorize.
    const withRenewal = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: xbrief("story-1", ["src/app.ts", "src/new.ts"]),
      approved,
      xbriefModifiedInChangeSet: true,
      enforce: true,
      renewedHumanApproval: {
        kind: "renewed-approval",
        actor: "scott",
        mintedAt: "2026-08-06T00:00:00Z",
      },
    });
    expect(withRenewal).toBeNull();
  });

  it("passes when xBRIEF is not modified in the change set", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
    });
    const finding = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: xbrief("story-1", ["src/app.ts", "src/extra.ts"]),
      approved,
      xbriefModifiedInChangeSet: false,
      enforce: true,
    });
    expect(finding).toBeNull();
  });

  it("rejects agent self-stamps as renewed approval", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
    });
    const finding = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: xbrief("story-1", ["src/app.ts", "src/new.ts"]),
      approved,
      xbriefModifiedInChangeSet: true,
      enforce: true,
      renewedHumanApproval: {
        kind: "agent",
        actor: "agent:worker",
        mintedAt: "2026-08-06T00:00:00Z",
      },
    });
    expect(finding?.kind).toBe("self-authorizing-scope-expansion");
  });
});

describe("evaluateScopeProvenance (#3145)", () => {
  it("detects self-authorizing expansion via injected seams", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const active = new Map<string, string>([
      [
        "xbrief/active/story.xbrief.json",
        JSON.stringify(xbrief("story-1", ["src/app.ts", "infra/test_x.py"])),
      ],
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: ["xbrief/active/story.xbrief.json", "infra/test_x.py"],
      activeXbriefs: active,
      approvedRecords: [approved],
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("self-authorizing-scope-expansion");
    expect(result.message).toMatch(/cannot authorize/i);
  });

  it("warns without failing when digest missing (migration)", () => {
    const active = new Map<string, string>([
      ["xbrief/active/story.xbrief.json", JSON.stringify(xbrief("story-1", ["src/a.ts"]))],
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: ["xbrief/active/story.xbrief.json"],
      activeXbriefs: active,
      approvedRecords: [],
      enforce: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/WARN/i);
  });

  it("fails closed on missing digest when --enforce", () => {
    const active = new Map<string, string>([
      ["xbrief/active/story.xbrief.json", JSON.stringify(xbrief("story-1", ["src/a.ts"]))],
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: ["xbrief/active/story.xbrief.json"],
      activeXbriefs: active,
      approvedRecords: [],
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
  });

  it("passes clean when no active xbriefs change", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
    });
    const active = new Map<string, string>([
      ["xbrief/active/story.xbrief.json", JSON.stringify(xbrief("story-1", ["src/app.ts"]))],
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: ["src/app.ts"],
      activeXbriefs: active,
      approvedRecords: [approved],
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/clean/i);
  });

  it("accepts re-recorded digest matching current scope with human stamp", () => {
    const current = xbrief("story-1", ["src/app.ts", "src/new.ts"]);
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: current,
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-06T12:00:00Z",
      },
    });
    const active = new Map<string, string>([
      ["xbrief/active/story.xbrief.json", JSON.stringify(current)],
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: ["xbrief/active/story.xbrief.json", "src/new.ts"],
      activeXbriefs: active,
      approvedRecords: [approved],
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
  });

  it("detects expansion when changedFiles simulate a PR branch (not bare HEAD)", () => {
    // PR CI often has a clean working tree; callers inject changedFiles from
    // origin/master...HEAD. This documents that base-ref must not be bare HEAD.
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
    });
    const active = new Map<string, string>([
      [
        "xbrief/active/story.xbrief.json",
        JSON.stringify(xbrief("story-1", ["src/app.ts", "infra/new.py"])),
      ],
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["xbrief/active/story.xbrief.json", "infra/new.py"],
      activeXbriefs: active,
      approvedRecords: [approved],
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("self-authorizing-scope-expansion");
  });
});
