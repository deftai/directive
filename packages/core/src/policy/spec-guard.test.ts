import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectOnePolicy } from "./index.js";
import {
  assertValidSpecGuardEnforcementPromote,
  FIELD_SPEC_GUARD,
  FIELD_SPEC_GUARD_CLI_ALIAS,
  inspectSpecGuard,
  promoteSpecGuardDriftEnforcement,
  readSpecImpact,
  resolveSpecGuard,
  resolveSpecGuardFromTypedBlock,
  runSqaPassNoop,
  SPEC_IMPACT_KEY,
  validateSpecGuard,
} from "./spec-guard.js";

describe("specGuard policy (#1589)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function writePd(policy: Record<string, unknown>) {
    root = mkdtempSync(join(tmpdir(), "spec-guard-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          status: "proposed",
          "x-directive/policy": policy,
        },
      }),
    );
    return root;
  }

  it("defaults to enabled advise when absent", () => {
    const resolved = resolveSpecGuardFromTypedBlock(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.driftGuard.enforcement).toBe("advise");
    expect(resolved.source).toBe("default");
    expect(resolved.baselineStatus).toBe("unknown");
  });

  it("self-heals malformed typed blocks (default-on-error)", () => {
    const resolved = resolveSpecGuardFromTypedBlock({ enabled: "yes" });
    expect(resolved.source).toBe("default-on-error");
    expect(resolved.enabled).toBe(true);
    expect(resolved.error).toContain("enabled must be a boolean");
  });

  it("validates sqaPass schema without running an engine", () => {
    expect(
      validateSpecGuard({
        enabled: true,
        driftGuard: { enforcement: "advise", trigger: "both" },
        sqaPass: { enforcement: "advise", sampling: "shape-changing", onFail: "escalate" },
      }),
    ).toEqual([]);
    expect(validateSpecGuard({ sqaPass: { sampling: "never" } })[0]).toContain("sampling");
    const noop = runSqaPassNoop(".");
    expect(noop.status).toBe("noop");
  });

  it("resolves from PROJECT-DEFINITION via readPlanPolicy", () => {
    writePd({
      specGuard: {
        enabled: true,
        driftGuard: { enforcement: "advise", trigger: "scope-complete" },
        sqaPass: { enforcement: "advise", sampling: "all", onFail: "advise" },
      },
    });
    const resolved = resolveSpecGuard(root, { hasSpecification: true });
    expect(resolved.source).toBe("typed");
    expect(resolved.driftGuard.trigger).toBe("scope-complete");
    expect(resolved.sqaPass.sampling).toBe("all");
    expect(resolved.baselineStatus).toBe("present");
  });

  it("inspects via policy:show alias", () => {
    writePd({ specGuard: { enabled: false } });
    const field = inspectSpecGuard(null, root);
    expect(field.name).toBe(FIELD_SPEC_GUARD);
    expect(field.current.enabled).toBe(false);
    expect(FIELD_SPEC_GUARD_CLI_ALIAS).toBe("specGuard");
    const byAlias = inspectOnePolicy(FIELD_SPEC_GUARD_CLI_ALIAS, root);
    expect(byAlias?.name).toBe(FIELD_SPEC_GUARD);
  });

  it("reads namespaced specImpact on plan items", () => {
    expect(readSpecImpact({ [SPEC_IMPACT_KEY]: "delta" })).toBe("delta");
    expect(readSpecImpact({ [SPEC_IMPACT_KEY]: "bogus" })).toBeNull();
    expect(readSpecImpact({ specImpact: "delta" })).toBeNull();
  });

  it("accepts shadow in the enforcement closed set", () => {
    expect(validateSpecGuard({ driftGuard: { enforcement: "shadow" } })).toEqual([]);
    const resolved = resolveSpecGuardFromTypedBlock({
      driftGuard: { enforcement: "shadow", trigger: "both" },
    });
    expect(resolved.driftGuard.enforcement).toBe("shadow");
  });

  it("refuses advise→enforce promote without shadow attestation (S1)", () => {
    const gate = assertValidSpecGuardEnforcementPromote("advise", "enforce");
    expect(gate.ok).toBe(false);
    const withAttest = assertValidSpecGuardEnforcementPromote("advise", "enforce", {
      hasShadowAttestation: true,
    });
    expect(withAttest.ok).toBe(true);
    expect(assertValidSpecGuardEnforcementPromote("advise", "shadow").ok).toBe(true);
    expect(assertValidSpecGuardEnforcementPromote("shadow", "enforce").ok).toBe(true);
  });

  it("promotes advise→shadow with --confirm and records attestation", () => {
    writePd({ specGuard: { enabled: true, driftGuard: { enforcement: "advise" } } });
    const denied = promoteSpecGuardDriftEnforcement(root, { to: "shadow", confirm: false });
    expect(denied.exitCode).toBe(1);
    const ok = promoteSpecGuardDriftEnforcement(root, {
      to: "shadow",
      confirm: true,
      actor: "test",
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.changed).toBe(true);
    expect(resolveSpecGuard(root).driftGuard.enforcement).toBe("shadow");
    const toEnforce = promoteSpecGuardDriftEnforcement(root, {
      to: "enforce",
      confirm: true,
      actor: "test",
    });
    expect(toEnforce.exitCode).toBe(0);
    expect(resolveSpecGuard(root).driftGuard.enforcement).toBe("enforce");
  });

  it("refuses one-shot advise→enforce write without attestation", () => {
    writePd({ specGuard: { enabled: true, driftGuard: { enforcement: "advise" } } });
    const result = promoteSpecGuardDriftEnforcement(root, {
      to: "enforce",
      confirm: true,
      actor: "test",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toMatch(/advise→enforce skip/i);
    expect(resolveSpecGuard(root).driftGuard.enforcement).toBe("advise");
  });
});
