import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { disclosureLine } from "./disclosure.js";
import {
  FIELD_ALLOW_DIRECT_COMMITS,
  FIELD_MIN_GREPTILE_CONFIDENCE,
  FIELD_RUNTIME_AUTHORITY,
  FIELD_SESSION_RITUAL_STALENESS_HOURS,
  FIELD_WIP_CAP,
  inspectAllPolicies,
  inspectOnePolicy,
  pythonListRepr,
  pythonStringRepr,
  registeredPolicyNames,
  renderJson,
  renderText,
} from "./index.js";
import {
  coerceLegacyNarrative,
  ENV_BYPASS,
  type PolicyResult,
  resolvePolicy,
  setPolicy,
} from "./resolve.js";
import { countVbriefWip, DEFAULT_WIP_CAP, resolveWipCap } from "./wip.js";

function writeProjectDef(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "xbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], ...plan },
    }),
    { encoding: "utf8" },
  );
}

describe("resolvePolicy", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    delete process.env[ENV_BYPASS];
  });

  function root(): string {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-resolve-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(join(r, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    return r;
  }

  it("resolves typed true", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: true } });
    const result = resolvePolicy(r);
    expect(result.allowDirectCommits).toBe(true);
    expect(result.source).toBe("typed");
  });

  it("resolves typed false", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: false } });
    expect(resolvePolicy(r).source).toBe("typed");
  });

  it("fails closed on invalid typed value", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: "yes" } });
    const result = resolvePolicy(r);
    expect(result.allowDirectCommits).toBe(false);
    expect(result.source).toBe("default-fail-closed");
    expect(result.error).toContain("must be a boolean");
  });

  it("falls back to legacy narrative", () => {
    const r = root();
    writeProjectDef(r, { narratives: { "Allow direct commits to master": "true" } });
    const result = resolvePolicy(r);
    expect(result.allowDirectCommits).toBe(true);
    expect(result.source).toBe("legacy-narrative");
    expect(result.deprecationWarning).toContain("DEPRECATED");
  });

  it("defaults fail-closed when project def missing", () => {
    const r = root();
    const result = resolvePolicy(r);
    expect(result.allowDirectCommits).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("falls back to legacy narrative false", () => {
    const r = root();
    writeProjectDef(r, {
      narratives: { "Allow direct commits to master": "no, prefer feature branches" },
    });
    const result = resolvePolicy(r);
    expect(result.allowDirectCommits).toBe(false);
    expect(result.source).toBe("legacy-narrative");
  });

  it("honours env bypass over typed flag", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: false } });
    process.env[ENV_BYPASS] = "1";
    const result = resolvePolicy(r);
    expect(result.allowDirectCommits).toBe(true);
    expect(result.source).toBe("env-bypass");
  });

  it("honours env bypass truthy variants", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: false } });
    for (const val of ["true", "YES", "on"]) {
      process.env[ENV_BYPASS] = val;
      expect(resolvePolicy(r).source).toBe("env-bypass");
    }
  });

  it("defaults fail-closed with no error when policy absent", () => {
    const r = root();
    writeProjectDef(r, {});
    const result = resolvePolicy(r);
    expect(result.allowDirectCommits).toBe(false);
    expect(result.source).toBe("default-fail-closed");
    expect(result.error).toBeNull();
  });

  it("rejects non-object plan", () => {
    const r = root();
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: [] }),
      { encoding: "utf8" },
    );
    expect(resolvePolicy(r).error).toBe("PROJECT-DEFINITION 'plan' is not an object");
  });

  it("rejects env bypass when falsy", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: false } });
    process.env[ENV_BYPASS] = "0";
    expect(resolvePolicy(r).source).toBe("typed");
  });

  it("surfaces JSON parse errors", () => {
    const r = root();
    writeFileSync(join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "not-json", {
      encoding: "utf8",
    });
    expect(resolvePolicy(r).error).toContain("not valid JSON");
  });
});

describe("coerceLegacyNarrative", () => {
  it("parses inline colon form", () => {
    expect(coerceLegacyNarrative("Allow direct commits to master: true").allow).toBe(true);
  });

  it("rejects unrelated strings", () => {
    expect(coerceLegacyNarrative("no, prefer feature branches").allow).toBe(false);
  });

  it("accepts boolean values directly", () => {
    expect(coerceLegacyNarrative(true).allow).toBe(true);
  });

  it("coerces non-string legacy values via repr", () => {
    expect(coerceLegacyNarrative(1).allow).toBe(false);
  });
});

describe("disclosureLine", () => {
  const base: PolicyResult = {
    allowDirectCommits: false,
    source: "default-fail-closed",
    deprecationWarning: null,
    error: null,
  };

  it("matches enabled typed phrasing", () => {
    const line = disclosureLine({
      ...base,
      allowDirectCommits: true,
      source: "typed",
    });
    expect(line).toBe(
      "[deft policy] Direct commits to the default branch are ENABLED (source: typed). Branch-protection policy is OFF.",
    );
  });

  it("matches env bypass phrasing", () => {
    const line = disclosureLine({
      ...base,
      allowDirectCommits: true,
      source: "env-bypass",
    });
    expect(line).toContain(ENV_BYPASS);
  });

  it("surfaces fail-closed error", () => {
    const line = disclosureLine({
      ...base,
      error: "PROJECT-DEFINITION not found at /tmp/x",
    });
    expect(line).toContain("fail-closed");
    expect(line).toContain("not found");
  });
});

describe("setPolicy", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it("writes typed flag and audit log", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-set-"));
    roots.push(r);
    writeProjectDef(r, {});
    const { changed, auditEntry } = setPolicy(r, {
      allowDirectCommits: true,
      actor: "test",
      note: "unit",
    });
    expect(changed).toBe(true);
    expect(auditEntry).toContain("actor=test");
    expect(resolvePolicy(r).allowDirectCommits).toBe(true);
  });

  it("migrates legacy narrative on set", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-legacy-set-"));
    roots.push(r);
    writeProjectDef(r, { narratives: { "Allow direct commits to master": "true" } });
    setPolicy(r, { allowDirectCommits: true, actor: "t" });
    expect(resolvePolicy(r).source).toBe("typed");
  });

  it("throws when setPolicy plan is not object", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-badplan-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: [] }),
      { encoding: "utf8" },
    );
    expect(() => setPolicy(r, { allowDirectCommits: false })).toThrow("plan' is not an object");
  });

  it("throws when plan.policy is not object", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-badpolicy-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: [] } }),
      { encoding: "utf8" },
    );
    expect(() => setPolicy(r, { allowDirectCommits: false })).toThrow(
      "plan.policy is not an object",
    );
  });

  it("creates plan object when absent on set", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-no-plan-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", {
      encoding: "utf8",
    });
    setPolicy(r, { allowDirectCommits: false, actor: "t" });
    expect(resolvePolicy(r).source).toBe("typed");
  });
});

describe("wip cap", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it("defaults when missing", () => {
    // Framework default WIP cap is 20 (#2319, raised from 10).
    expect(DEFAULT_WIP_CAP).toBe(20);
    const r = mkdtempSync(join(tmpdir(), "deft-wip-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(join(r, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    expect(resolveWipCap(r).cap).toBe(DEFAULT_WIP_CAP);
    expect(resolveWipCap(r).source).toBe("default");
  });

  it("counts vbrief files in pending and active", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-wip-count-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(r, "xbrief", "active"), { recursive: true });
    writeFileSync(join(r, "xbrief", "pending", "a.xbrief.json"), "{}");
    writeFileSync(join(r, "xbrief", "active", "b.xbrief.json"), "{}");
    writeFileSync(join(r, "xbrief", "active", "readme.txt"), "x");
    expect(countVbriefWip(r)).toBe(2);
  });

  it("reads typed cap", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-wip-typed-"));
    roots.push(r);
    writeProjectDef(r, { policy: { wipCap: 2 } });
    expect(resolveWipCap(r)).toEqual({ cap: 2, source: "typed", error: null });
  });

  it("defaults when plan is not an object", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-wip-plan-bad-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: "nope" }),
      { encoding: "utf8" },
    );
    expect(resolveWipCap(r).error).toBe("PROJECT-DEFINITION 'plan' is not an object");
  });

  it("rejects string wipCap values", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-wip-str-"));
    roots.push(r);
    writeProjectDef(r, { policy: { wipCap: "5" as unknown as number } });
    expect(resolveWipCap(r).source).toBe("default-on-error");
  });

  it("defaults when PROJECT-DEFINITION missing for wip cap", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-wip-missing-pd-"));
    roots.push(r);
    expect(resolveWipCap(r).error).toContain("not found");
  });

  it("skips missing lifecycle folders", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-wip-nodirs-"));
    roots.push(r);
    expect(countVbriefWip(r)).toBe(0);
  });

  it("throws for legacy-only vbrief/ project (#2112)", () => {
    // Exercises the re-throw branch in countVbriefWip catch block: vbrief/ exists, no xbrief/.
    const r = mkdtempSync(join(tmpdir(), "deft-wip-legacy-"));
    roots.push(r);
    mkdirSync(join(r, "vbrief", "pending"), { recursive: true });
    expect(() => countVbriefWip(r)).toThrow("Run `deft migrate:xbrief`");
  });

  it("returns 0 when xbrief/ exists but has no .xbrief.json artifacts", () => {
    // Exercises the short-circuit branch in countVbriefWip catch block: xbrief/ dir exists
    // (resolveLifecycleRoot throws) but no vbrief/ -- result is 0, not a throw.
    const r = mkdtempSync(join(tmpdir(), "deft-wip-empty-xbrief-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief", "active"), { recursive: true });
    expect(countVbriefWip(r)).toBe(0);
  });

  it("rejects boolean wipCap values", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-wip-bool-"));
    roots.push(r);
    writeProjectDef(r, { policy: { wipCap: true as unknown as number } });
    expect(resolveWipCap(r).source).toBe("default-on-error");
  });

  it("rejects object wipCap values and reports the python 'dict' type name", () => {
    // Covers the pythonTypeName `typeof value === "object"` branch.
    const r = mkdtempSync(join(tmpdir(), "deft-wip-obj-"));
    roots.push(r);
    writeProjectDef(r, { policy: { wipCap: {} as unknown as number } });
    const result = resolveWipCap(r);
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain("dict");
  });
});

describe("inspectAllPolicies", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it("returns registered policy fields by default", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-"));
    roots.push(r);
    writeProjectDef(r, {});
    // deliveryBranch (#3041) + minGreptileConfidence (#3095) + hostSlashCommands (#3054)
    // + openClawProductCommands (#3064) + hostSkillDiscovery (#75) + triageLabelMirror (#1423)
    // + coverageDebt + checkResume (#3189).
    expect(inspectAllPolicies(r)).toHaveLength(24);
  });

  it("surfaces typed allowDirectCommits", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-"));
    roots.push(r);
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: true } });
    const row = inspectOnePolicy(FIELD_ALLOW_DIRECT_COMMITS, r);
    expect(row?.current).toBe(true);
    expect(row?.source).toBe("typed");
  });

  it("surfaces legacy allowDirectCommits", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-"));
    roots.push(r);
    writeProjectDef(r, { narratives: { "Allow direct commits to master": "true" } });
    const row = inspectOnePolicy(FIELD_ALLOW_DIRECT_COMMITS, r);
    expect(row?.source).toBe("legacy");
  });

  it("surfaces typed wipCap", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-"));
    roots.push(r);
    writeProjectDef(r, { policy: { wipCap: 3 } });
    const row = inspectOnePolicy(FIELD_WIP_CAP, r);
    expect(row?.current).toBe(3);
  });

  it("surfaces typed runtimeAuthority via CLI alias", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-"));
    roots.push(r);
    writeProjectDef(r, {
      policy: { runtimeAuthority: { enabled: true, denyPaths: [".env"] } },
    });
    const row = inspectOnePolicy("runtimeAuthority", r);
    expect(row?.name).toBe(FIELD_RUNTIME_AUTHORITY);
    expect(row?.current).toMatchObject({ enabled: true, denyPaths: [".env"] });
  });

  it("renderText handles empty changed-only", () => {
    expect(renderText([])).toContain("no fields changed");
  });

  it("renderJson includes generated_at", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-empty-"));
    roots.push(r);
    writeProjectDef(r, {});
    const json = renderJson(inspectAllPolicies(r), new Date("2026-01-01T00:00:00.000Z"));
    expect(json).toContain('"generated_at": "2026-01-01T00:00:00Z"');
  });

  it("registeredPolicyNames lists canonical paths", () => {
    expect(registeredPolicyNames()).toContain(FIELD_WIP_CAP);
    expect(registeredPolicyNames()).toContain(FIELD_RUNTIME_AUTHORITY);
    expect(registeredPolicyNames()).toContain("plan.policy.hostSkillDiscovery");
    expect(registeredPolicyNames()).toContain(FIELD_MIN_GREPTILE_CONFIDENCE);
  });

  it("python repr helpers match Python style", () => {
    expect(pythonStringRepr("x")).toBe("'x'");
    expect(pythonListRepr(["a", "b"])).toBe("['a', 'b']");
  });

  it("handles list policy fields and swarm backend states", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-rich-"));
    roots.push(r);
    writeProjectDef(r, {
      policy: {
        triageScope: [{ rule: "label", labels: ["bug"] }],
        triageHoldMarkers: [],
        swarmSubagentBackend: "not-valid",
        sessionRitualStalenessHours: 0,
        triageScopeIgnores: "bad",
      },
    });
    const fields = inspectAllPolicies(r);
    const hold = fields.find((f) => f.name.includes("triageHoldMarkers"));
    expect(hold?.source).toBe("typed");
    expect(hold?.current).toEqual([]);
    const backend = fields.find((f) => f.name.includes("swarmSubagentBackend"));
    expect(backend?.source).toBe("default-on-error");
    const ignores = fields.find((f) => f.name.includes("triageScopeIgnores"));
    expect(ignores?.source).toBe("default");
    const validBackend = inspectOnePolicy(
      "plan.policy.swarmSubagentBackend",
      (() => {
        const b = mkdtempSync(join(tmpdir(), "deft-inspect-backend-"));
        roots.push(b);
        writeProjectDef(b, { policy: { swarmSubagentBackend: "composer" } });
        return b;
      })(),
    );
    expect(validBackend?.source).toBe("typed");
  });

  it("treats empty triageScope as default source", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-empty-scope-"));
    roots.push(r);
    writeProjectDef(r, { policy: { triageScope: [] } });
    const row = inspectOnePolicy("plan.policy.triageScope", r);
    expect(row?.source).toBe("default");
  });

  it("treats null sessionRitualStalenessHours as default", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-null-session-"));
    roots.push(r);
    writeProjectDef(r, { policy: { sessionRitualStalenessHours: null } });
    const row = inspectOnePolicy(FIELD_SESSION_RITUAL_STALENESS_HOURS, r);
    expect(row?.source).toBe("default");
    expect(row?.current).toBe(4);
  });

  it("renders null policy values as None in text output", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-null-backend-"));
    roots.push(r);
    writeProjectDef(r, {});
    const text = renderText(inspectAllPolicies(r));
    expect(text).toContain("current: None");
  });

  it("returns null for unknown inspectOnePolicy field", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-inspect-unknown-"));
    roots.push(r);
    writeProjectDef(r, {});
    expect(inspectOnePolicy("plan.policy.nope", r)).toBeNull();
  });
});
