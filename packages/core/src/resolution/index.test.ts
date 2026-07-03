import { describe, expect, it } from "vitest";
import * as resolution from "./index.js";

describe("resolution/index barrel (#2264)", () => {
  it("re-exports the classifier, plan, ladder, integrity, skew, and pin primitives", () => {
    expect(typeof resolution.classify).toBe("function");
    expect(typeof resolution.plan).toBe("function");
    expect(typeof resolution.decideEngineLadder).toBe("function");
    expect(typeof resolution.resolveEngine).toBe("function");
    expect(typeof resolution.checkLocalEngineIntegrity).toBe("function");
    expect(typeof resolution.evaluateSkew).toBe("function");
    expect(typeof resolution.readPin).toBe("function");
    expect(typeof resolution.reconcileVersions).toBe("function");
    expect(typeof resolution.defaultEngineProbe).toBe("function");
    expect(typeof resolution.localEnginePlatformDir).toBe("function");
  });

  it("re-exports the shared type-level constants", () => {
    expect(resolution.RESOLUTION_PLAN_SCHEMA_VERSION).toBe("resolution-plan/v1");
    expect(resolution.RESOLUTION_MODES).toContain("proceed");
    expect(resolution.RESOLUTION_ENCODINGS).toEqual(["utf-8", "base64"]);
    expect(resolution.LOCAL_ENGINE_ROOT).toBe(".deft/.cli");
    expect(resolution.DEFAULT_ENGINE_SKEW_WINDOW).toBe(3);
    expect(resolution.ACCEPT_ENGINE_SKEW_ENV).toBe("DEFT_ACCEPT_ENGINE_SKEW");
    expect(resolution.PIN_DEPENDENCY_NAME).toBe("@deftai/directive");
  });

  it("a consumer can drive an end-to-end decision through the barrel exports only", () => {
    const facts = resolution.classify("/nonexistent-proj-xyz", {
      isDir: () => false,
      isFile: () => false,
      readText: () => null,
      engineProbe: () => ({ reachable: false, version: null }),
      preCutoverProbe: () => false,
    });
    const p = resolution.plan(facts);
    expect(p.schemaVersion).toBe(resolution.RESOLUTION_PLAN_SCHEMA_VERSION);
    expect(p.mode).toBe("init");
  });
});
