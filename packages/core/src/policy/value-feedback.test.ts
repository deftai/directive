import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inspectOnePolicy } from "./index.js";
import {
  DEFAULT_VALUE_FEEDBACK_ENABLED,
  enableValueFeedback,
  FIELD_VALUE_FEEDBACK,
  FIELD_VALUE_FEEDBACK_CLI_ALIAS,
  inspectValueFeedback,
  isValueFeedbackPathAllowed,
  resolveValueFeedback,
  VALUE_FEEDBACK_CAPABILITY_COST_DISCLOSURE,
  VALUE_FEEDBACK_SUBFLAG_DEFAULTS_WHEN_ENABLED,
  validateValueFeedback,
} from "./value-feedback.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(plan?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-value-feedback-"));
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

describe("validateValueFeedback", () => {
  it("accepts null/undefined", () => {
    expect(validateValueFeedback(null)).toEqual([]);
    expect(validateValueFeedback(undefined)).toEqual([]);
  });

  it("rejects non-objects", () => {
    expect(validateValueFeedback("x")[0]).toContain("must be an object");
  });

  it("rejects non-boolean sub-fields", () => {
    expect(validateValueFeedback({ enabled: "yes" })[0]).toContain("enabled");
  });
});

describe("resolveValueFeedback defaults", () => {
  it("defaults OFF when valueFeedback is unset", () => {
    const root = makeRepo({ policy: { wipCap: 10 } });
    const resolved = resolveValueFeedback(root);
    expect(resolved.enabled).toBe(DEFAULT_VALUE_FEEDBACK_ENABLED);
    expect(resolved.emitEvents).toBe(false);
    expect(resolved.sessionLine).toBe(false);
    expect(resolved.upstreamPrompt).toBe(false);
    expect(resolved.source).toBe("default");
  });

  it("short-circuits all sub-flags when enabled is false", () => {
    const root = makeRepo({
      policy: {
        valueFeedback: {
          enabled: false,
          emitEvents: true,
          sessionLine: true,
          upstreamPrompt: true,
        },
      },
    });
    const resolved = resolveValueFeedback(root);
    expect(resolved.enabled).toBe(false);
    expect(resolved.emitEvents).toBe(false);
    expect(resolved.sessionLine).toBe(false);
    expect(resolved.upstreamPrompt).toBe(false);
  });

  it("applies tiered sub-flag defaults when enabled without explicit sub-flags", () => {
    const root = makeRepo({ policy: { valueFeedback: { enabled: true } } });
    const resolved = resolveValueFeedback(root);
    expect(resolved.enabled).toBe(true);
    expect(resolved.emitEvents).toBe(VALUE_FEEDBACK_SUBFLAG_DEFAULTS_WHEN_ENABLED.emitEvents);
    expect(resolved.sessionLine).toBe(VALUE_FEEDBACK_SUBFLAG_DEFAULTS_WHEN_ENABLED.sessionLine);
    expect(resolved.upstreamPrompt).toBe(
      VALUE_FEEDBACK_SUBFLAG_DEFAULTS_WHEN_ENABLED.upstreamPrompt,
    );
  });

  it("honours explicit sub-flags when enabled", () => {
    const root = makeRepo({
      policy: {
        valueFeedback: {
          enabled: true,
          emitEvents: false,
          sessionLine: true,
          upstreamPrompt: true,
        },
      },
    });
    const resolved = resolveValueFeedback(root);
    expect(resolved).toMatchObject({
      enabled: true,
      emitEvents: false,
      sessionLine: true,
      upstreamPrompt: true,
    });
  });
});

describe("resolveValueFeedback trusted-org auto-enable (#2376)", () => {
  it("auto-enables local emit + sessionLine for a deftai origin when the flag is absent", () => {
    const root = makeRepo({ policy: { wipCap: 10 } });
    const resolved = resolveValueFeedback(root, {
      autoEnable: { repoResolver: () => "deftai/statusreport" },
    });
    expect(resolved.source).toBe("org-auto");
    expect(resolved.enabled).toBe(true);
    expect(resolved.emitEvents).toBe(true);
    expect(resolved.sessionLine).toBe(true);
    expect(resolved.upstreamPrompt).toBe(false);
  });

  it("stays OFF for a non-trusted org", () => {
    const root = makeRepo({ policy: { wipCap: 10 } });
    const resolved = resolveValueFeedback(root, {
      autoEnable: { repoResolver: () => "someone-else/proj" },
    });
    expect(resolved.source).toBe("default");
    expect(resolved.enabled).toBe(false);
    expect(resolved.emitEvents).toBe(false);
  });

  it("stays OFF (fail-safe) when no origin remote resolves", () => {
    const root = makeRepo({ policy: { wipCap: 10 } });
    const resolved = resolveValueFeedback(root, {
      autoEnable: { repoResolver: () => null },
    });
    expect(resolved.source).toBe("default");
    expect(resolved.enabled).toBe(false);
  });

  it("an explicit typed enabled:false wins over trusted-org auto-enable", () => {
    const root = makeRepo({
      policy: { valueFeedback: { enabled: false, emitEvents: true } },
    });
    const resolved = resolveValueFeedback(root, {
      autoEnable: { repoResolver: () => "deftai/directive" },
    });
    expect(resolved.source).toBe("typed");
    expect(resolved.enabled).toBe(false);
    expect(resolved.emitEvents).toBe(false);
  });
});

describe("isValueFeedbackPathAllowed master gate", () => {
  it("rejects every path when enabled is false", () => {
    const policy = resolveValueFeedback(makeRepo());
    expect(isValueFeedbackPathAllowed("emitEvents", policy)).toBe(false);
    expect(isValueFeedbackPathAllowed("sessionLine", policy)).toBe(false);
    expect(isValueFeedbackPathAllowed("upstreamPrompt", policy)).toBe(false);
  });

  it("allows only configured sub-flags when enabled", () => {
    const policy = {
      enabled: true,
      emitEvents: true,
      sessionLine: false,
      upstreamPrompt: false,
      source: "typed" as const,
      error: null,
    };
    expect(isValueFeedbackPathAllowed("emitEvents", policy)).toBe(true);
    expect(isValueFeedbackPathAllowed("sessionLine", policy)).toBe(false);
    expect(isValueFeedbackPathAllowed("upstreamPrompt", policy)).toBe(false);
  });
});

describe("enableValueFeedback disclosure gate", () => {
  it("shows capability-cost disclosure and refuses without --confirm", () => {
    const root = makeRepo();
    const result = enableValueFeedback(root, { confirm: false });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(VALUE_FEEDBACK_CAPABILITY_COST_DISCLOSURE);
    expect(result.changed).toBe(false);
    const raw = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    );
    expect(raw).not.toBeNull();
    expect(typeof raw).toBe("object");
    const onDisk = raw as { plan: { policy?: { valueFeedback?: unknown } } };
    expect(onDisk.plan.policy?.valueFeedback).toBeUndefined();
  });

  it("persists typed policy only after confirm", () => {
    const root = makeRepo();
    const result = enableValueFeedback(root, { confirm: true, actor: "test" });
    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(true);
    const resolved = resolveValueFeedback(root);
    expect(resolved.enabled).toBe(true);
    expect(resolved.emitEvents).toBe(true);
    expect(resolved.sessionLine).toBe(true);
    expect(resolved.upstreamPrompt).toBe(false);
  });

  it("preserves existing sub-flags on idempotent re-enable", () => {
    const root = makeRepo({
      "x-directive/policy": {
        valueFeedback: {
          enabled: true,
          emitEvents: false,
          sessionLine: true,
          upstreamPrompt: false,
        },
      },
    });
    const result = enableValueFeedback(root, { confirm: true, actor: "test" });
    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.stdout).toContain("ledger unchanged");
    expect(existsSync(join(root, "meta", "policy-changes.log"))).toBe(false);
    expect(resolveValueFeedback(root)).toMatchObject({
      enabled: true,
      emitEvents: false,
      sessionLine: true,
      upstreamPrompt: false,
    });
  });

  it("preserves pre-configured sub-flags when enabling from disabled", () => {
    const root = makeRepo({
      policy: {
        valueFeedback: {
          enabled: false,
          emitEvents: false,
          sessionLine: false,
          upstreamPrompt: true,
        },
      },
    });
    const result = enableValueFeedback(root, { confirm: true, actor: "test" });
    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(true);
    expect(resolveValueFeedback(root)).toMatchObject({
      enabled: true,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: true,
    });
  });
});

describe("policy:show --field=valueFeedback reader", () => {
  it("returns resolved enabled state and every sub-flag via inspectOnePolicy", () => {
    const root = makeRepo({
      policy: {
        valueFeedback: {
          enabled: true,
          emitEvents: true,
          sessionLine: false,
          upstreamPrompt: false,
        },
      },
    });
    const field = inspectOnePolicy(FIELD_VALUE_FEEDBACK_CLI_ALIAS, root);
    expect(field).not.toBeNull();
    expect(field?.name).toBe(FIELD_VALUE_FEEDBACK);
    expect(field?.current).toEqual({
      enabled: true,
      emitEvents: true,
      sessionLine: false,
      upstreamPrompt: false,
    });
  });

  it("inspectValueFeedback surfaces framework defaults when unset", () => {
    const field = inspectValueFeedback(null);
    expect(field.current).toEqual({
      enabled: false,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
    });
    expect(field.source).toBe("default");
  });

  it("inspectValueFeedback mirrors org-auto so policy:show never lies for deftai repos (#2377)", () => {
    const data = { plan: { title: "T", status: "running", items: [], policy: { wipCap: 10 } } };
    const field = inspectValueFeedback(data, "/some/root", {
      autoEnable: { repoResolver: () => "deftai/statusreport" },
    });
    expect(field.source).toBe("org-auto");
    expect(field.current).toEqual({
      enabled: true,
      emitEvents: true,
      sessionLine: true,
      upstreamPrompt: false,
    });
  });

  it("inspectValueFeedback stays default for a non-trusted org with no explicit block (#2377)", () => {
    const data = { plan: { title: "T", status: "running", items: [], policy: { wipCap: 10 } } };
    const field = inspectValueFeedback(data, "/some/root", {
      autoEnable: { repoResolver: () => "someone-else/proj" },
    });
    expect(field.source).toBe("default");
    expect(field.current.enabled).toBe(false);
  });

  it("inspectValueFeedback: explicit typed enabled:false wins over org-auto (#2377)", () => {
    const data = {
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: { valueFeedback: { enabled: false } },
      },
    };
    const field = inspectValueFeedback(data, "/some/root", {
      autoEnable: { repoResolver: () => "deftai/directive" },
    });
    expect(field.source).toBe("typed");
    expect(field.current.enabled).toBe(false);
  });
});
