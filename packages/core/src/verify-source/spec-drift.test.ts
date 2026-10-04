import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SPEC_IMPACT_KEY } from "../policy/spec-guard.js";
import {
  evaluateSpecDrift,
  findingFromScopeCompletion,
  recordScopeCompleteDriftAdvise,
  writeSpecDriftLedger,
} from "./spec-drift.js";

describe("verify:spec-drift (#1589 C2)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function setup(opts?: { withSpec?: boolean; policy?: Record<string, unknown> }) {
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
          plan: { title: "spec", status: "proposed", items: [] },
        }),
      );
    }
    return root;
  }

  it("returns unassessable when baseline is unknown", () => {
    setup({ withSpec: false });
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(2);
    expect(result.state).toBe("unassessable");
  });

  it("reports drift for unresolved ledger rows against baseline", () => {
    setup({ withSpec: true });
    writeSpecDriftLedger(root, {
      baselineRevision: "2026-10-01T00:00:00Z",
      unresolved: [
        {
          scopeId: "rfc-1",
          reason: "missing x-directive/specImpact",
          specImpact: null,
          completedAt: "2026-10-02T00:00:00Z",
        },
      ],
    });
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(1);
    expect(result.state).toBe("drift");
    expect(result.findings).toHaveLength(1);
  });

  it("is clean when ledger matches baseline with no unresolved rows", () => {
    setup({ withSpec: true });
    writeSpecDriftLedger(root, {
      baselineRevision: "2026-10-01T00:00:00Z",
      unresolved: [],
    });
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(0);
    expect(result.state).toBe("clean");
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
});
