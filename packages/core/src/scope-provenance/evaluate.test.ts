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
    // Escaped quote / tab must decode; backslashes must not be wiped before decode
    expect(unquoteGitPath('"weird\\tname.xbrief.json"')).toBe("weird\tname.xbrief.json");
    expect(unquoteGitPath('"path\\\\with\\\\slash"')).toBe("path/with/slash");
    // Git UTF-8 octal for "é" (U+00E9) = \303\251
    expect(unquoteGitPath('"xbrief/active/caf\\303\\251.xbrief.json"')).toBe(
      "xbrief/active/café.xbrief.json",
    );
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
    expect(finding?.remediation).toMatch(/--confirm/);
    expect(finding?.remediation).not.toMatch(/drop active\//i);
    expect(finding?.remediation).not.toMatch(/drop it/i);
  });

  it("non-human stamp remediations include --confirm (#3596)", () => {
    const current = xbrief("story-1", ["src/app.ts"]);
    const agentStamp = {
      kind: "agent",
      actor: "agent:bot",
      mintedAt: "2026-08-01T00:00:00Z",
    };
    const matching = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: current,
      approved: buildApprovedScopeRecord({
        xbriefRelPath: "xbrief/active/story.xbrief.json",
        payload: current,
        humanApproval: agentStamp,
      }),
      xbriefModifiedInChangeSet: true,
      enforce: true,
    });
    expect(matching?.kind).toBe("active-xbrief-modified-without-digest");
    expect(matching?.remediation).toMatch(/--confirm/);

    const shrink = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: current,
      approved: buildApprovedScopeRecord({
        xbriefRelPath: "xbrief/active/story.xbrief.json",
        payload: xbrief("story-1", ["src/app.ts", "src/extra.ts"]),
        humanApproval: agentStamp,
      }),
      xbriefModifiedInChangeSet: true,
      enforce: true,
    });
    expect(shrink?.kind).toBe("active-xbrief-modified-without-digest");
    expect(shrink?.remediation).toMatch(/--confirm/);
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

  it("hard-fails modified xBRIEF with non-empty scope and no digest (plan-id reset / expansion)", () => {
    // Default path must not soft-warn past AC when file_scope is present.
    const active = new Map<string, string>([
      ["xbrief/active/story.xbrief.json", JSON.stringify(xbrief("story-1", ["src/a.ts"]))],
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: ["xbrief/active/story.xbrief.json"],
      activeXbriefs: active,
      approvedRecords: [],
      enforce: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("active-xbrief-modified-without-digest");
    expect(result.message).toMatch(/leftover land PR if needed \(#3476\)/);
    expect(result.message).not.toMatch(/drop active\//i);
    expect(result.message).not.toMatch(/drop it/i);
  });

  it("warns without failing for body-only modified xBRIEF with empty scope (migration)", () => {
    const active = new Map<string, string>([
      ["xbrief/active/story.xbrief.json", JSON.stringify(xbrief("story-1", []))],
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

  it("declared scope with matching human digest passes (#3874)", () => {
    const current = xbrief("story-1", ["src/app.ts"]);
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: current,
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const finding = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: current,
      approved,
      xbriefModifiedInChangeSet: true,
      enforce: true,
    });
    expect(finding).toBeNull();

    const active = new Map<string, string>([
      ["xbrief/active/story.xbrief.json", JSON.stringify(current)],
    ]);
    const result = evaluateScopeProvenance("/tmp/proj", {
      changedFiles: ["xbrief/active/story.xbrief.json"],
      activeXbriefs: active,
      approvedRecords: [approved],
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
  });

  it("declared scope without digest fails without instructing drop (#3874)", () => {
    const finding = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: xbrief("story-1", ["src/app.ts"]),
      approved: null,
      xbriefModifiedInChangeSet: true,
      enforce: true,
    });
    expect(finding).not.toBeNull();
    expect(finding?.kind).toBe("active-xbrief-modified-without-digest");
    expect(finding?.remediation).not.toMatch(/drop active\//i);
    expect(finding?.remediation).not.toMatch(/drop it/i);
    expect(finding?.remediation).toMatch(/do not undeclare/i);
    expect(finding?.remediation).toMatch(/minted at allocation/i);
    expect(finding?.remediation).toMatch(/untracked/i);
    expect(finding?.remediation).toMatch(/#1378/);
    expect(finding?.remediation).toMatch(/#3110/);
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

  it("rejects base approval records whose digest disagrees with fileScope (#3205)", () => {
    const forged = JSON.stringify({
      schemaVersion: 1,
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      approvedAt: "2026-08-01T00:00:00Z",
      fileScope: ["src/app.ts"],
      fileScopeDigest: "0".repeat(64),
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-01T00:00:00Z" },
    });
    expect(parseApprovedScopeRecordRaw(forged)).toBeNull();
  });
});

describe("verify:scope-provenance does not read grants (#3384)", () => {
  it("evaluate and digest sources never look up .deft/authz/grants", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of [
      "evaluate.ts",
      "digest.ts",
      "index.ts",
      "intent-evaluate.ts",
      "extract-intent.ts",
      "compare-intent.ts",
      "mint-artifacts.ts",
    ]) {
      const src = readFileSync(join(dir, name), "utf8");
      expect(src).not.toMatch(/authz\/grants/);
      expect(src).not.toMatch(/loadAuthzState/);
      expect(src).not.toMatch(/listActiveHumanGrants/);
      expect(src).not.toMatch(/from ["'][^"']*authz/);
    }
  });
});

const repoRoot4589 = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

function readRepo4589(rel: string): string {
  return readFileSync(join(repoRoot4589, rel), "utf8");
}

describe("expansion remint after first mint (#4589)", () => {
  it("names merge-time verify:scope-provenance plus --kind renewed-approval as the remint", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const finding = evaluateOneScopeProvenance({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      currentPayload: xbrief("story-1", ["src/app.ts", "src/extra.ts"]),
      approved,
      xbriefModifiedInChangeSet: true,
      enforce: true,
    });
    expect(finding?.kind).toBe("self-authorizing-scope-expansion");
    expect(finding?.remediation).toMatch(/verify:scope-provenance/);
    expect(finding?.remediation).toMatch(/scope:record-approved-scope/);
    expect(finding?.remediation).toMatch(/--kind renewed-approval/);
    expect(finding?.remediation).toMatch(/#4589/);
    expect(finding?.remediation).not.toMatch(/scope:renew-approved-scope/);
    expect(finding?.remediation).not.toMatch(/scope:remint/);
  });

  it("does not treat an unmodified xBRIEF as activate-time refuse", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
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

  it("authorizes expansion only with a human renewed-approval stamp", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const ok = evaluateOneScopeProvenance({
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
    expect(ok).toBeNull();
    expect(
      isHumanApprovalStamp({
        kind: "renewed-approval",
        actor: "scott",
        mintedAt: "2026-08-06T00:00:00Z",
      }),
    ).toBe(true);

    const agent = evaluateOneScopeProvenance({
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
    expect(agent?.kind).toBe("self-authorizing-scope-expansion");
  });

  it("hard-fails same-PR rewrite of the approval record", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts"]),
      humanApproval: {
        kind: "operator",
        actor: "scott",
        mintedAt: "2026-08-01T00:00:00Z",
      },
    });
    const expanded = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: xbrief("story-1", ["src/app.ts", "src/new.ts"]),
      humanApproval: {
        kind: "renewed-approval",
        actor: "scott",
        mintedAt: "2026-08-06T00:00:00Z",
      },
    });
    const result = evaluateScopeProvenance("/tmp/proj-4589", {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        `.deft/approved-scope/${approved.planId}.json`,
      ],
      activeXbriefs: new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify(xbrief("story-1", ["src/app.ts", "src/new.ts"])),
        ],
      ]),
      approvedRecords: [expanded],
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("self-authorizing-scope-expansion");
    expect(result.findings[0]?.detail).toMatch(/rewritten|same change/i);
    expect(result.findings[0]?.remediation).toMatch(/--kind renewed-approval/);
    expect(result.findings[0]?.remediation).toMatch(/#4589/);
  });

  it("records #4383 as an open predecessor: activate has no approved-scope reader", () => {
    const lifecycle = readRepo4589("packages/cli/src/scope-lifecycle.ts");
    expect(lifecycle).not.toMatch(/approved-scope/);
    expect(lifecycle).not.toMatch(/fileScopeDigest/);
    expect(lifecycle).not.toMatch(/record-approved-scope/);
    const scopeDir = join(repoRoot4589, "packages/core/src/scope");
    const scopeText = readdirSync(scopeDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(scopeDir, name), "utf8"))
      .join("\n");
    expect(scopeText).not.toMatch(/approved-scope/);
    expect(scopeText).not.toMatch(/fileScopeDigest/);
    expect(scopeText).not.toMatch(/record-approved-scope/);
  });

  it("docs name the existing remint, open predecessor, operator-return carrier, and declined paths", () => {
    const docs = readRepo4589("content/docs/scope-provenance.md");
    expect(docs).toMatch(/## Expansion remint after first mint \(#4589\)/);
    expect(docs).toMatch(/merge-time `verify:scope-provenance`/);
    expect(docs).toMatch(/--kind renewed-approval/);
    expect(docs).toMatch(/open predecessor \[#4383\]/);
    expect(docs).not.toMatch(/activate refuses/);
    expect(docs).toMatch(/Carrier \(already-holding\)/);
    expect(docs).toMatch(/operator returns and runs the documented multi-PR remint/);
    expect(docs).toMatch(/Unattended remint after the operator left/);
    expect(docs).toMatch(/Same-PR rewrite of `\.deft\/approved-scope\/<plan-id>\.json`/);
    expect(docs).toMatch(/Editing `verify:scope-provenance`/);
    expect(docs).not.toMatch(/scope:renew-approved-scope/);
    expect(docs).not.toMatch(/(?<!deft:)task scope:record-approved-scope/);
  });

  it("AGENTS.md and agents-entry pin the merge-time remint and open #4383 predecessor", () => {
    const agents = readRepo4589("AGENTS.md");
    const entry = readRepo4589("content/templates/agents-entry.md");
    for (const text of [agents, entry]) {
      expect(text).toMatch(/#4589/);
      expect(text).toMatch(/--kind renewed-approval/);
      expect(text).toMatch(/open #4383/);
      expect(text).toMatch(/unattended remint/);
      expect(text).toMatch(/same-PR approval rewrite/);
    }
  });

  it("human-presence mint still refuses agent and CI shells", () => {
    const mint = readRepo4589("packages/cli/src/human-presence-mint.ts");
    expect(mint).toMatch(/AUTHZ_AGENT_SHELL_ENV_MARKERS/);
    expect(mint).toMatch(/"CI"/);
    expect(mint).toMatch(/"CURSOR_AGENT"/);
    expect(mint).toMatch(/AUTHZ_INTERACTIVE_CONFIRM_PHRASE = "mint"/);
  });
});
