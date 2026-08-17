import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_ISSUE_REF_TYPES } from "../intake/reconcile-issues.js";
import { compareExtractedIntent } from "./compare-intent.js";
import { buildApprovedScopeRecord, computeFileScopeDigest } from "./digest.js";
import { evaluateScopeProvenance } from "./evaluate.js";
import {
  extractIntentFromPayload,
  GITHUB_ISSUE_REF_TYPES as reusedRefTypes,
} from "./extract-intent.js";
import { computeIntentDigest } from "./intent-digest.js";
import { bodyDigestIsAuthority } from "./intent-evaluate.js";
import { allKnownMachineLeaves, KNOWN_MACHINE_WRITERS } from "./known-machine.js";
import { mintApprovedScopeArtifacts } from "./mint-artifacts.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "intent-3385-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function brief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: "story-1",
      title: "Ship pin",
      status: "running",
      tags: ["enhancement"],
      edges: [{ from: "a", to: "b" }],
      narratives: { Description: "pin intent", Decisions: "" },
      acceptance: { commands: ["task check"] },
      architecture: { note: "keep" },
      items: [
        {
          id: "i2",
          title: "second",
          status: "proposed",
          narrative: { Acceptance: "b" },
        },
        {
          id: "i1",
          title: "first",
          status: "proposed",
          narrative: { Acceptance: "a" },
        },
      ],
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/3385",
          type: "x-xbrief/github-issue",
          title: "Issue #3385",
          TrustLevel: "high",
        },
      ],
      metadata: {
        capacityBucket: "new-capability",
        swarm: {
          file_scope: ["packages/core/src/scope-provenance"],
          readiness: "sequential",
          notes: "free text",
        },
      },
      ...overrides,
    },
  };
}

describe("known-machine writer discipline (#3385 F1)", () => {
  it("every known-machine leaf has a same-PR writer annotation", () => {
    const leaves = allKnownMachineLeaves();
    expect(leaves.length).toBeGreaterThan(10);
    for (const leaf of leaves) {
      expect(KNOWN_MACHINE_WRITERS[leaf]?.writer.length).toBeGreaterThan(0);
    }
  });

  it("reuses GITHUB_ISSUE_REF_TYPES (F2) rather than a second constant", () => {
    expect(reusedRefTypes).toBe(GITHUB_ISSUE_REF_TYPES);
    expect(GITHUB_ISSUE_REF_TYPES.has("x-xbrief/github-issue")).toBe(true);
    expect(GITHUB_ISSUE_REF_TYPES.has("x-vbrief/github-issue")).toBe(true);
  });
});

describe("extract intent (#3385 F1 / R1)", () => {
  it("extracts allowlist, edges, unknown keys; omits tags and machine fields", () => {
    const payload = brief({ customConsumer: { foo: 1 } });
    const r = extractIntentFromPayload(payload, { approvedReposSeed: ["deftai/directive"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preimage.plan.title).toBe("Ship pin");
    expect(r.preimage.plan.edges).toEqual([{ from: "a", to: "b" }]);
    expect(r.preimage.plan.tags).toBeUndefined();
    expect(r.preimage.plan.status).toBeUndefined();
    expect(r.preimage.plan.customConsumer).toEqual({ foo: 1 });
    expect(r.preimage.unknownPaths).toContain("customConsumer");
    const items = r.preimage.plan.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(items[0]?.status).toBeUndefined();
    const refs = r.preimage.plan.references as Array<Record<string, unknown>>;
    expect(refs[0]?.TrustLevel).toBeUndefined();
    expect(refs[0]?.type).toBe("x-xbrief/github-issue");
    const meta = r.preimage.plan.metadata as Record<string, unknown>;
    const swarm = meta.swarm as Record<string, unknown>;
    expect(swarm.file_scope).toEqual(["packages/core/src/scope-provenance"]);
    expect(swarm.notes).toBe("free text");
    expect(swarm.readiness).toBeUndefined();
    expect(meta.capacityBucket).toBeUndefined();
    expect(r.preimage.approvedRepos).toEqual(["deftai/directive"]);
  });

  it("growing known-machine list does not change an existing digest", () => {
    const r = extractIntentFromPayload(brief(), { approvedReposSeed: ["deftai/directive"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = computeIntentDigest(r.preimage);
    const withExtraMachine = brief({ status: "pending", updated: "2026-08-16T00:00:00Z" });
    const r2 = extractIntentFromPayload(withExtraMachine, {
      approvedReposSeed: ["deftai/directive"],
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(computeIntentDigest(r2.preimage)).toBe(a);
  });

  it("rejects duplicate items[].id", () => {
    const r = extractIntentFromPayload(
      brief({
        items: [
          { id: "same", title: "a" },
          { id: "same", title: "b" },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate items\[\]\.id/);
  });

  it("resolves planRef to parent plan.id and fails closed when missing", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/active/parent.xbrief.json"),
      JSON.stringify({ plan: { id: "parent-plan" } }),
      "utf8",
    );
    const ok = extractIntentFromPayload(brief({ planRef: "active/parent.xbrief.json" }), {
      projectRoot: root,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.preimage.plan.parentId).toBe("parent-plan");

    const miss = extractIntentFromPayload(brief({ planRef: "active/missing.xbrief.json" }), {
      projectRoot: root,
    });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toMatch(/unresolvable parent/);
  });
});

describe("compareExtractedIntent (#3385 R2 / R5)", () => {
  it("byte-equals scalars and allows guarded Decisions/references append", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "decisions"), { recursive: true });
    const decisionRel = "xbrief/decisions/2026-08-16-demo.decision.json";
    writeFileSync(join(root, decisionRel), '{"ok":true}\n', "utf8");

    const base = extractIntentFromPayload(brief(), { approvedReposSeed: ["deftai/directive"] });
    expect(base.ok).toBe(true);
    if (!base.ok) return;

    const livePayload = brief();
    const plan = livePayload.plan as Record<string, unknown>;
    const narratives = { ...(plan.narratives as Record<string, unknown>) };
    narratives.Decisions = `- ${decisionRel} \u2014 recorded`;
    plan.narratives = narratives;
    const refs = [...((plan.references as unknown[]) ?? [])];
    refs.push({
      uri: "https://github.com/deftai/directive/issues/3384",
      type: "x-vbrief/github-issue",
      title: "Wave 1",
    });
    plan.references = refs;
    const live = extractIntentFromPayload(livePayload, { approvedReposSeed: ["deftai/directive"] });
    expect(live.ok).toBe(true);
    if (!live.ok) return;

    const compared = compareExtractedIntent(base.preimage, live.preimage, {
      changedFiles: [decisionRel],
      decisionExists: () => true,
    });
    expect(compared.ok).toBe(true);
  });

  it("fails edit/delete of Decisions and origin refs; unclassified new unknown keys", () => {
    const base = extractIntentFromPayload(brief({ customA: 1 }), {
      approvedReposSeed: ["deftai/directive"],
    });
    expect(base.ok).toBe(true);
    if (!base.ok) return;

    const edited = brief({
      customA: 1,
      customB: 2,
      narratives: { Description: "changed", Decisions: "- gone" },
      references: [],
    });
    const live = extractIntentFromPayload(edited, { approvedReposSeed: ["deftai/directive"] });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    const compared = compareExtractedIntent(base.preimage, live.preimage);
    expect(compared.ok).toBe(false);
    expect(compared.findings.some((f) => f.kind === "intent-drift")).toBe(true);
    expect(compared.findings.some((f) => f.kind === "decisions-mutation")).toBe(true);
    expect(compared.findings.some((f) => f.kind === "reference-mutation")).toBe(true);
    expect(compared.findings.some((f) => f.kind === "unclassified-key")).toBe(true);
  });

  it("rejects a malformed Decisions append and a missing decision file", () => {
    const base = extractIntentFromPayload(brief(), { approvedReposSeed: ["deftai/directive"] });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const livePayload = brief();
    const plan = livePayload.plan as Record<string, unknown>;
    plan.narratives = {
      ...(plan.narratives as Record<string, unknown>),
      Decisions: "- not-a-decision",
    };
    const live = extractIntentFromPayload(livePayload, { approvedReposSeed: ["deftai/directive"] });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    const compared = compareExtractedIntent(base.preimage, live.preimage, {
      decisionExists: () => false,
    });
    expect(compared.findings.some((f) => f.kind === "decisions-mutation")).toBe(true);
  });

  it("rejects appended issue URL outside base approvedRepos", () => {
    const base = extractIntentFromPayload(brief(), { approvedReposSeed: ["deftai/directive"] });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const livePayload = brief();
    const plan = livePayload.plan as Record<string, unknown>;
    plan.references = [
      ...(plan.references as unknown[]),
      {
        uri: "https://github.com/other/repo/issues/1",
        type: "x-xbrief/github-issue",
      },
    ];
    const live = extractIntentFromPayload(livePayload, { approvedReposSeed: ["deftai/directive"] });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    const compared = compareExtractedIntent(base.preimage, live.preimage);
    expect(compared.findings.some((f) => f.kind === "repo-not-approved")).toBe(true);
  });
});

describe("verify intent authority (#3385 R2–R6 / F4)", () => {
  it("same-PR preimage rewrite fails; working-tree preimage is not authority", () => {
    const root = tempRoot();
    const payload = brief();
    const raw = `${JSON.stringify(payload)}\n`;
    const minted = mintApprovedScopeArtifacts({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload,
      rawText: raw,
      projectRoot: root,
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-16T00:00:00Z" },
      extract: { projectRoot: root, approvedReposSeed: ["deftai/directive"] },
    });
    const drifted = brief({ title: "rewritten title" });
    const result = evaluateScopeProvenance(root, {
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        `.deft/approved-scope/${minted.record.planId}.intent.json`,
      ],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(drifted)]]),
      approvedRecords: [minted.record],
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "self-authorizing-scope-expansion")).toBe(true);
  });

  it("passes when live extract matches the base-committed preimage", () => {
    const mintRoot = tempRoot();
    const payload = brief();
    const minted = mintApprovedScopeArtifacts({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload,
      rawText: `${JSON.stringify(payload)}\n`,
      projectRoot: mintRoot,
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-16T00:00:00Z" },
      extract: { projectRoot: mintRoot, approvedReposSeed: ["deftai/directive"] },
    });
    const result = evaluateScopeProvenance(tempRoot(), {
      changedFiles: ["xbrief/active/story.xbrief.json"],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(payload)]]),
      approvedRecords: [minted.record],
      readAtBase: (rel) => (rel.endsWith(".intent.json") ? JSON.stringify(minted.preimage) : null),
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
  });

  it("compares live extract to base preimage and fails unclassified post-approval keys", () => {
    const mintRoot = tempRoot();
    const evalRoot = tempRoot();
    const payload = brief();
    const minted = mintApprovedScopeArtifacts({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload,
      rawText: `${JSON.stringify(payload)}\n`,
      projectRoot: mintRoot,
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-16T00:00:00Z" },
      extract: { projectRoot: mintRoot, approvedReposSeed: ["deftai/directive"] },
    });
    const live = brief({ sneaky: "new structure" });
    const result = evaluateScopeProvenance(evalRoot, {
      changedFiles: ["xbrief/active/story.xbrief.json"],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(live)]]),
      approvedRecords: [minted.record],
      readAtBase: (rel) => {
        if (rel.endsWith(".intent.json")) return JSON.stringify(minted.preimage);
        if (rel.endsWith(".json") && rel.includes("approved-scope")) {
          return JSON.stringify(minted.record);
        }
        return null;
      },
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "unclassified-key")).toBe(true);
  });

  it("legacy records are path-only; xbriefBodyDigest is never authority", () => {
    expect(bodyDigestIsAuthority(null)).toBe(false);
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: {
        plan: { id: "story-1", metadata: { swarm: { file_scope: ["src/a.ts"] } } },
      },
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-16T00:00:00Z" },
    });
    expect(approved.intentDigest).toBeUndefined();
    expect(approved.xbriefBodyDigest).toBeUndefined();
    const live = {
      plan: {
        id: "story-1",
        title: "changed",
        metadata: { swarm: { file_scope: ["src/a.ts"] } },
      },
    };
    const result = evaluateScopeProvenance("/tmp/legacy-3385", {
      changedFiles: ["xbrief/active/story.xbrief.json"],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(live)]]),
      approvedRecords: [{ ...approved, xbriefBodyDigest: "dead-field" }],
      readAtBase: (rel) =>
        rel === "xbrief/active/story.xbrief.json"
          ? JSON.stringify({
              plan: {
                id: "story-1",
                title: "old",
                metadata: { swarm: { file_scope: ["src/a.ts"] } },
              },
            })
          : null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings.some((f) => f.kind === "legacy-intent-edit")).toBe(true);
    expect(result.message).toMatch(/WARN/i);
  });

  it("rejects duplicate keys at verify via tokenizer", () => {
    const approved = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload: { plan: { id: "story-1", metadata: { swarm: { file_scope: ["src/a.ts"] } } } },
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-16T00:00:00Z" },
    });
    const raw =
      '{"plan":{"id":"story-1","id":"other","metadata":{"swarm":{"file_scope":["src/a.ts"]}}}}';
    const result = evaluateScopeProvenance("/tmp/dup-3385", {
      changedFiles: ["xbrief/active/story.xbrief.json"],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", raw]]),
      approvedRecords: [approved],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "duplicate-key")).toBe(true);
  });

  it("fileScopeDigest still matches independently of intentDigest", () => {
    expect(computeFileScopeDigest(["a.ts"])).toHaveLength(64);
  });

  it("first activation with intentDigest and no base preimage fails", () => {
    const mintedRoot = tempRoot();
    const payload = brief();
    const minted = mintApprovedScopeArtifacts({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload,
      rawText: `${JSON.stringify(payload)}\n`,
      projectRoot: mintedRoot,
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-16T00:00:00Z" },
      extract: { projectRoot: mintedRoot, approvedReposSeed: ["deftai/directive"] },
    });
    const result = evaluateScopeProvenance(tempRoot(), {
      changedFiles: ["xbrief/active/story.xbrief.json"],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(payload)]]),
      approvedRecords: [minted.record],
      readAtBase: () => null,
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "first-activation-missing-intent-pin")).toBe(
      true,
    );
  });

  it("rejects a base preimage whose digest does not match the record", () => {
    const mintedRoot = tempRoot();
    const payload = brief();
    const minted = mintApprovedScopeArtifacts({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      payload,
      rawText: `${JSON.stringify(payload)}\n`,
      projectRoot: mintedRoot,
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-16T00:00:00Z" },
      extract: { projectRoot: mintedRoot, approvedReposSeed: ["deftai/directive"] },
    });
    const result = evaluateScopeProvenance(tempRoot(), {
      changedFiles: ["xbrief/active/story.xbrief.json"],
      activeXbriefs: new Map([["xbrief/active/story.xbrief.json", JSON.stringify(payload)]]),
      approvedRecords: [minted.record],
      readAtBase: (rel) =>
        rel.endsWith(".intent.json")
          ? JSON.stringify({ ...minted.preimage, plan: { ...minted.preimage.plan, title: "nope" } })
          : null,
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "intent-digest-mismatch")).toBe(true);
  });
});

describe("extract / mint error paths (#3385)", () => {
  it("rejects non-objects and planRef without a project root", () => {
    expect(extractIntentFromPayload(null).ok).toBe(false);
    expect(extractIntentFromPayload({}).ok).toBe(false);
    expect(extractIntentFromPayload(brief({ planRef: "active/p.xbrief.json" })).ok).toBe(false);
  });

  it("mint throws on duplicate keys", () => {
    expect(() =>
      mintApprovedScopeArtifacts({
        xbriefRelPath: "xbrief/active/story.xbrief.json",
        payload: {},
        rawText: '{"plan":{"id":"x","id":"y"}}',
        projectRoot: tempRoot(),
      }),
    ).toThrow(/duplicate key/);
  });

  it("uses filename stem when parent has no plan.id", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief/active/stem-only.xbrief.json"), '{"plan":{}}', "utf8");
    const r = extractIntentFromPayload(brief({ planRef: "active/stem-only.xbrief.json" }), {
      projectRoot: root,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.preimage.plan.parentId).toBe("stem-only");
  });
});
