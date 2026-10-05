import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintSpecDriftOverrideTemplateGrant } from "../authz/templates.js";
import { SPEC_IMPACT_KEY } from "../policy/spec-guard.js";
import {
  evaluateCompletionCoverage,
  evaluateRewriteProof,
  evaluateSpecDrift,
  findingFromScopeCompletion,
  gateScopeCompleteSpecDrift,
  recordScopeCompleteDriftAdvise,
  seedSpecDriftLedger,
  writeSpecDriftLedger,
} from "./spec-drift.js";

describe("verify:spec-drift (#1589 C2 / #5350 C3)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function setup(opts?: {
    withSpec?: boolean;
    policy?: Record<string, unknown>;
    specItems?: unknown[];
  }) {
    root = mkdtempSync(join(tmpdir(), "spec-drift-"));
    mkdirSync(join(root, "xbrief", ".audit"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "p",
          status: "proposed",
          "x-directive/policy": opts?.policy ?? { specGuard: { enabled: true } },
        },
      }),
    );
    if (opts?.withSpec) {
      writeFileSync(
        join(root, "xbrief", "specification.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", updated: "2026-10-01T00:00:00Z" },
          plan: {
            title: "spec",
            status: "proposed",
            items: opts.specItems ?? [],
          },
        }),
      );
    }
    return root;
  }

  function writeSpec(items: unknown[], updated = "2026-10-01T00:00:00Z") {
    writeFileSync(
      join(root, "xbrief", "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", updated },
        plan: { title: "spec", status: "proposed", items },
      }),
    );
  }

  it("returns unassessable when baseline is unknown", () => {
    setup({ withSpec: false });
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(2);
    expect(result.state).toBe("unassessable");
  });

  it("reports unassessable when ledger is missing under a present baseline", () => {
    setup({ withSpec: true });
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(2);
    expect(result.state).toBe("unassessable");
    expect(result.message).toMatch(/ledger missing/i);
  });

  it("reports drift for unresolved ledger rows against baseline", () => {
    setup({ withSpec: true });
    const live = evaluateSpecDrift(root).baselineRevision;
    expect(live).not.toBeNull();
    writeSpecDriftLedger(root, {
      baselineRevision: live,
      unresolved: [
        {
          scopeId: "rfc-1",
          reason: "missing x-directive/specImpact",
          specImpact: null,
          completedAt: "2026-10-02T00:00:00Z",
        },
      ],
      coverage: [],
      shadowFindings: [],
      lastRequirementsFingerprint: null,
      cutoverBoundary: null,
    });
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(1);
    expect(result.state).toBe("drift");
    expect(result.findings).toHaveLength(1);
  });

  it("is clean when ledger matches baseline with no unresolved rows", () => {
    setup({ withSpec: true });
    const live = evaluateSpecDrift(root).baselineRevision;
    expect(live).not.toBeNull();
    writeSpecDriftLedger(root, {
      baselineRevision: live,
      unresolved: [],
      coverage: [],
      shadowFindings: [],
      lastRequirementsFingerprint: null,
      cutoverBoundary: null,
    });
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(0);
    expect(result.state).toBe("clean");
  });

  it("changes baseline revision when requirements-bearing content changes", () => {
    setup({ withSpec: true });
    const first = evaluateSpecDrift(root).baselineRevision;
    writeSpec([{ id: "n", title: "new" }]);
    const second = evaluateSpecDrift(root).baselineRevision;
    expect(first).not.toBe(second);
  });

  it("ignores status-only metadata churn in baseline revision", () => {
    setup({ withSpec: true });
    const first = evaluateSpecDrift(root).baselineRevision;
    writeFileSync(
      join(root, "xbrief", "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", updated: "2026-10-01T00:00:00Z" },
        plan: { title: "spec", status: "completed", items: [] },
      }),
    );
    const second = evaluateSpecDrift(root).baselineRevision;
    expect(second).toBe(first);
  });

  it("includes plan.requirements in baseline fingerprint", () => {
    setup({ withSpec: true });
    const first = evaluateSpecDrift(root).baselineRevision;
    writeFileSync(
      join(root, "xbrief", "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", updated: "2026-10-01T00:00:00Z" },
        plan: {
          title: "spec",
          status: "proposed",
          items: [],
          requirements: [{ id: "r1", title: "must auth" }],
        },
      }),
    );
    const second = evaluateSpecDrift(root).baselineRevision;
    expect(second).not.toBe(first);
  });

  it("treats non-object specification JSON as unassessable baseline", () => {
    setup({ withSpec: false });
    writeFileSync(join(root, "xbrief", "specification.xbrief.json"), "[]");
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(2);
    expect(result.baselineRevision).toBeNull();
  });

  it("does not seed a clean ledger from a covered completion alone", () => {
    setup({ withSpec: true });
    const finding = recordScopeCompleteDriftAdvise(
      root,
      {
        plan: {
          id: "story-seed",
          title: "RFC: covered",
          tags: ["rfc"],
          [SPEC_IMPACT_KEY]: "delta",
          items: [],
        },
      },
      "xbrief/completed/story-seed.xbrief.json",
    );
    expect(finding).toBeNull();
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/ledger missing/i);
  });

  it("walks nested items/subItems for namespaced impact (advise soft OR)", () => {
    const finding = findingFromScopeCompletion(
      {
        plan: {
          title: "RFC: nested",
          tags: ["rfc"],
          items: [
            {
              id: "outer",
              title: "outer",
              subItems: [{ id: "inner", title: "inner", [SPEC_IMPACT_KEY]: "delta" }],
            },
          ],
        },
      },
      "xbrief/completed/nested.xbrief.json",
    );
    expect(finding).toBeNull();
  });

  it("clears prior unresolved row when later completion declares delta", () => {
    setup({ withSpec: true });
    recordScopeCompleteDriftAdvise(
      root,
      {
        plan: {
          id: "story-clear",
          title: "RFC: uncovered",
          tags: ["rfc"],
          items: [{ id: "i1", title: "t", status: "completed" }],
        },
      },
      "xbrief/completed/story-clear.xbrief.json",
    );
    expect(evaluateSpecDrift(root).code).toBe(1);
    const cleared = recordScopeCompleteDriftAdvise(
      root,
      {
        plan: {
          id: "story-clear",
          title: "RFC: covered",
          tags: ["rfc"],
          [SPEC_IMPACT_KEY]: "delta",
          items: [],
        },
      },
      "xbrief/completed/story-clear.xbrief.json",
    );
    expect(cleared).toBeNull();
    const live = evaluateSpecDrift(root);
    expect(live.code).toBe(0);
    expect(live.findings).toHaveLength(0);
  });

  it("does not treat bare specImpact as discharge signal", () => {
    const finding = findingFromScopeCompletion(
      {
        plan: {
          title: "RFC: something",
          tags: ["rfc"],
          specImpact: "delta",
          items: [],
        },
      },
      "xbrief/completed/rfc.xbrief.json",
    );
    expect(finding).not.toBeNull();
    expect(finding?.reason).toContain(SPEC_IMPACT_KEY);
  });

  it("skips advise when namespaced delta impact is declared", () => {
    setup({ withSpec: true });
    const finding = recordScopeCompleteDriftAdvise(
      root,
      {
        plan: {
          id: "story-1",
          title: "RFC: covered",
          tags: ["rfc"],
          [SPEC_IMPACT_KEY]: "delta",
          items: [],
        },
      },
      "xbrief/completed/story-1.xbrief.json",
    );
    expect(finding).toBeNull();
  });

  it("records advise finding for shape-changing completion without impact", () => {
    setup({ withSpec: true });
    const finding = recordScopeCompleteDriftAdvise(
      root,
      {
        plan: {
          id: "story-2",
          title: "RFC: uncovered",
          tags: ["rfc"],
          items: [{ id: "i1", title: "t", status: "completed" }],
        },
      },
      "xbrief/completed/story-2.xbrief.json",
    );
    expect(finding?.scopeId).toBe("story-2");
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(1);
  });

  const nestedOrScope = {
    plan: {
      id: "nested-or",
      title: "RFC: nested OR",
      tags: ["rfc"],
      items: [
        {
          id: "covered",
          title: "covered",
          [SPEC_IMPACT_KEY]: "delta",
        },
        {
          id: "uncovered",
          title: "uncovered sibling",
        },
      ],
    },
  };

  it("advise-soft: nested OR still clears whole scope", () => {
    const cov = evaluateCompletionCoverage(
      nestedOrScope,
      "xbrief/completed/nested-or.xbrief.json",
      "advise",
    );
    expect(cov.finding).toBeNull();
  });

  it("shadow-warn: nested uncovered sibling surfaces under shadow", () => {
    setup({
      withSpec: true,
      policy: {
        specGuard: { enabled: true, driftGuard: { enforcement: "shadow", trigger: "both" } },
      },
    });
    const gate = gateScopeCompleteSpecDrift(
      root,
      nestedOrScope,
      "xbrief/completed/nested-or.xbrief.json",
    );
    expect(gate.ok).toBe(true);
    expect(gate.shadowFinding).not.toBeNull();
    expect(gate.shadowFinding?.uncoveredItemIds).toContain("uncovered");
  });

  it("enforce-hard: nested uncovered sibling refuses scope:complete", () => {
    setup({
      withSpec: true,
      policy: {
        specGuard: { enabled: true, driftGuard: { enforcement: "enforce", trigger: "both" } },
      },
    });
    const gate = gateScopeCompleteSpecDrift(
      root,
      nestedOrScope,
      "xbrief/completed/nested-or.xbrief.json",
    );
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/refused under specGuard enforce/i);
  });

  it("rewrite proof fails on timestamp-only / unchanged requirements projection", () => {
    const proof = evaluateRewriteProof({
      scopeId: "s1",
      coveredItemIds: ["i1"],
      beforeFingerprint: "abc",
      afterFingerprint: "abc",
      existingCoverage: [],
    });
    expect(proof.ok).toBe(false);
    if (!proof.ok) expect(proof.reason).toMatch(/unchanged/i);
  });

  it("rewrite proof fails on reused before/after evidence", () => {
    const proof = evaluateRewriteProof({
      scopeId: "s1",
      coveredItemIds: ["i1"],
      beforeFingerprint: "aaa",
      afterFingerprint: "bbb",
      existingCoverage: [
        {
          scopeId: "other",
          coveredItemIds: ["x"],
          beforeRequirementsFingerprint: "aaa",
          afterRequirementsFingerprint: "bbb",
          affectedRequirementRefs: [],
          recordedAt: "2026-10-01T00:00:00Z",
          source: "rewrite",
        },
      ],
    });
    expect(proof.ok).toBe(false);
    if (!proof.ok) expect(proof.reason).toMatch(/reused-evidence/i);
  });

  it("rewrite proof passes on valid requirements change", () => {
    const proof = evaluateRewriteProof({
      scopeId: "s1",
      coveredItemIds: ["i1"],
      beforeFingerprint: "aaa",
      afterFingerprint: "bbb",
      existingCoverage: [],
    });
    expect(proof.ok).toBe(true);
  });

  it("enforce stamp-without-rewrite refuses; shadow warns", () => {
    setup({
      withSpec: true,
      policy: {
        specGuard: { enabled: true, driftGuard: { enforcement: "enforce", trigger: "both" } },
      },
    });
    const seeded = seedSpecDriftLedger(root);
    expect(seeded.ok).toBe(true);
    // Timestamp-only churn on SPEC (same requirements fingerprint).
    writeFileSync(
      join(root, "xbrief", "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", updated: "2026-10-02T00:00:00Z" },
        plan: { title: "spec", status: "proposed", items: [] },
      }),
    );
    const scope = {
      plan: {
        id: "stamp-only",
        title: "RFC: stamp",
        tags: ["rfc"],
        items: [{ id: "i1", title: "t", [SPEC_IMPACT_KEY]: "delta" }],
      },
    };
    const enforceGate = gateScopeCompleteSpecDrift(
      root,
      scope,
      "xbrief/completed/stamp-only.xbrief.json",
    );
    expect(enforceGate.ok).toBe(false);

    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "p",
          status: "proposed",
          "x-directive/policy": {
            specGuard: { enabled: true, driftGuard: { enforcement: "shadow", trigger: "both" } },
          },
        },
      }),
    );
    const shadowGate = gateScopeCompleteSpecDrift(
      root,
      scope,
      "xbrief/completed/stamp-only.xbrief.json",
    );
    expect(shadowGate.ok).toBe(true);
    expect(shadowGate.shadowFinding).not.toBeNull();
  });

  it("valid completion-scoped rewrite on durable SPEC passes under enforce", () => {
    setup({
      withSpec: true,
      policy: {
        specGuard: { enabled: true, driftGuard: { enforcement: "enforce", trigger: "both" } },
      },
    });
    expect(seedSpecDriftLedger(root).ok).toBe(true);
    writeSpec([{ id: "req-1", title: "new requirement" }], "2026-10-03T00:00:00Z");
    const scope = {
      plan: {
        id: "rewrote",
        title: "RFC: rewrote",
        tags: ["rfc"],
        items: [{ id: "i1", title: "t", [SPEC_IMPACT_KEY]: "delta" }],
      },
    };
    const gate = gateScopeCompleteSpecDrift(root, scope, "xbrief/completed/rewrote.xbrief.json");
    expect(gate.ok).toBe(true);
  });

  it("live spec-drift-override mint discharges bound ids under enforce", () => {
    setup({
      withSpec: true,
      policy: {
        specGuard: { enabled: true, driftGuard: { enforcement: "enforce", trigger: "both" } },
      },
    });
    const seeded = seedSpecDriftLedger(root);
    expect(seeded.ok).toBe(true);
    const baseline = seeded.baselineRevision;
    expect(baseline).not.toBeNull();
    // No SPEC rewrite — would fail rewrite proof without grant.
    const minted = mintSpecDriftOverrideTemplateGrant({
      projectRoot: root,
      target: baseline as string,
      planRef: "override-scope",
      storyIds: ["i1"],
      actor: "operator",
      singleUse: true,
    });
    expect(minted.ok).toBe(true);
    const scope = {
      plan: {
        id: "override-scope",
        title: "RFC: override",
        tags: ["rfc"],
        items: [{ id: "i1", title: "t", [SPEC_IMPACT_KEY]: "delta" }],
      },
    };
    const gate = gateScopeCompleteSpecDrift(
      root,
      scope,
      "xbrief/completed/override-scope.xbrief.json",
    );
    expect(gate.ok).toBe(true);
  });

  it("spent override grant does not clear enforce refuse", () => {
    setup({
      withSpec: true,
      policy: {
        specGuard: { enabled: true, driftGuard: { enforcement: "enforce", trigger: "both" } },
      },
    });
    const seeded = seedSpecDriftLedger(root);
    const baseline = seeded.baselineRevision as string;
    const minted = mintSpecDriftOverrideTemplateGrant({
      projectRoot: root,
      target: baseline,
      planRef: "spent-scope",
      storyIds: ["i1"],
      actor: "operator",
      singleUse: true,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    // Spend via record path
    recordScopeCompleteDriftAdvise(
      root,
      {
        plan: {
          id: "spent-scope",
          title: "RFC: spent",
          tags: ["rfc"],
          items: [{ id: "i1", title: "t", [SPEC_IMPACT_KEY]: "delta" }],
        },
      },
      "xbrief/completed/spent-scope.xbrief.json",
    );
    const gate = gateScopeCompleteSpecDrift(
      root,
      {
        plan: {
          id: "spent-scope",
          title: "RFC: spent again",
          tags: ["rfc"],
          items: [{ id: "i1", title: "t", [SPEC_IMPACT_KEY]: "delta" }],
        },
      },
      "xbrief/completed/spent-scope.xbrief.json",
    );
    expect(gate.ok).toBe(false);
  });

  it("seeds ledger and refuses silent reseed without --reseed", () => {
    setup({ withSpec: true });
    expect(seedSpecDriftLedger(root).ok).toBe(true);
    expect(seedSpecDriftLedger(root).ok).toBe(false);
    expect(seedSpecDriftLedger(root, { reseed: true }).ok).toBe(true);
  });
});
