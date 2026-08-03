import { describe, expect, it } from "vitest";
import {
  CONSUMER_CHECK_GATES,
  checkGateId,
  checkGateSpawnArgs,
  FRAMEWORK_CHECK_GATES,
  gatesForCheckTarget,
} from "./gate-lists.js";

describe("gate-lists (#2791)", () => {
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
    expect(checkGateSpawnArgs(spec!, "/repo/Taskfile.yml")).toEqual([
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
});
