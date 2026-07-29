import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import { inspectOnePolicy } from "./index.js";
import {
  deepEqualPolicySnapshot,
  FORCE_ON_VALUE_FEEDBACK_BLOCK,
  isForceOnValueFeedbackBlock,
  ORG_FORCE_ON_MARKER_REL,
  productSignalInstallForceOnSource,
  readOrgForceOnMarker,
  runOrgForceOnMigration,
  valueFeedbackInstallForceOnSource,
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

  it("persists previous* snapshots on the marker at successful apply (#2903)", () => {
    const baselineVf = {
      enabled: false,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
    };
    const baselinePs = { enabled: false };
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: baselineVf,
        productSignal: baselinePs,
      },
    });

    runOrgForceOnMigration(root, trustedAutoEnable);
    const marker = readOrgForceOnMarker(root);
    expect(marker?.previousValueFeedback).toEqual(baselineVf);
    expect(marker?.previousProductSignal).toEqual(baselinePs);
  });

  it("re-applies when marker present but PD restored to previous snapshot (#2903 discarded PD)", () => {
    const baselineVf = {
      enabled: false,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
    };
    const baselinePs = { enabled: false };
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: baselineVf,
        productSignal: baselinePs,
      },
    });
    runOrgForceOnMigration(root, trustedAutoEnable);
    expect(resolveValueFeedback(root, trustedAutoEnable).enabled).toBe(true);

    // Simulate discarded working-tree PROJECT-DEFINITION (marker left in place).
    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const pd = JSON.parse(readFileSync(pdPath, "utf8")) as { plan: Record<string, unknown> };
    const policyBlock = readPlanPolicy(pd.plan) as Record<string, unknown>;
    policyBlock.valueFeedback = { ...baselineVf };
    policyBlock.productSignal = { ...baselinePs };
    writeFileSync(pdPath, JSON.stringify(pd), "utf8");

    const second = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(second.ran).toBe(true);
    expect(second.valueFeedbackChanged).toBe(true);
    expect(second.productSignalChanged).toBe(true);
    expect(resolveValueFeedback(root, trustedAutoEnable).enabled).toBe(true);
    expect(resolveValueFeedback(root, trustedAutoEnable).source).toBe("install-force-on");
    expect(resolveProductSignal(root).enabled).toBe(true);
  });

  it("does not re-apply intentional post-migration disable that differs from previous (#2903)", () => {
    const baselineVf = {
      enabled: false,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
    };
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: baselineVf,
        productSignal: { enabled: false },
      },
    });
    runOrgForceOnMigration(root, trustedAutoEnable);

    // Intentional opt-out: shape differs from pre-migration snapshot AND force-on.
    const intentionalVf = {
      enabled: false,
      emitEvents: true,
      sessionLine: false,
      upstreamPrompt: false,
    };
    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const pd = JSON.parse(readFileSync(pdPath, "utf8")) as { plan: Record<string, unknown> };
    const policyBlock = readPlanPolicy(pd.plan) as Record<string, unknown>;
    policyBlock.valueFeedback = intentionalVf;
    policyBlock.productSignal = { enabled: false, sinkRepo: "acme/keep-off" };
    writeFileSync(pdPath, JSON.stringify(pd), "utf8");

    const second = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe("marker-present");
    expect(resolveValueFeedback(root, trustedAutoEnable).enabled).toBe(false);
    expect(resolveValueFeedback(root, trustedAutoEnable).source).toBe("typed");
    expect(resolveProductSignal(root).enabled).toBe(false);

    const pdAfter = JSON.parse(readFileSync(pdPath, "utf8")) as { plan: Record<string, unknown> };
    const policyAfter = readPlanPolicy(pdAfter.plan) as Record<string, unknown>;
    expect(policyAfter.valueFeedback).toEqual(intentionalVf);
    expect(policyAfter.productSignal).toEqual({ enabled: false, sinkRepo: "acme/keep-off" });
  });

  it("re-applies when discarded PD has same fields in different key order (#2903)", () => {
    const baselineVf = {
      enabled: false,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
    };
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: baselineVf,
        productSignal: { enabled: false },
      },
    });
    runOrgForceOnMigration(root, trustedAutoEnable);

    // Same semantic values, different key insertion order than the marker snapshot.
    const reorderedVf = {
      upstreamPrompt: false,
      sessionLine: false,
      emitEvents: false,
      enabled: false,
    };
    expect(deepEqualPolicySnapshot(baselineVf, reorderedVf)).toBe(true);

    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const pd = JSON.parse(readFileSync(pdPath, "utf8")) as { plan: Record<string, unknown> };
    const policyBlock = readPlanPolicy(pd.plan) as Record<string, unknown>;
    policyBlock.valueFeedback = reorderedVf;
    policyBlock.productSignal = { enabled: false };
    writeFileSync(pdPath, JSON.stringify(pd), "utf8");

    const second = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(second.ran).toBe(true);
    expect(second.valueFeedbackChanged).toBe(true);
    expect(resolveValueFeedback(root, trustedAutoEnable).enabled).toBe(true);
  });

  it("exact restore of pre-migration snapshot re-applies by company policy (#2903)", () => {
    // Restoring the exact previous all-false block is treated as incomplete migration
    // (discarded PD), not intentional opt-out — intentional opt-out must differ from previous*.
    const baselineVf = {
      enabled: false,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
    };
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: baselineVf,
        productSignal: { enabled: false },
      },
    });
    runOrgForceOnMigration(root, trustedAutoEnable);
    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const pd = JSON.parse(readFileSync(pdPath, "utf8")) as { plan: Record<string, unknown> };
    const policyBlock = readPlanPolicy(pd.plan) as Record<string, unknown>;
    policyBlock.valueFeedback = { ...baselineVf };
    policyBlock.productSignal = { enabled: false };
    writeFileSync(pdPath, JSON.stringify(pd), "utf8");
    const second = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(second.ran).toBe(true);
    expect(resolveValueFeedback(root, trustedAutoEnable).enabled).toBe(true);
  });

  it("re-applies for legacy markers without previous* when PD still needs force-on (#2903)", () => {
    const baselineVf = {
      enabled: false,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
    };
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: baselineVf,
        productSignal: { enabled: false },
      },
    });
    // Pre-#2903 marker shape (no previous* snapshots) + discarded PD.
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    writeFileSync(
      join(root, ORG_FORCE_ON_MARKER_REL),
      `${JSON.stringify({
        version: 1,
        appliedAt: "2026-07-29T14:13:31Z",
        originOrg: "deftai",
        valueFeedback: true,
        productSignal: true,
        directiveVersion: "0.87.0",
      })}\n`,
      "utf8",
    );

    const result = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(result.ran).toBe(true);
    expect(resolveValueFeedback(root, trustedAutoEnable).enabled).toBe(true);
    expect(resolveProductSignal(root).enabled).toBe(true);
    const marker = readOrgForceOnMarker(root);
    expect(marker?.previousValueFeedback).toEqual(baselineVf);
    expect(marker?.previousProductSignal).toEqual({ enabled: false });
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

  it("skips when root .no-deft-directive is present (#2926)", () => {
    const root = makeTrustedRepo({
      policy: { valueFeedback: { enabled: false, emitEvents: false, sessionLine: false } },
    });
    writeFileSync(join(root, ".no-deft-directive"), "", "utf8");
    const result = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe("no-deft-directive");
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

  it("writes a marker without mutation when policy is already force-on shaped", () => {
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: { ...FORCE_ON_VALUE_FEEDBACK_BLOCK },
        productSignal: { enabled: true, sinkRepo: "deftai/product-signal" },
      },
    });
    const result = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(result.skippedReason).toBe("already-enabled");
    expect(result.ran).toBe(false);
    expect(readOrgForceOnMarker(root)?.valueFeedback).toBe(false);
  });

  it("skips when PROJECT-DEFINITION is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-org-force-on-"));
    temps.push(root);
    const result = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(result.skippedReason).toContain("PROJECT-DEFINITION not found");
  });

  it("forces only productSignal when valueFeedback is already fully ON", () => {
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: { ...FORCE_ON_VALUE_FEEDBACK_BLOCK },
        productSignal: { enabled: false },
      },
    });
    const result = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(result.ran).toBe(true);
    expect(result.valueFeedbackChanged).toBe(false);
    expect(result.productSignalChanged).toBe(true);
  });

  it("preserves a custom productSignal sinkRepo during force-on", () => {
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: { ...FORCE_ON_VALUE_FEEDBACK_BLOCK },
        productSignal: { enabled: false, sinkRepo: "acme/custom-signal" },
      },
    });
    runOrgForceOnMigration(root, trustedAutoEnable);
    const ps = resolveProductSignal(root);
    expect(ps.sinkRepo).toBe("acme/custom-signal");
  });

  it("forces valueFeedback when upstreamPrompt is still ON", () => {
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: {
          enabled: true,
          emitEvents: true,
          sessionLine: true,
          upstreamPrompt: true,
        },
        productSignal: { enabled: true },
      },
    });
    const result = runOrgForceOnMigration(root, trustedAutoEnable);
    expect(result.ran).toBe(true);
    expect(result.valueFeedbackChanged).toBe(true);
    expect(resolveValueFeedback(root, trustedAutoEnable).upstreamPrompt).toBe(false);
  });
});

describe("org force-on marker helpers", () => {
  it("returns null for invalid marker JSON", () => {
    const root = makeTrustedRepo();
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    writeFileSync(join(root, ORG_FORCE_ON_MARKER_REL), "{not-json", "utf8");
    expect(readOrgForceOnMarker(root)).toBeNull();
  });

  it("returns null for marker records with the wrong version", () => {
    const root = makeTrustedRepo();
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    writeFileSync(
      join(root, ORG_FORCE_ON_MARKER_REL),
      `${JSON.stringify({
        version: 2,
        appliedAt: "2026-07-25T00:00:00Z",
        originOrg: "deftai",
        valueFeedback: true,
        productSignal: true,
        directiveVersion: "0.85.0",
      })}\n`,
      "utf8",
    );
    expect(readOrgForceOnMarker(root)).toBeNull();
  });

  it("detects install-force-on source only for matching typed blocks", () => {
    const root = makeTrustedRepo({
      policy: {
        valueFeedback: { ...FORCE_ON_VALUE_FEEDBACK_BLOCK },
        productSignal: { enabled: true },
      },
    });
    runOrgForceOnMigration(root, trustedAutoEnable);
    writeFileSync(
      join(root, ORG_FORCE_ON_MARKER_REL),
      `${JSON.stringify({
        version: 1,
        appliedAt: "2026-07-25T00:00:00Z",
        originOrg: "deftai",
        valueFeedback: true,
        productSignal: true,
        directiveVersion: "0.85.0",
      })}\n`,
      "utf8",
    );
    expect(isForceOnValueFeedbackBlock(FORCE_ON_VALUE_FEEDBACK_BLOCK)).toBe(true);
    expect(isForceOnValueFeedbackBlock({ enabled: true })).toBe(false);
    expect(valueFeedbackInstallForceOnSource(root, FORCE_ON_VALUE_FEEDBACK_BLOCK)).toBe(
      "install-force-on",
    );
    expect(productSignalInstallForceOnSource(root, { enabled: true })).toBe("install-force-on");
    expect(productSignalInstallForceOnSource(root, { enabled: false })).toBeNull();
    expect(valueFeedbackInstallForceOnSource(root, { enabled: true })).toBeNull();
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

const itSymlink = it.skipIf(process.platform === "win32");

describe("org-force-on marker projection containment (#2839)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshEscape(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  }

  itSymlink("refuses when org-force-on marker path is a symlink outside the project", () => {
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
    created.push(root);
    const escapeDir = freshEscape("org-force-on-escape-");
    const escapeFile = join(escapeDir, "stolen-marker.json");
    writeFileSync(escapeFile, '{"victim":true}\n', "utf8");
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    symlinkSync(escapeFile, join(root, ORG_FORCE_ON_MARKER_REL));

    expect(() => runOrgForceOnMigration(root, trustedAutoEnable)).toThrow(
      ProjectionContainmentError,
    );
    expect(readFileSync(escapeFile, "utf8")).toBe('{"victim":true}\n');
  });
});
