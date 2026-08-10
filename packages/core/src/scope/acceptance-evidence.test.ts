import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateAcceptanceEvidenceGate,
  inferRequiredStrictAxes,
  isEvidenceKindSuitable,
} from "./acceptance-evidence.js";
import { runTransition } from "./transition.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "accept-ev-"));
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "P",
        status: "running",
        policy: { deliveryBranch: "master", wipCap: 20 },
      },
    }),
    "utf8",
  );
  return root;
}

const humanProv = {
  kind: "operator-cli",
  actor: "operator@example.com",
  mintedAt: "2026-08-10T12:00:00Z",
  mintedVia: "test",
  eventRef: null as string | null,
};

const testEvidence = {
  kind: "test",
  pointer: "packages/core/src/scope/acceptance-evidence.test.ts",
  recorded_at: "2026-08-10T12:00:00Z",
  recorded_by: "vitest",
};

function writeActive(
  root: string,
  name: string,
  items: unknown[],
  extras: Record<string, unknown> = {},
): string {
  const path = join(root, "xbrief", "active", name);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "t",
        status: "running",
        items,
        ...extras,
      },
    }),
    "utf8",
  );
  return path;
}

describe("acceptance evidence inference (#3240)", () => {
  it("infers strict axes from title and Acceptance narrative", () => {
    expect(
      inferRequiredStrictAxes({
        title: "Runtime smoke passes",
        narrative: { Acceptance: "Smoke after deploy" },
      }),
    ).toEqual(expect.arrayContaining(["smoke", "deploy"]));
    expect(inferRequiredStrictAxes({ title: "UAT sign-off" })).toEqual(["uat"]);
    expect(inferRequiredStrictAxes({ requires: "observed_behavior" })).toEqual([
      "observed_behavior",
    ]);
    expect(inferRequiredStrictAxes({ title: "Unit tests green" })).toEqual([]);
  });

  it("rejects merge/review for strict axes", () => {
    expect(isEvidenceKindSuitable("merge", ["smoke"])).toBe(false);
    expect(isEvidenceKindSuitable("review", ["uat"])).toBe(false);
    expect(isEvidenceKindSuitable("smoke", ["smoke"])).toBe(true);
    expect(isEvidenceKindSuitable("merge", [])).toBe(true);
  });

  it("rejects single-axis evidence when multiple strict axes are required", () => {
    // "Smoke after deploy" infers both axes — one kind cannot cover both (#3240 P1).
    expect(isEvidenceKindSuitable("smoke", ["smoke", "deploy"])).toBe(false);
    expect(isEvidenceKindSuitable("deploy", ["smoke", "deploy"])).toBe(false);
    expect(isEvidenceKindSuitable("smoke", ["smoke", "smoke"])).toBe(true);
  });
});

describe("acceptance evidence gate (#3240)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("fails closed when pending criteria lack evidence and disposition", () => {
    root = makeRepo();
    const file = writeActive(root, "missing.xbrief.json", [
      { title: "No evidence yet", status: "pending" },
      { title: "Also pending", status: "running" },
    ]);
    const result = runTransition("complete", file);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Acceptance evidence required|#3240/);
    expect(result.message).toMatch(/No evidence yet/);
    expect(result.message).toMatch(/Also pending/);
    expect(readFileSync(file, "utf8")).toContain("running");
    expect(result.acceptanceReports?.some((r) => r.outcome === "missing")).toBe(true);
  });

  it("rejects kind=merge alone for a smoke criterion", () => {
    root = makeRepo();
    const file = writeActive(root, "smoke-merge.xbrief.json", [
      {
        title: "Runtime smoke criterion",
        status: "pending",
        narrative: { Acceptance: "Smoke must pass in staging" },
        evidence: {
          kind: "merge",
          pointer: "merge:abc123",
          recorded_at: "2026-08-10T12:00:00Z",
          recorded_by: "ci",
        },
      },
    ]);
    const result = runTransition("complete", file);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not suitable|merge\/review|smoke/i);
    expect(readFileSync(file, "utf8")).toContain("pending");
  });

  it("allows waived disposition with human-origin provenance without full evidence", () => {
    root = makeRepo();
    const file = writeActive(root, "waived.xbrief.json", [
      {
        title: "Smoke deferred by operator",
        status: "pending",
        narrative: { Acceptance: "Smoke in prod" },
        disposition: {
          disposition: "waived",
          reason: "UAT environment unavailable this release; tracked in ops runbook",
          provenance: humanProv,
          recorded_at: "2026-08-10T12:00:00Z",
        },
      },
    ]);
    const result = runTransition("complete", file, new Date("2026-08-10T13:00:00Z"));
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/disposition=waived|Acceptance criteria/);
    const dest = join(root, "xbrief", "completed", "waived.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { status: string; items: Array<{ status: string; disposition: unknown }> };
    };
    expect(data.plan.status).toBe("completed");
    expect(data.plan.items[0]?.status).toBe("completed");
    expect(data.plan.items[0]?.disposition).toBeDefined();
  });

  it("rejects agent-origin disposition provenance", () => {
    root = makeRepo();
    const file = writeActive(root, "agent-waive.xbrief.json", [
      {
        title: "Should not waive",
        status: "pending",
        disposition: {
          disposition: "waived",
          reason: "agent says so",
          provenance: { kind: "operator-cli", actor: "agent:worker" },
          recorded_at: "2026-08-10T12:00:00Z",
        },
      },
    ]);
    const result = runTransition("complete", file);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/human-origin/);
  });

  it("accepts suitable smoke evidence and lists criteria on success", () => {
    root = makeRepo();
    const file = writeActive(root, "smoke-ok.xbrief.json", [
      {
        title: "Smoke green",
        status: "pending",
        requires: "smoke",
        evidence: {
          kind: "smoke",
          pointer: "ci:smoke-job#42",
          recorded_at: "2026-08-10T12:00:00Z",
          recorded_by: "ci",
        },
      },
      {
        title: "Unit tests",
        status: "pending",
        evidence: testEvidence,
      },
    ]);
    const result = runTransition("complete", file);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Acceptance criteria/);
    expect(result.message).toMatch(/kind=smoke/);
    expect(result.message).toMatch(/kind=test/);
    const dest = join(root, "xbrief", "completed", "smoke-ok.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { items: Array<{ status: string }> };
    };
    expect(data.plan.items.every((i) => i.status === "completed")).toBe(true);
  });

  it("rejects smoke-only evidence when criterion text also requires deploy", () => {
    root = makeRepo();
    const file = writeActive(root, "smoke-deploy.xbrief.json", [
      {
        title: "Runtime smoke after deploy",
        status: "pending",
        narrative: { Acceptance: "Smoke must pass after deployment" },
        evidence: {
          kind: "smoke",
          pointer: "ci:smoke-job#42",
          recorded_at: "2026-08-10T12:00:00Z",
          recorded_by: "ci",
        },
      },
    ]);
    const result = runTransition("complete", file);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not suitable|smoke|deploy/i);
  });

  it("evaluateAcceptanceEvidenceGate is pure and lists missing paths", () => {
    const gate = evaluateAcceptanceEvidenceGate({
      items: [
        { title: "a", status: "pending" },
        {
          title: "b",
          status: "completed",
        },
        {
          title: "parent",
          status: "pending",
          evidence: testEvidence,
          subItems: [{ title: "child", status: "proposed" }],
        },
      ],
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/items\[0]/);
    expect(gate.message).toMatch(/items\[2\]\.subItems\[0\]/);
  });

  it("fail/cancel still auto-advance without acceptance evidence", () => {
    root = makeRepo();
    const failPath = writeActive(root, "fail-ok.xbrief.json", [{ title: "p", status: "pending" }]);
    expect(runTransition("fail", failPath).ok).toBe(true);
    const failed = JSON.parse(
      readFileSync(join(root, "xbrief", "completed", "fail-ok.xbrief.json"), "utf8"),
    ) as { plan: { items: Array<{ status: string }> } };
    expect(failed.plan.items[0]?.status).toBe("failed");
  });

  it("empty items complete without evidence", () => {
    root = makeRepo();
    const file = writeActive(root, "empty.xbrief.json", []);
    expect(runTransition("complete", file).ok).toBe(true);
  });
});
