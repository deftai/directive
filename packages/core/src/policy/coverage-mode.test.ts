import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIELD_COVERAGE_MODE,
  FIELD_COVERAGE_MODE_CLI_ALIAS,
  resolveCoverageMode,
  setCoverageMode,
} from "./coverage-mode.js";
import { inspectOnePolicy, registeredPolicyNames } from "./index.js";

function writeProjectDef(root: string, policy: Record<string, unknown> | null, raw?: string): void {
  const dir = join(root, "xbrief");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "PROJECT-DEFINITION.xbrief.json");
  if (raw !== undefined) {
    writeFileSync(path, raw);
    return;
  }
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], "x-directive/policy": policy ?? {} },
    }),
  );
}

describe("coverageMode (#5791)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  function root(): string {
    const r = mkdtempSync(join(tmpdir(), "deft-coverage-mode-"));
    roots.push(r);
    return r;
  }

  it("missing PROJECT-DEFINITION resolves to initial", () => {
    const r = root();
    const resolved = resolveCoverageMode(r);
    expect(resolved.mode).toBe("initial");
    expect(resolved.source).toBe("default");
  });

  it("invalid JSON PROJECT-DEFINITION resolves to full (never initial)", () => {
    const r = root();
    writeProjectDef(r, null, "{not-json");
    const resolved = resolveCoverageMode(r);
    expect(resolved.mode).toBe("full");
    expect(resolved.source).toBe("default-on-error");
    expect(resolved.error).toMatch(/not valid JSON/i);
  });

  it("inspectOnePolicy accepts coverageMode alias", () => {
    const r = root();
    writeProjectDef(r, { coverageMode: "disabled" });
    expect(registeredPolicyNames()).toContain(FIELD_COVERAGE_MODE);
    const byAlias = inspectOnePolicy(FIELD_COVERAGE_MODE_CLI_ALIAS, r);
    const byCanonical = inspectOnePolicy(FIELD_COVERAGE_MODE, r);
    expect(byAlias?.name).toBe(FIELD_COVERAGE_MODE);
    expect(byAlias?.current).toBe("disabled");
    expect(byCanonical?.current).toBe("disabled");
  });

  it("setCoverageMode requires confirm and writes typed mode", () => {
    const r = root();
    writeProjectDef(r, {});
    const denied = setCoverageMode(r, { mode: "full" });
    expect(denied.exitCode).toBe(1);
    expect(denied.changed).toBe(false);
    const applied = setCoverageMode(r, { mode: "full", confirm: true });
    expect(applied.exitCode).toBe(0);
    expect(applied.changed).toBe(true);
    expect(resolveCoverageMode(r).mode).toBe("full");
  });

  it("setCoverageMode is importable from policy index barrel (#5791)", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.setCoverageMode).toBe("function");
    expect(mod.FIELD_COVERAGE_MODE_CLI_ALIAS).toBe("coverageMode");
  });
});