import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESOLUTION_MODES,
  RESOLUTION_PLAN_SCHEMA_VERSION,
  type ResolutionFacts,
  type ResolutionPlan,
} from "@deftai/directive-types";
import { describe, expect, it } from "vitest";
import { decideEngineLadder, type LadderFacts } from "./engine-ladder.js";
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

function ladderFacts(overrides: Partial<LadderFacts> = {}): LadderFacts {
  return {
    pinVersion: "0.65.0",
    globalEngineVersion: null,
    localEngine: null,
    registryUp: true,
    globalPrefixWritable: true,
    stagedTarballAvailable: false,
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

  it("initialized-stale (content behind pin) -> update", () => {
    const p = plan(facts({ deftCorePayloadVersion: "0.63.0" }));
    expect(p.mode).toBe("update");
    expect(p.nextAction.command).toBe("npx @deftai/directive update");
  });

  it("legacy vbrief without xbrief adds a migrate:xbrief warning", () => {
    const p = plan(facts({ deftCorePayloadVersion: "0.63.0", hasVbrief: true, hasXbrief: false }));
    expect(p.warnings.join(" ")).toContain("migrate:xbrief");
  });

  it("warm sandbox (global absent, local intact >= pin) -> proceed", () => {
    const engineResolution = decideEngineLadder(
      ladderFacts({ localEngine: { version: "0.65.0", integrity: intact() } }),
    );
    const p = plan(
      facts({ engineReachable: false, engineVersion: null }),
      {},
      { engineResolution },
    );
    expect(p.mode).toBe("proceed");
  });

  it("cold sandbox (must install, prefix not writable) -> install-sandbox", () => {
    const engineResolution = decideEngineLadder(ladderFacts({ globalPrefixWritable: false }));
    const p = plan(
      facts({ engineReachable: false, engineVersion: null }),
      {},
      { engineResolution, platform: "linux" },
    );
    expect(p.mode).toBe("install-sandbox");
    expect(p.nextAction.command).toContain(".deft/.cli/linux");
    expect(p.warnings.join(" ")).toContain("ladder:");
  });

  it("registry-down with staged tarball -> install-staged", () => {
    const engineResolution = decideEngineLadder(
      ladderFacts({ registryUp: false, globalPrefixWritable: false, stagedTarballAvailable: true }),
    );
    const p = plan(
      facts({ engineReachable: false, engineVersion: null }),
      {},
      { engineResolution },
    );
    expect(p.mode).toBe("install-staged");
  });

  it("registry-down with no tarball -> blocked", () => {
    const engineResolution = decideEngineLadder(
      ladderFacts({ registryUp: false, stagedTarballAvailable: false }),
    );
    const p = plan(
      facts({ engineReachable: false, engineVersion: null }),
      {},
      { engineResolution },
    );
    expect(p.mode).toBe("blocked");
  });

  it("engine behind pin -> install-global", () => {
    const p = plan(facts({ engineVersion: "0.63.0" }));
    expect(p.mode).toBe("install-global");
    expect(p.nextAction.command).toContain("npm i -g @deftai/directive@0.65.0");
  });

  it("engine ahead within window -> update", () => {
    const p = plan(facts({ engineVersion: "0.67.0", deftCorePayloadVersion: "0.67.0" }), {
      engineSkewWindow: 3,
    });
    expect(p.mode).toBe("update");
  });

  it("engine ahead beyond window -> blocked (fail-closed)", () => {
    const p = plan(facts({ engineVersion: "0.80.0" }), { engineSkewWindow: 3 });
    expect(p.mode).toBe("blocked");
    expect(p.nextAction.command).toContain("--accept-engine-jump");
  });

  it("engine ahead beyond window with escape hatch -> update", () => {
    const p = plan(
      facts({ engineVersion: "0.80.0", deftCorePayloadVersion: "0.80.0" }),
      { engineSkewWindow: 3 },
      { acceptEngineJump: true },
    );
    expect(p.mode).toBe("update");
  });

  it("engine ahead beyond window, interactive -> blocked (prompt)", () => {
    const p = plan(
      facts({ engineVersion: "0.80.0" }),
      { engineSkewWindow: 3 },
      { interactive: true },
    );
    expect(p.mode).toBe("blocked");
    expect(p.nextAction.rootCause).toContain("interactive");
  });

  it("no reachable engine and no ladder resolution -> blocked", () => {
    const p = plan(facts({ engineReachable: false, engineVersion: null }));
    expect(p.mode).toBe("blocked");
    expect(p.nextAction.rootCause).toContain("no Directive engine is reachable");
  });

  it("no committed pin but engine reachable -> proceed with a warning", () => {
    const p = plan(facts({ pinVersion: null }));
    expect(p.mode).toBe("proceed");
    expect(p.warnings.join(" ")).toContain("no committed package.json pin");
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
    expect(consume(plan(facts({ deftCorePayloadVersion: "0.63.0" })))).toBe(
      "npx @deftai/directive update",
    );
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

  it("every resolution mode is reachable through the precedence table", () => {
    const observed = new Set<string>();
    observed.add(plan(facts()).mode); // proceed
    observed.add(plan(facts({ preCutoverArtifacts: true })).mode); // migrate
    observed.add(plan(facts({ hasDeftCore: false, hasManagedSection: false })).mode); // init
    observed.add(plan(facts({ deftCorePayloadVersion: "0.63.0" })).mode); // update
    observed.add(plan(facts({ engineVersion: "0.63.0" })).mode); // install-global
    observed.add(
      plan(
        facts({ engineReachable: false, engineVersion: null }),
        {},
        { engineResolution: decideEngineLadder(ladderFacts({ globalPrefixWritable: false })) },
      ).mode,
    ); // install-sandbox
    observed.add(
      plan(
        facts({ engineReachable: false, engineVersion: null }),
        {},
        {
          engineResolution: decideEngineLadder(
            ladderFacts({ registryUp: false, stagedTarballAvailable: true }),
          ),
        },
      ).mode,
    ); // install-staged
    observed.add(plan(facts({ engineVersion: "0.80.0" }), { engineSkewWindow: 3 }).mode); // blocked
    expect([...observed].sort()).toEqual([...RESOLUTION_MODES].sort());
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
