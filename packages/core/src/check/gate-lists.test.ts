import { describe, expect, it } from "vitest";
import {
  CONSUMER_CHECK_GATES,
  checkGateId,
  checkGateSpawnArgs,
  FRAMEWORK_CHECK_GATES,
  gatesForCheckTarget,
  isFastBeforeSlowOrder,
  isSuiteCheckGate,
  SUITE_CHECK_GATE_IDS,
} from "./gate-lists.js";

describe("gate-lists (#2791)", () => {
  it("places product AC gate first on framework and consumer lists (#3284)", () => {
    const fwFirst = FRAMEWORK_CHECK_GATES[0];
    const consumerFirst = CONSUMER_CHECK_GATES[0];
    expect(fwFirst).toBeDefined();
    expect(consumerFirst).toBeDefined();
    if (fwFirst === undefined || consumerFirst === undefined) {
      throw new Error("expected non-empty framework/consumer gate lists");
    }
    expect(checkGateId(fwFirst)).toBe("verify:ac");
    expect(checkGateId(consumerFirst)).toBe("verify:ac");
    expect(checkGateSpawnArgs(fwFirst, "/repo/Taskfile.yml")).toContain("--soft-missing-xbrief");
  });

  it("maps framework WIP-cap and eval-relocation shims to public tasks with flags", () => {
    const ids = FRAMEWORK_CHECK_GATES.map(checkGateId);
    expect(ids).toContain("verify:wip-cap");
    expect(ids).toContain("verify:eval-health-relocation");
    expect(ids).toContain("verify:eval-triggers-relocation");
    expect(ids).not.toContain("verify-wip-cap-framework-self-check");
    expect(ids).not.toContain("verify-eval-health-relocation-framework-check");
    expect(ids).not.toContain("verify-eval-triggers-relocation-framework-check");
  });

  it("spawns public WIP-cap with --allow-over-cap after --", () => {
    const spec = FRAMEWORK_CHECK_GATES.find((g) => checkGateId(g) === "verify:wip-cap");
    expect(spec).toBeDefined();
    if (spec === undefined) {
      throw new Error("expected verify:wip-cap gate");
    }
    expect(checkGateSpawnArgs(spec, "/repo/Taskfile.yml")).toEqual([
      "verify:wip-cap",
      "--taskfile",
      "/repo/Taskfile.yml",
      "--",
      "--allow-over-cap",
    ]);
  });

  it("spawns bare string gates without a -- separator", () => {
    expect(checkGateSpawnArgs("verify:branch", "/repo/Taskfile.yml")).toEqual([
      "verify:branch",
      "--taskfile",
      "/repo/Taskfile.yml",
    ]);
  });

  it("keeps consumer check on bare verify:wip-cap (no allow-over-cap)", () => {
    const consumer = gatesForCheckTarget("check:consumer");
    const wip = consumer.find((g) => checkGateId(g) === "verify:wip-cap");
    expect(wip).toBe("verify:wip-cap");
  });

  it("keeps verify:orphan-active on the consumer gate list (#3070)", () => {
    const ids = CONSUMER_CHECK_GATES.map(checkGateId);
    expect(ids).toContain("verify:orphan-active");
    expect(gatesForCheckTarget("check:consumer").map(checkGateId)).toContain(
      "verify:orphan-active",
    );
  });

  it("keeps verify:completed-tracked as a standalone verb, not a check-graph gate (#3264)", () => {
    // Delivery-tip land check is a deliberate standalone surface so lifecycle
    // land PRs are not deadlocked by check:consumer / check:framework-source.
    const consumer = CONSUMER_CHECK_GATES.map(checkGateId);
    const framework = FRAMEWORK_CHECK_GATES.map(checkGateId);
    expect(consumer).not.toContain("verify:completed-tracked");
    expect(framework).not.toContain("verify:completed-tracked");
  });

  it("includes verify:telemetry-coverage on the framework list only (#3362)", () => {
    expect(FRAMEWORK_CHECK_GATES.map(checkGateId)).toContain("verify:telemetry-coverage");
    expect(CONSUMER_CHECK_GATES.map(checkGateId)).not.toContain("verify:telemetry-coverage");
  });

  it("includes #3145 enforcement gates on framework and consumer lists", () => {
    const framework = FRAMEWORK_CHECK_GATES.map(checkGateId);
    const consumer = CONSUMER_CHECK_GATES.map(checkGateId);
    for (const gate of [
      "verify:test-boundary",
      "verify:scope-provenance",
      "verify:consumer-check-contract",
    ]) {
      expect(framework).toContain(gate);
      expect(consumer).toContain(gate);
    }
  });
});

describe("gate-lists fast-before-slow (#3188)", () => {
  it("classifies ts:check-lane as the suite gate", () => {
    expect(SUITE_CHECK_GATE_IDS).toContain("ts:check-lane");
    expect(isSuiteCheckGate("ts:check-lane")).toBe(true);
    expect(isSuiteCheckGate("verify:cache-fresh")).toBe(false);
    expect(isSuiteCheckGate({ task: "ts:check-lane" })).toBe(true);
  });

  it("places all suite gates after every non-suite gate on framework list", () => {
    expect(isFastBeforeSlowOrder(FRAMEWORK_CHECK_GATES)).toBe(true);
    const ids = FRAMEWORK_CHECK_GATES.map(checkGateId);
    const suiteIdx = ids.indexOf("ts:check-lane");
    expect(suiteIdx).toBe(ids.length - 1);
    for (const cheap of [
      "verify:cache-fresh",
      "verify:orphan-active",
      "verify:branch",
      "verify:contract-drift",
      "verify:license-sync",
    ]) {
      expect(ids.indexOf(cheap)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(cheap)).toBeLessThan(suiteIdx);
    }
  });

  it("keeps consumer gate list free of suite gates and fast-before-slow valid", () => {
    expect(isFastBeforeSlowOrder(CONSUMER_CHECK_GATES)).toBe(true);
    expect(CONSUMER_CHECK_GATES.some(isSuiteCheckGate)).toBe(false);
  });

  it("rejects an ordering that puts a cheap gate after the suite", () => {
    expect(isFastBeforeSlowOrder(["ts:check-lane", "verify:cache-fresh"])).toBe(false);
    expect(isFastBeforeSlowOrder(["verify:cache-fresh", "ts:check-lane"])).toBe(true);
  });

  it("exposes ordered gates via gatesForCheckTarget", () => {
    expect(isFastBeforeSlowOrder(gatesForCheckTarget("check:framework-source"))).toBe(true);
    expect(isFastBeforeSlowOrder(gatesForCheckTarget("check:consumer"))).toBe(true);
  });
});
