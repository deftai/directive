import { describe, expect, it } from "vitest";
import {
  RESOLUTION_ENCODINGS,
  RESOLUTION_MODES,
  RESOLUTION_PLAN_SCHEMA_VERSION,
  type ResolutionEncoding,
  type ResolutionMode,
  type ResolutionPlan,
} from "./resolution.js";

describe("resolution types contract (#2264)", () => {
  it("stamps a stable schema version", () => {
    expect(RESOLUTION_PLAN_SCHEMA_VERSION).toBe("resolution-plan/v1");
  });

  it("enumerates every resolution mode exactly once", () => {
    expect(RESOLUTION_MODES).toEqual([
      "proceed",
      "init",
      "migrate",
      "update",
      "install-global",
      "install-sandbox",
      "install-staged",
      "blocked",
    ]);
    expect(new Set(RESOLUTION_MODES).size).toBe(RESOLUTION_MODES.length);
  });

  it("enumerates the file encodings", () => {
    expect(RESOLUTION_ENCODINGS).toEqual(["utf-8", "base64"]);
  });

  it("modeled constants stay assignable to their exported types (compile-time guard)", () => {
    const mode: ResolutionMode = RESOLUTION_MODES[0] ?? "proceed";
    const encoding: ResolutionEncoding = RESOLUTION_ENCODINGS[0] ?? "utf-8";
    const example: ResolutionPlan = {
      schemaVersion: RESOLUTION_PLAN_SCHEMA_VERSION,
      mode,
      files: [{ path: "AGENTS.md", content: "x", encoding }],
      nextAction: { command: null, rootCause: "matched", remediation: "run the gate" },
      warnings: [],
    };
    expect(example.mode).toBe(mode);
    expect(example.files[0]?.encoding).toBe(encoding);
  });
});
