import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ITEM_CORE, scanVbrief } from "../vbrief-validate/conformance.js";
import {
  ACCEPTANCE_DISPOSITION_KEY,
  ACCEPTANCE_EVIDENCE_KEY,
  evaluateAcceptanceEvidenceGate,
  evaluateScopeCompleteAcceptanceWalk,
  inferRequiredStrictAxes,
  isEvidenceKindSuitable,
  readNamespacedAcceptanceFields,
  SCOPE_COMPLETE_ACCEPTANCE_REMEDIATION,
  stampNamespacedDisposition,
  stampNamespacedEvidence,
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

/** Attach namespaced evidence on a plan item (#3305). */
function withEvidence(
  item: Record<string, unknown>,
  evidence = testEvidence,
): Record<string, unknown> {
  return { ...item, [ACCEPTANCE_EVIDENCE_KEY]: evidence };
}

function withDisposition(
  item: Record<string, unknown>,
  disposition: Record<string, unknown>,
): Record<string, unknown> {
  return { ...item, [ACCEPTANCE_DISPOSITION_KEY]: disposition };
}

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

describe("namespaced acceptance keys (#3305 Option B)", () => {
  it("ITEM_CORE does not include bare evidence or disposition", () => {
    expect(ITEM_CORE.has("evidence")).toBe(false);
    expect(ITEM_CORE.has("disposition")).toBe(false);
  });

  it("stamp helpers write only namespaced keys and clear conflicting acceptance fields", () => {
    const item: Record<string, unknown> = {
      title: "t",
      status: "pending",
      evidence: { kind: "test", pointer: "stale" },
      [ACCEPTANCE_DISPOSITION_KEY]: {
        disposition: "waived",
        reason: "old",
        provenance: humanProv,
        recorded_at: "2026-08-10T12:00:00Z",
      },
    };
    stampNamespacedEvidence(item, testEvidence);
    expect(item[ACCEPTANCE_EVIDENCE_KEY]).toEqual(testEvidence);
    expect(item.evidence).toBeUndefined();
    expect(item.disposition).toBeUndefined();
    expect(item[ACCEPTANCE_DISPOSITION_KEY]).toBeUndefined();

    const item2: Record<string, unknown> = {
      title: "t2",
      status: "pending",
      disposition: { disposition: "waived" },
      [ACCEPTANCE_EVIDENCE_KEY]: testEvidence,
    };
    stampNamespacedDisposition(item2, {
      disposition: "deferred",
      reason: "later",
      provenance: { kind: "operator-cli", actor: "op@example.com" },
      recorded_at: "2026-08-10T12:00:00Z",
      resume_when: "next sprint",
    });
    expect(item2[ACCEPTANCE_DISPOSITION_KEY]).toMatchObject({
      disposition: "deferred",
      reason: "later",
      resume_when: "next sprint",
    });
    expect(item2.disposition).toBeUndefined();
    expect(item2.evidence).toBeUndefined();
    expect(item2[ACCEPTANCE_EVIDENCE_KEY]).toBeUndefined();
  });

  it("readNamespacedAcceptanceFields ignores bare keys", () => {
    const fields = readNamespacedAcceptanceFields({
      evidence: testEvidence,
      disposition: {
        disposition: "waived",
        reason: "x",
        provenance: humanProv,
        recorded_at: "2026-08-10T12:00:00Z",
      },
    });
    expect(fields.hasEvidence).toBe(false);
    expect(fields.hasDisposition).toBe(false);
    expect(fields.hasBareEvidence).toBe(true);
    expect(fields.hasBareDisposition).toBe(true);
  });
});

describe("acceptance evidence gate (#3240 / #3305)", () => {
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
    expect(result.message).toMatch(/x-directive\/evidence/);
    expect(readFileSync(file, "utf8")).toContain("running");
    expect(result.acceptanceReports?.some((r) => r.outcome === "missing")).toBe(true);
  });

  it("treats bare evidence as missing (not dual-read success) (#3305)", () => {
    root = makeRepo();
    const file = writeActive(root, "bare-ev.xbrief.json", [
      {
        title: "Bare key only",
        status: "pending",
        evidence: testEvidence,
      },
    ]);
    const result = runTransition("complete", file);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(
      /bare evidence\/disposition ignored|x-directive\/evidence|#3305/i,
    );
    expect(result.acceptanceReports?.some((r) => r.outcome === "missing")).toBe(true);
    // Gate must not accept bare as typed evidence success.
    expect(result.acceptanceReports?.some((r) => r.outcome === "evidence")).toBe(false);
  });

  it("treats bare disposition as missing (not dual-read success) (#3305)", () => {
    const gate = evaluateAcceptanceEvidenceGate({
      items: [
        {
          title: "bare disp",
          status: "pending",
          disposition: {
            disposition: "waived",
            reason: "legacy",
            provenance: humanProv,
            recorded_at: "2026-08-10T12:00:00Z",
          },
        },
      ],
    });
    expect(gate.ok).toBe(false);
    expect(gate.reports[0]?.outcome).toBe("missing");
  });

  it("rejects kind=merge alone for a smoke criterion", () => {
    root = makeRepo();
    const file = writeActive(root, "smoke-merge.xbrief.json", [
      withEvidence(
        {
          title: "Runtime smoke criterion",
          status: "pending",
          narrative: { Acceptance: "Smoke must pass in staging" },
        },
        {
          kind: "merge",
          pointer: "merge:abc123",
          recorded_at: "2026-08-10T12:00:00Z",
          recorded_by: "ci",
        },
      ),
    ]);
    const result = runTransition("complete", file);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not suitable|merge\/review|smoke/i);
    expect(readFileSync(file, "utf8")).toContain("pending");
  });

  it("allows waived disposition with human-origin provenance without full evidence", () => {
    root = makeRepo();
    const file = writeActive(root, "waived.xbrief.json", [
      withDisposition(
        {
          title: "Smoke deferred by operator",
          status: "pending",
          narrative: { Acceptance: "Smoke in prod" },
        },
        {
          disposition: "waived",
          reason: "UAT environment unavailable this release; tracked in ops runbook",
          provenance: humanProv,
          recorded_at: "2026-08-10T12:00:00Z",
        },
      ),
    ]);
    const result = runTransition("complete", file, new Date("2026-08-10T13:00:00Z"));
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/disposition=waived|Acceptance criteria/);
    const dest = join(root, "xbrief", "completed", "waived.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: {
        status: string;
        items: Array<Record<string, unknown>>;
      };
    };
    expect(data.plan.status).toBe("completed");
    expect(data.plan.items[0]?.status).toBe("completed");
    expect(data.plan.items[0]?.[ACCEPTANCE_DISPOSITION_KEY]).toBeDefined();
    expect(data.plan.items[0]?.disposition).toBeUndefined();
  });

  it("rejects agent-origin disposition provenance", () => {
    root = makeRepo();
    const file = writeActive(root, "agent-waive.xbrief.json", [
      withDisposition(
        {
          title: "Should not waive",
          status: "pending",
        },
        {
          disposition: "waived",
          reason: "agent says so",
          provenance: { kind: "operator-cli", actor: "agent:worker" },
          recorded_at: "2026-08-10T12:00:00Z",
        },
      ),
    ]);
    const result = runTransition("complete", file);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/human-origin/);
  });

  it("accepts suitable smoke evidence and lists criteria on success", () => {
    root = makeRepo();
    const file = writeActive(root, "smoke-ok.xbrief.json", [
      withEvidence(
        {
          title: "Smoke green",
          status: "pending",
          requires: "smoke",
        },
        {
          kind: "smoke",
          pointer: "ci:smoke-job#42",
          recorded_at: "2026-08-10T12:00:00Z",
          recorded_by: "ci",
        },
      ),
      withEvidence({
        title: "Unit tests",
        status: "pending",
      }),
    ]);
    const result = runTransition("complete", file);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Acceptance criteria/);
    expect(result.message).toMatch(/kind=smoke/);
    expect(result.message).toMatch(/kind=test/);
    const dest = join(root, "xbrief", "completed", "smoke-ok.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { items: Array<Record<string, unknown>> };
    };
    expect(data.plan.items.every((i) => i.status === "completed")).toBe(true);
    expect(data.plan.items[0]?.[ACCEPTANCE_EVIDENCE_KEY]).toBeDefined();
  });

  it("rejects smoke-only evidence when criterion text also requires deploy", () => {
    root = makeRepo();
    const file = writeActive(root, "smoke-deploy.xbrief.json", [
      withEvidence(
        {
          title: "Runtime smoke after deploy",
          status: "pending",
          narrative: { Acceptance: "Smoke must pass after deployment" },
        },
        {
          kind: "smoke",
          pointer: "ci:smoke-job#42",
          recorded_at: "2026-08-10T12:00:00Z",
          recorded_by: "ci",
        },
      ),
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
        withEvidence(
          {
            title: "parent",
            status: "pending",
            subItems: [{ title: "child", status: "proposed" }],
          },
          testEvidence,
        ),
      ],
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/items\[0]/);
    expect(gate.message).toMatch(/items\[2\]\.subItems\[0\]/);
  });

  it("already-terminal items skip typed evidence re-check (#3240 / #3305 policy)", () => {
    const gate = evaluateAcceptanceEvidenceGate({
      items: [
        // Terminal with no typed evidence — explicit skip, not a silent dual success.
        {
          title: "legacy narrative only",
          status: "completed",
          narrative: { Result: "done via narrative workaround", Verification: "manual" },
        },
        // Terminal with bare (invalid) evidence still already_terminal, not evidence success.
        {
          title: "terminal bare",
          status: "completed",
          evidence: testEvidence,
        },
        // Terminal with namespaced evidence still already_terminal (not re-validated).
        withEvidence({
          title: "terminal namespaced",
          status: "failed",
        }),
      ],
    });
    expect(gate.ok).toBe(true);
    expect(gate.reports.every((r) => r.outcome === "already_terminal")).toBe(true);
    expect(gate.reports.some((r) => r.outcome === "evidence")).toBe(false);
    expect(gate.reports[0]?.detail).toMatch(/typed evidence not re-checked/);
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

  it("scope:complete fails closed on empty stamped acceptance (disposition is not a substitute) (#3357)", () => {
    root = makeRepo();
    const file = writeActive(
      root,
      "empty-ac.xbrief.json",
      [
        withDisposition(
          { title: "Waived item", status: "pending" },
          {
            disposition: "waived",
            reason: "operator waived the item",
            provenance: humanProv,
            recorded_at: "2026-08-14T12:00:00Z",
          },
        ),
      ],
      {
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
    );
    const result = runTransition("complete", file);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(SCOPE_COMPLETE_ACCEPTANCE_REMEDIATION);
    expect(result.message).toMatch(/soft_empty|#3334|#3357/);
    expect(readFileSync(file, "utf8")).toContain("running");
  });

  it("scope:complete fails closed on failing acceptance commands (#3357)", () => {
    const walk = evaluateScopeCompleteAcceptanceWalk(
      {
        title: "failing product",
        acceptance: {
          commands: [{ command: "false", expectedExitCode: 0 }],
          none_stated: false,
          source_rung: "derived",
        },
        metadata: {
          literal_acceptance_commands: [
            { command: "false", source: "explicit", expectedExitCode: 0 },
          ],
        },
        items: [
          withDisposition(
            { title: "Waived", status: "pending" },
            {
              disposition: "waived",
              reason: "not a substitute",
              provenance: humanProv,
              recorded_at: "2026-08-14T12:00:00Z",
            },
          ),
        ],
      },
      {
        projectRoot: process.cwd(),
        runner: () => ({ exitCode: 1, stdout: "", stderr: "product wrong" }),
        captureFromNarratives: false,
        hasSuiteFloor: true,
      },
    );
    expect(walk.ok).toBe(false);
    expect(walk.message).toContain(SCOPE_COMPLETE_ACCEPTANCE_REMEDIATION);
  });

  it("acceptance walk is not required when plan.acceptance is unstamped (#3357)", () => {
    const walk = evaluateScopeCompleteAcceptanceWalk(
      { title: "legacy", items: [] },
      { projectRoot: process.cwd(), hasSuiteFloor: false },
    );
    expect(walk.ok).toBe(true);
    expect(walk.message).toMatch(/not required/);
  });
});

/**
 * Cross-gate regression (#3305): namespaced evidence must pass BOTH the completion
 * acceptance-evidence path and verify:vbrief-conformance (scanVbrief) in the same
 * vitest surface exercised by task check — not commit-hook-only.
 */
describe("cross-gate namespaced evidence + vbrief-conformance (#3305)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("pending item with valid namespaced evidence passes complete and scanVbrief", () => {
    root = makeRepo();
    // Conformant item: only ITEM_CORE + x-directive/* keys (no bare requires/evidence).
    const pendingItem = {
      id: "cross-gate-criterion",
      title: "Unit tests pass",
      status: "pending",
      narrative: {
        Acceptance:
          "Given the namespaced evidence contract, when complete and conformance run, both pass.",
      },
      [ACCEPTANCE_EVIDENCE_KEY]: {
        kind: "test",
        pointer: "packages/core/src/scope/acceptance-evidence.test.ts#cross-gate",
        recorded_at: "2026-08-12T00:00:00Z",
        recorded_by: "vitest",
      },
    };
    const doc = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "cross-gate-3305",
        status: "running",
        items: [pendingItem],
      },
    };

    // Conformance: namespaced key accepted; no bare findings.
    const confFindings = scanVbrief("xbrief/active/cross-gate.xbrief.json", doc);
    expect(confFindings).toEqual([]);

    // Complete path: acceptance gate + transition.
    const file = writeActive(root, "cross-gate.xbrief.json", [pendingItem]);
    const result = runTransition("complete", file);
    expect(result.ok).toBe(true);
    expect(result.acceptanceReports?.some((r) => r.outcome === "evidence")).toBe(true);

    const dest = join(root, "xbrief", "completed", "cross-gate.xbrief.json");
    const completed = JSON.parse(readFileSync(dest, "utf8")) as unknown;
    // Completed artifact remains conformant (namespaced only).
    expect(scanVbrief("xbrief/completed/cross-gate.xbrief.json", completed)).toEqual([]);
  });

  it("bare evidence fails conformance and is not acceptance success", () => {
    const bareDoc = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "bare-bad",
        status: "running",
        items: [
          {
            id: "bare",
            title: "Has bare evidence",
            status: "pending",
            narrative: { Acceptance: "must fail both gates" },
            evidence: testEvidence,
          },
        ],
      },
    };
    const confFindings = scanVbrief("xbrief/active/bare-bad.xbrief.json", bareDoc);
    expect(confFindings.some((f) => f.key === "evidence" && f.level === "item")).toBe(true);

    const gate = evaluateAcceptanceEvidenceGate(bareDoc.plan);
    expect(gate.ok).toBe(false);
    expect(gate.reports[0]?.outcome).toBe("missing");
  });

  it("bare disposition fails conformance and is not acceptance success", () => {
    const bareDoc = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "bare-disp",
        status: "running",
        items: [
          {
            id: "bare-d",
            title: "Has bare disposition",
            status: "pending",
            narrative: { Acceptance: "must fail both gates" },
            disposition: {
              disposition: "waived",
              reason: "legacy bare key",
              provenance: humanProv,
              recorded_at: "2026-08-12T00:00:00Z",
            },
          },
        ],
      },
    };
    const confFindings = scanVbrief("xbrief/active/bare-disp.xbrief.json", bareDoc);
    expect(confFindings.some((f) => f.key === "disposition" && f.level === "item")).toBe(true);

    const gate = evaluateAcceptanceEvidenceGate(bareDoc.plan);
    expect(gate.ok).toBe(false);
    expect(gate.reports[0]?.outcome).toBe("missing");
  });
});
