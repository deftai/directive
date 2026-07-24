import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inspectOnePolicy } from "./index.js";
import {
  FORCE_ON_VALUE_FEEDBACK_BLOCK,
  ORG_FORCE_ON_MARKER_REL,
  readOrgForceOnMarker,
  runOrgForceOnMigration,
} from "./org-force-on-migration.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { resolveProductSignal } from "./product-signal.js";
import {
  clearValueFeedback,
  FIELD_VALUE_FEEDBACK,
  resolveValueFeedback,
} from "./value-feedback.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeTrustedRepo(plan?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-org-force-on-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], ...plan },
    }),
    "utf8",
  );
  return root;
}

const trustedAutoEnable = {
  autoEnable: { repoResolver: () => "deftai/statusreport", useCache: false },
};

describe("runOrgForceOnMigration", () => {
  it("forces valueFeedback subflags ON from all-false typed baseline (#2822)", () => {
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: {
          enabled: false,
          emitEvents: false,
          sessionLine: false,
          upstreamPrompt: false,
        },
        productSignal: { enabled: false },
      },
    });

    const result = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(result.ran).toBe(true);
    expect(result.valueFeedbackChanged).toBe(true);
    expect(result.productSignalChanged).toBe(true);

    const vf = resolveValueFeedback(root, trustedAutoEnable);
    expect(vf.enabled).toBe(true);
    expect(vf.emitEvents).toBe(true);
    expect(vf.sessionLine).toBe(true);
    expect(vf.upstreamPrompt).toBe(false);
    expect(vf.source).toBe("install-force-on");

    const ps = resolveProductSignal(root);
    expect(ps.enabled).toBe(true);
    expect(ps.source).toBe("install-force-on");

    const marker = readOrgForceOnMarker(root);
    expect(marker?.valueFeedback).toBe(true);
    expect(marker?.productSignal).toBe(true);
    expect(existsSync(join(root, ORG_FORCE_ON_MARKER_REL))).toBe(true);

    const pd = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as { plan: Record<string, unknown> };
    const policyBlock = readPlanPolicy(pd.plan) as Record<string, unknown>;
    expect(policyBlock.valueFeedback).toEqual(FORCE_ON_VALUE_FEEDBACK_BLOCK);
  });

  it("does not re-run after marker is consumed even when typed false returns", () => {
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: {
          enabled: false,
          emitEvents: false,
          sessionLine: false,
          upstreamPrompt: false,
        },
        productSignal: { enabled: false },
      },
    });
    runOrgForceOnMigration(root, trustedAutoEnable);

    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const pd = JSON.parse(readFileSync(pdPath, "utf8")) as { plan: Record<string, unknown> };
    const policyBlock = readPlanPolicy(pd.plan) as Record<string, unknown>;
    policyBlock.valueFeedback = {
      enabled: false,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
    };
    policyBlock.productSignal = { enabled: false };
    writeFileSync(pdPath, JSON.stringify(pd), "utf8");

    const second = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe("marker-present");
    expect(resolveValueFeedback(root, trustedAutoEnable).enabled).toBe(false);
  });

  it("skips non-trusted org repos", () => {
    const root = makeTrustedRepo({
      policy: { valueFeedback: { enabled: false, emitEvents: false, sessionLine: false } },
    });
    const result = runOrgForceOnMigration(root, {
      autoEnable: { repoResolver: () => "other/repo", useCache: false },
    });
    expect(result.skippedReason).toBe("non-trusted-org");
    expect(readOrgForceOnMarker(root)).toBeNull();
  });

  it("policy:show reports install-force-on source", () => {
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: {
          enabled: false,
          emitEvents: false,
          sessionLine: false,
          upstreamPrompt: false,
        },
        productSignal: { enabled: false },
      },
    });
    runOrgForceOnMigration(root, trustedAutoEnable);
    const field = inspectOnePolicy("valueFeedback", root);
    expect(field?.source).toBe("install-force-on");
    expect((field?.current as { enabled: boolean }).enabled).toBe(true);
  });
});

describe("clearValueFeedback", () => {
  it("removes typed key and returns trusted org to org-auto ON", () => {
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: {
          enabled: false,
          emitEvents: false,
          sessionLine: false,
          upstreamPrompt: false,
        },
      },
    });
    runOrgForceOnMigration(root, trustedAutoEnable);
    const cleared = clearValueFeedback(root);
    expect(cleared.exitCode).toBe(0);
    expect(cleared.changed).toBe(true);

    const resolved = resolveValueFeedback(root, trustedAutoEnable);
    expect(resolved.source).toBe("org-auto");
    expect(resolved.enabled).toBe(true);
    expect(resolved.emitEvents).toBe(true);

    const pd = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as { plan: Record<string, unknown> };
    const policyBlock = readPlanPolicy(pd.plan) as Record<string, unknown>;
    expect("valueFeedback" in policyBlock).toBe(false);
  });
});

describe("resolveValueFeedback install-force-on source", () => {
  it("does not label explicit post-migration opt-out as install-force-on", () => {
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: {
          enabled: false,
          emitEvents: false,
          sessionLine: false,
          upstreamPrompt: false,
        },
      },
    });
    runOrgForceOnMigration(root, trustedAutoEnable);
    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const pd = JSON.parse(readFileSync(pdPath, "utf8")) as { plan: Record<string, unknown> };
    const policyBlock = readPlanPolicy(pd.plan) as Record<string, unknown>;
    policyBlock.valueFeedback = {
      enabled: false,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
    };
    writeFileSync(pdPath, JSON.stringify(pd), "utf8");

    const resolved = resolveValueFeedback(root, trustedAutoEnable);
    expect(resolved.source).toBe("typed");
    expect(resolved.enabled).toBe(false);
    expect(FIELD_VALUE_FEEDBACK).toContain("valueFeedback");
  });
});
