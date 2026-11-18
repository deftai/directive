import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SmallChangeLaneGateOverrides } from "../policy/small-change-lane.js";
import { evaluateLaneIngressGate, LANE_INGRESS_WAIVER_NOTICE } from "./lane-ingress-gate.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Git stub: one production file with `lines` changed lines, no public surface. */
function laneGit(root: string, lines: number): SmallChangeLaneGateOverrides["runGit"] {
  return (args) => {
    const joined = args.join(" ");
    if (joined.startsWith("rev-parse --show-toplevel")) return { status: 0, stdout: `${root}\n` };
    if (joined.startsWith("rev-parse --verify")) return { status: 0, stdout: "parent0\n" };
    if (joined.startsWith("ls-files")) return { status: 0, stdout: "" };
    if (joined.startsWith("diff --numstat")) {
      return { status: 0, stdout: `${lines}\t0\tpackages/core/src/x.ts\0` };
    }
    if (joined.includes("diff -U0")) {
      return {
        status: 0,
        stdout: "diff --git a/packages/core/src/x.ts b/packages/core/src/x.ts\n+const x = 1;\n",
      };
    }
    return { status: 1, stdout: "" };
  };
}

function lane(root: string, lines: number): SmallChangeLaneGateOverrides {
  return {
    depth: "rapid",
    bound: { maxProductionFiles: 1, maxChangedLines: 5 },
    runGit: laneGit(root, lines),
  };
}

const THIN_ACCEPTANCE = {
  commands: [{ command: "npx vitest run packages/core/src/x.test.ts" }],
  none_stated: false,
  source_rung: "stated",
};

const CLAUSE = { id: 1, text: "test: returns the corrected value", ambiguous: false };

function marker(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: "deft.small-change-lane.v1", state, admitBase: "admitbase0", ...extra };
}

/** A plan in a temp xbrief/active/ folder; returns the plan object and the brief path. */
function fixture(options: { laneMarker?: Record<string, unknown> | null; clauses?: boolean }): {
  root: string;
  path: string;
  plan: Record<string, unknown>;
} {
  const root = mkdtempSync(join(tmpdir(), "lane-ingress-gate-"));
  roots.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  const metadata: Record<string, unknown> = { swarm: { file_scope: ["packages/core/src/x.ts"] } };
  if (options.laneMarker) metadata["x-directive/smallChangeLane"] = options.laneMarker;
  const plan: Record<string, unknown> = {
    title: "fix x",
    status: "running",
    items: [],
    acceptance: options.clauses
      ? { ...THIN_ACCEPTANCE, clauses: [{ ...CLAUSE, artifact_path: null }] }
      : { ...THIN_ACCEPTANCE },
    metadata,
  };
  const path = join(root, "xbrief", "active", "2026-11-17-thin.xbrief.json");
  writeFileSync(path, JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2), "utf8");
  return { root, path, plan };
}

function laneStateOnDisk(path: string): string | undefined {
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    plan: { metadata: Record<string, { state?: string }> };
  };
  return data.plan.metadata["x-directive/smallChangeLane"]?.state;
}

describe("evaluateLaneIngressGate (#6264)", () => {
  it("returns the lane verdict and the ingress verdict together", () => {
    const { root, path, plan } = fixture({ laneMarker: marker("admitted") });
    const result = evaluateLaneIngressGate(plan, {
      projectRoot: root,
      gate: "xbrief:activate",
      briefPath: path,
      ingress: true,
      smallChangeLane: lane(root, 3),
    });
    expect(result.lane.applies).toBe(true);
    expect(result.lane.verdict?.kind).toBe("admitted");
    expect(result.ingress).not.toBeNull();
    expect(result.ingress?.ok).toBe(false);
    expect(result.laneAdmitsThin).toBe(true);
  });

  it("waives the #4768 ingress refusal when laneAdmitsThin holds", () => {
    const { root, path, plan } = fixture({ laneMarker: marker("admitted") });
    const result = evaluateLaneIngressGate(plan, {
      projectRoot: root,
      gate: "scope:activate",
      briefPath: path,
      ingress: true,
      smallChangeLane: lane(root, 3),
    });
    expect(result.ok).toBe(true);
    expect(result.refusedBy).toBeNull();
    expect(result.applied).toBe(false);
    expect(result.message).toBe(LANE_INGRESS_WAIVER_NOTICE);
    expect(result.message).not.toContain("Refusing active ingress");
  });

  it("keeps the #4768 ingress refusal for a command-only brief with no lane marker", () => {
    const { root, path, plan } = fixture({ laneMarker: null });
    const result = evaluateLaneIngressGate(plan, {
      projectRoot: root,
      gate: "xbrief:activate",
      briefPath: path,
      ingress: true,
      smallChangeLane: lane(root, 3),
    });
    expect(result.ok).toBe(false);
    expect(result.refusedBy).toBe("ingress");
    expect(result.lane.applies).toBe(false);
    expect(result.laneAdmitsThin).toBe(false);
    expect(result.message).toContain("Refusing active ingress (#4768 Prefer-A)");
  });

  it("does not waive for an admitted lane brief whose acceptance carries clauses", () => {
    const { root, path, plan } = fixture({ laneMarker: marker("admitted"), clauses: true });
    const result = evaluateLaneIngressGate(plan, {
      projectRoot: root,
      gate: "scope:activate",
      briefPath: path,
      ingress: true,
      smallChangeLane: lane(root, 3),
    });
    expect(result.laneAdmitsThin).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.ingress?.ok).toBe(true);
  });

  it("refuses with the lane message, names the gate, and skips ingress when the lane refuses", () => {
    for (const laneMarker of [
      marker("crossed", { crossedReason: "bound crossed" }),
      marker("escalated"),
      { schema: "not-a-lane-schema", state: "admitted", admitBase: "admitbase0" },
    ]) {
      const { root, path, plan } = fixture({ laneMarker, clauses: true });
      const before = JSON.stringify(plan);
      const result = evaluateLaneIngressGate(plan, {
        projectRoot: root,
        gate: "xbrief:activate",
        briefPath: path,
        ingress: true,
        smallChangeLane: lane(root, 3),
      });
      expect(result.ok).toBe(false);
      expect(result.refusedBy).toBe("lane");
      expect(result.ingress).toBeNull();
      expect(result.laneAdmitsThin).toBe(false);
      expect(result.message).toContain("xbrief:activate refused (#6204)");
      expect(JSON.stringify(plan)).toBe(before);
    }
  });

  it("keeps the lane gate's crossing record when the bound is crossed", () => {
    const { root, path, plan } = fixture({ laneMarker: marker("admitted") });
    const result = evaluateLaneIngressGate(plan, {
      projectRoot: root,
      gate: "xbrief:activate",
      briefPath: path,
      ingress: true,
      smallChangeLane: lane(root, 50),
    });
    expect(result.ok).toBe(false);
    expect(result.refusedBy).toBe("lane");
    expect(result.message).toContain("recorded on the brief as crossed");
    expect(laneStateOnDisk(path)).toBe("crossed");
  });

  it("returns the lane verdict and laneAdmitsThin without running ingress when not asked", () => {
    const { root, path, plan } = fixture({ laneMarker: marker("admitted") });
    const result = evaluateLaneIngressGate(plan, {
      projectRoot: root,
      gate: "scope:activate",
      briefPath: path,
      ingress: false,
      smallChangeLane: lane(root, 3),
    });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("");
    expect(result.ingress).toBeNull();
    expect(result.laneAdmitsThin).toBe(true);
  });

  it("passes the ingress notice through and reports a clause stamp as applied", () => {
    const { root, path, plan } = fixture({ laneMarker: null });
    plan.narratives = {
      Overview:
        "## Acceptance sketch\n- Persist the session token in packages/core/src/session/token.ts\n",
    };
    const result = evaluateLaneIngressGate(plan, {
      projectRoot: root,
      gate: "xbrief:activate",
      briefPath: path,
      ingress: true,
    });
    expect(result.ok).toBe(true);
    expect(result.lane.applies).toBe(false);
    expect(result.ingress?.applied).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.message).toBe(result.ingress?.message);
  });
});
