import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESOLUTION_MODES,
  RESOLUTION_PLAN_SCHEMA_VERSION,
  type ResolutionFacts,
  type ResolutionPlan,
} from "@deftai/directive-types";
import { describe, expect, it } from "vitest";
import { decideEngineAvailability, type EngineFacts } from "./engine-resolve.js";
import type { IntegrityResult } from "./integrity.js";
import { plan } from "./plan.js";

const SCHEMA_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "types",
  "schemas",
  "resolution-plan-v1.schema.json",
);

function loadSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

function facts(overrides: Partial<ResolutionFacts> = {}): ResolutionFacts {
  return {
    hasGit: true,
    hasAppCode: true,
    hasDeftCore: true,
    deftCorePayloadVersion: "0.65.0",
    hasManagedSection: true,
    managedSectionSha: "abc",
    hasVbrief: false,
    hasXbrief: true,
    preCutoverArtifacts: false,
    engineReachable: true,
    engineVersion: "0.65.0",
    pinVersion: "0.65.0",
    ...overrides,
  };
}

function intact(): IntegrityResult {
  return {
    usable: true,
    present: true,
    partial: false,
    platformDir: "/proj/.deft/.cli/linux",
    missingMarkers: [],
    reason: "intact",
  };
}

function engineFacts(overrides: Partial<EngineFacts> = {}): EngineFacts {
  return {
    pinVersion: "0.65.0",
    globalEngineVersion: null,
    localEngine: null,
    platform: "linux",
    ...overrides,
  };
}

describe("resolution/plan precedence table (#2264 a1)", () => {
  it("matched -> proceed", () => {
    const p = plan(facts());
    expect(p.mode).toBe("proceed");
    expect(p.nextAction.command).toBeNull();
    expect(p.schemaVersion).toBe(RESOLUTION_PLAN_SCHEMA_VERSION);
  });

  it("brownfield + pre-cutover -> migrate (highest precedence)", () => {
    const p = plan(facts({ preCutoverArtifacts: true, hasDeftCore: false }));
    expect(p.mode).toBe("migrate");
    expect(p.nextAction.rootCause).toContain("pre-v0.20");
  });

  it("greenfield without deposit -> init", () => {
    const p = plan(
      facts({ hasDeftCore: false, hasManagedSection: false, hasAppCode: false, hasGit: false }),
    );
    expect(p.mode).toBe("init");
    expect(p.nextAction.rootCause).toContain("greenfield");
    expect(p.nextAction.command).toBe("npx @deftai/directive init");
  });

  it("brownfield without deposit -> init", () => {
    const p = plan(facts({ hasDeftCore: false, hasManagedSection: false }));
    expect(p.mode).toBe("init");
    expect(p.nextAction.rootCause).toContain("brownfield");
  });

  it("managed section present but payload absent -> init (reconstitute)", () => {
    const p = plan(facts({ hasDeftCore: false, hasManagedSection: true }));
    expect(p.mode).toBe("init");
    expect(p.nextAction.rootCause).toContain("payload is absent");
  });

  it("linked worktree + managed section + missing payload -> local update (#4443)", () => {
    const p = plan(
      facts({ hasDeftCore: false, hasManagedSection: true }),
      {},
      {
        linkedWorktree: true,
      },
    );
    expect(p.mode).toBe("update");
    expect(p.nextAction.command).toBe("directive update");
    expect(p.nextAction.command).not.toMatch(/npx|dlx|init/);
    expect(p.nextAction.rootCause).toContain("linked worktree");
    expect(p.nextAction.remediation).toContain("directive update");
  });

  it("initialized-stale (content behind pin) -> update with AC9.7-safe remediation", () => {
    const p = plan(facts({ deftCorePayloadVersion: "0.63.0" }));
    expect(p.mode).toBe("update");
    expect(p.nextAction.command).toBeNull();
    expect(p.nextAction.remediation).toMatch(/directive upgrade|directive install --repair/);
    expect(p.nextAction.remediation).not.toMatch(/\bnpx\b|pnpm exec/);
  });

  it("legacy vbrief without xbrief adds a directive upgrade warning (F-017 / AC8.9)", () => {
    const p = plan(facts({ deftCorePayloadVersion: "0.63.0", hasVbrief: true, hasXbrief: false }));
    expect(p.warnings.join(" ")).toContain("directive upgrade");
    expect(p.warnings.join(" ")).not.toContain("migrate:xbrief");
  });

  it("warm sandbox (global absent, local intact >= pin) -> proceed", () => {
    const engineResolution = decideEngineAvailability(
      engineFacts({ localEngine: { version: "0.65.0", integrity: intact() } }),
    );
    const p = plan(
      facts({ engineReachable: false, engineVersion: null }),
      {},
      { engineResolution },
    );
    expect(p.mode).toBe("proceed");
  });

  it("engine unavailable (no global/local) -> blocked + AC9.7 (AC12.6)", () => {
    const engineResolution = decideEngineAvailability(engineFacts());
    const p = plan(
      facts({ engineReachable: false, engineVersion: null }),
      {},
      { engineResolution, platform: "linux" },
    );
    expect(p.mode).toBe("blocked");
    expect(p.nextAction.command).toBeNull();
    expect(p.nextAction.remediation).toContain("directive install --repair");
  });

  it("engine behind pin -> blocked + AC9.7 (no install-global)", () => {
    const p = plan(facts({ engineVersion: "0.63.0" }));
    expect(p.mode).toBe("blocked");
    expect(p.nextAction.command).toBeNull();
    expect(p.nextAction.remediation).toContain("directive install --repair");
    expect(p.nextAction.remediation).not.toMatch(/align-pin|install-global|npx/i);
  });

  it("engine ahead with content at engine -> blocked (AC12.6, no align-pin)", () => {
    const p = plan(facts({ engineVersion: "0.67.0", deftCorePayloadVersion: "0.67.0" }));
    expect(p.mode).toBe("blocked");
    expect(p.nextAction.command).toBeNull();
    expect(p.nextAction.remediation).toContain("directive install --repair");
  });

  it("engine ahead with content behind engine -> update without npx", () => {
    const p = plan(facts({ engineVersion: "0.67.0", deftCorePayloadVersion: "0.65.0" }));
    expect(p.mode).toBe("update");
    expect(p.nextAction.command).toBeNull();
    expect(p.nextAction.remediation).toMatch(/directive upgrade/);
  });

  it("engine ahead with null content -> update", () => {
    const p = plan(facts({ engineVersion: "0.67.0", deftCorePayloadVersion: null }));
    expect(p.mode).toBe("update");
  });

  it("engine far ahead with content behind -> update (no skew window / escape hatch)", () => {
    const p = plan(facts({ engineVersion: "0.80.0", deftCorePayloadVersion: "0.65.0" }));
    expect(p.mode).toBe("update");
    expect(p.nextAction.remediation).toMatch(/directive upgrade/);
    expect(p.nextAction.remediation).not.toMatch(/DEFT_ACCEPT_ENGINE_SKEW|accept-engine-jump/);
  });

  it("engine far ahead with content at engine -> blocked AC9.7 (no escape hatch)", () => {
    const p = plan(facts({ engineVersion: "0.80.0", deftCorePayloadVersion: "0.80.0" }));
    expect(p.mode).toBe("blocked");
    expect(p.nextAction.remediation).toContain("directive install --repair");
    expect(p.nextAction.remediation).not.toMatch(/DEFT_ACCEPT_ENGINE_SKEW|accept-engine-jump/);
  });

  it("no reachable engine and no resolution decision -> blocked", () => {
    const p = plan(facts({ engineReachable: false, engineVersion: null }));
    expect(p.mode).toBe("blocked");
    expect(p.nextAction.rootCause).toContain("no Directive engine is reachable");
  });

  it("no committed pin but engine reachable -> proceed with a warning", () => {
    const p = plan(facts({ pinVersion: null }));
    expect(p.mode).toBe("proceed");
    expect(p.nextAction.command).toBeNull();
    expect(p.warnings.join(" ")).toContain("no committed package.json pin");
    // #4429: missing-pin stays a proceed warning. error would change doctor
    // exit and retro-fail every pre-pin consumer.
  });

  it("deposit with managed section but null sha is treated as stale -> update", () => {
    const p = plan(facts({ managedSectionSha: null }));
    expect(p.mode).toBe("update");
  });
});

describe("resolution/plan is the single source of truth (#2264 a2)", () => {
  it("plan() is a pure function of its facts (deterministic)", () => {
    const f = facts({ deftCorePayloadVersion: "0.63.0" });
    expect(plan(f)).toEqual(plan(f));
  });

  it("a downstream consumer derives its decision from plan() output alone (no re-classify)", () => {
    // A mock doctor/headless consumer: it reads ONLY the ResolutionPlan, never
    // the fact-set, proving there is exactly one classifier in the system.
    function consume(p: ResolutionPlan): string {
      if (p.mode === "proceed") return "ready";
      return p.nextAction.command ?? `manual:${p.mode}`;
    }
    expect(consume(plan(facts()))).toBe("ready");
    expect(consume(plan(facts({ deftCorePayloadVersion: "0.63.0" })))).toBe("manual:update");
    expect(consume(plan(facts({ preCutoverArtifacts: true })))).toBe("manual:migrate");
  });

  it("plan() output validates against resolution-plan-v1.schema.json (lockstep)", () => {
    const schema = loadSchema();
    const p = plan(facts({ deftCorePayloadVersion: "0.63.0" }));
    expect(validateAgainstSchema(p, schema)).toEqual([]);
  });

  it("the schema enum + version const stay in lockstep with the TS contract", () => {
    const schema = loadSchema();
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    const modeEnum = (defs.ResolutionMode?.enum as string[]) ?? [];
    expect([...modeEnum].sort()).toEqual([...RESOLUTION_MODES].sort());
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.schemaVersion?.const).toBe(RESOLUTION_PLAN_SCHEMA_VERSION);
  });

  it("retired ladder modes are not emitted; remaining modes stay reachable (AC12.6)", () => {
    const observed = new Set<string>();
    observed.add(plan(facts()).mode); // proceed
    observed.add(plan(facts({ preCutoverArtifacts: true })).mode); // migrate
    observed.add(plan(facts({ hasDeftCore: false, hasManagedSection: false })).mode); // init
    observed.add(plan(facts({ deftCorePayloadVersion: "0.63.0" })).mode); // update
    observed.add(plan(facts({ engineVersion: "0.67.0", deftCorePayloadVersion: "0.67.0" })).mode);
    observed.add(plan(facts({ engineVersion: "0.63.0" })).mode);
    observed.add(
      plan(
        facts({ engineReachable: false, engineVersion: null }),
        {},
        { engineResolution: decideEngineAvailability(engineFacts()) },
      ).mode,
    );
    observed.add(
      plan(facts({ engineVersion: "0.80.0", deftCorePayloadVersion: "0.80.0" })).mode,
    ); // blocked
    for (const retired of ["align-pin", "install-global", "install-sandbox", "install-staged"]) {
      expect(observed.has(retired), retired).toBe(false);
    }
    expect(observed.has("proceed")).toBe(true);
    expect(observed.has("blocked")).toBe(true);
    expect(observed.has("update")).toBe(true);
    // Schema enum may still list retired modes for compat; product path must not emit them.
    expect(RESOLUTION_MODES).toEqual(expect.arrayContaining([...observed]));
  });
});

describe("resolution/plan files threading (#2268 headless single-sourcing)", () => {
  it("leaves files empty when no files option is supplied (keystone spine behavior)", () => {
    expect(plan(facts()).files).toEqual([]);
    expect(plan(facts({ hasDeftCore: false, hasManagedSection: false })).files).toEqual([]);
  });

  it("carries options.files into ResolutionPlan.files without altering the decision", () => {
    const files = [
      { path: ".deft/core/SKILL.md", content: "body", encoding: "utf-8" as const },
      { path: "AGENTS.md", content: "managed", encoding: "utf-8" as const },
    ];
    const bare = plan(facts({ hasDeftCore: false, hasManagedSection: false, hasAppCode: false }));
    const withFiles = plan(
      facts({ hasDeftCore: false, hasManagedSection: false, hasAppCode: false }),
      {},
      { files },
    );
    // The mode/next-action decision is identical; only files[] is populated.
    expect(withFiles.mode).toBe(bare.mode);
    expect(withFiles.nextAction).toEqual(bare.nextAction);
    expect(withFiles.files).toEqual(files);
  });

  it("a plan carrying files still validates against the v1 schema", () => {
    const schema = loadSchema();
    const p = plan(
      facts({ hasDeftCore: false, hasManagedSection: false }),
      {},
      { files: [{ path: "package.json", content: "{}", encoding: "utf-8" }] },
    );
    expect(validateAgainstSchema(p, schema)).toEqual([]);
  });
});

describe("resolution/plan package-manager rendering (#2197 / AC12.5–12.6)", () => {
  it("engine-behind pin never emits install-global command (npm or pnpm)", () => {
    const npmPlan = plan(facts({ engineVersion: "0.63.0" }));
    expect(npmPlan.mode).toBe("blocked");
    expect(npmPlan.nextAction.command).toBeNull();
    expect(npmPlan.nextAction.remediation).toContain("directive install --repair");

    const pnpmPlan = plan(facts({ engineVersion: "0.63.0" }), {}, { packageManager: "pnpm" });
    expect(pnpmPlan.mode).toBe("blocked");
    expect(pnpmPlan.nextAction.command).toBeNull();
  });

  it("update / former align-pin paths do not teach npx or pnpm dlx", () => {
    const updatePlan = plan(
      facts({ engineVersion: "0.67.0", deftCorePayloadVersion: "0.65.0" }),
      {},
      { packageManager: "pnpm" },
    );
    expect(updatePlan.mode).toBe("update");
    expect(updatePlan.nextAction.command).toBeNull();
    expect(updatePlan.nextAction.remediation).not.toMatch(/\bnpx\b|dlx/);

    const alignPlan = plan(
      facts({ engineVersion: "0.67.0", deftCorePayloadVersion: "0.67.0" }),
      {},
      { packageManager: "pnpm" },
    );
    expect(alignPlan.mode).toBe("blocked");
    expect(alignPlan.nextAction.command).toBeNull();
  });

  it("unavailable engine is blocked rather than npm --prefix install", () => {
    const engineResolution = decideEngineAvailability(engineFacts());
    const p = plan(
      facts({ engineReachable: false, engineVersion: null }),
      {},
      { engineResolution, platform: "linux", packageManager: "pnpm" },
    );
    expect(p.mode).toBe("blocked");
    expect(p.nextAction.command).toBeNull();
    expect(p.nextAction.remediation).toContain("directive install --repair");
  });
});

/** Minimal structural JSON-schema check (required + additionalProperties + enum). */
function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) return ["root is not an object"];
  const obj = value as Record<string, unknown>;
  const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
  const required = (schema.required as string[]) ?? [];
  for (const key of required) {
    if (!(key in obj)) errors.push(`missing required key: ${key}`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in props)) errors.push(`unexpected key: ${key}`);
    }
  }
  const defs = (schema.$defs as Record<string, Record<string, unknown>>) ?? {};
  const modeEnum = (defs.ResolutionMode?.enum as string[]) ?? [];
  if (typeof obj.mode === "string" && !modeEnum.includes(obj.mode)) {
    errors.push(`mode not in enum: ${obj.mode}`);
  }
  if (!Array.isArray(obj.files)) errors.push("files is not an array");
  const na = obj.nextAction as Record<string, unknown> | undefined;
  if (!na || typeof na !== "object") {
    errors.push("nextAction is not an object");
  } else {
    for (const key of ["command", "rootCause", "remediation"]) {
      if (!(key in na)) errors.push(`nextAction missing: ${key}`);
    }
  }
  if (!Array.isArray(obj.warnings)) errors.push("warnings is not an array");
  return errors;
}
