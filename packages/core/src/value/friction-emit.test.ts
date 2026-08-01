import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRegistryCache, readEvents } from "../lifecycle/events.js";
import {
  probeFrictionAtWorkBoundary,
  recordFrictionFromContradictoryGates,
} from "./friction-emit.js";

const temps: string[] = [];

afterEach(() => {
  clearRegistryCache();
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedContradictionRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-friction-emit-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.6" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: {
          valueFeedback: { enabled: true, emitEvents: true },
        },
        "x-directive/policy": {
          triageScope: [{ rule: "all-open" }],
        },
      },
    }),
    "utf8",
  );
  mkdirSync(join(root, "xbrief", ".eval"), { recursive: true });
  writeFileSync(join(root, "xbrief", ".eval", "candidates.jsonl"), '{"issue":1}\n', "utf8");
  return root;
}

function makeRepo(valueFeedback?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-friction-emit-policy-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        ...(valueFeedback !== undefined ? { policy: { valueFeedback } } : {}),
      },
    }),
    "utf8",
  );
  return root;
}

function logPath(root: string): string {
  return join(root, ".deft-cache", "events.jsonl");
}

describe("recordFrictionFromContradictoryGates (#2339)", () => {
  const enabledPolicy = {
    enabled: true,
    emitEvents: true,
    sessionLine: true,
    upstreamPrompt: false,
    source: "typed" as const,
    error: null,
  };

  it("does not invent friction from the fixed #1694 omit-by-design seed", () => {
    // Pre-#1694 this seed fired wipCap-unsatisfiable-nudge. After the fix,
    // greenfield incomplete is satisfiable via out-of-band decision provenance,
    // so eval:health no longer reports a contradiction for this shape.
    const root = seedContradictionRepo();
    const log = logPath(root);
    const recorded = recordFrictionFromContradictoryGates(root, {
      logPath: log,
      policyOverride: enabledPolicy,
    });
    expect(recorded).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  it("stays silent when value feedback is disabled", () => {
    const root = seedContradictionRepo();
    const log = logPath(root);
    expect(
      recordFrictionFromContradictoryGates(root, {
        logPath: log,
        policyOverride: {
          enabled: false,
          emitEvents: false,
          sessionLine: false,
          upstreamPrompt: false,
          source: "default",
          error: null,
        },
      }),
    ).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  it("returns zero when no contradictory gates are present", () => {
    const root = makeRepo({ enabled: true, emitEvents: true });
    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const raw: unknown = JSON.parse(readFileSync(pdPath, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("fixture must be an object");
    }
    const data = raw as Record<string, unknown>;
    const plan = data.plan as Record<string, unknown>;
    const policy = plan.policy as Record<string, unknown>;
    policy.wipCap = 8;
    writeFileSync(pdPath, JSON.stringify(data), "utf8");

    const log = logPath(root);
    expect(
      probeFrictionAtWorkBoundary(root, {
        logPath: log,
        policyOverride: enabledPolicy,
      }),
    ).toBe(0);
  });
});
