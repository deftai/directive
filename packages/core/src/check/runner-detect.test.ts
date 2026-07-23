import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectTestRunner } from "./runner-detect.js";

describe("runner-detect", () => {
  it("detects vitest from package.json heuristics", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-runner-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }),
      "utf8",
    );
    const result = detectTestRunner({ projectRoot: root });
    expect(result.kind).toBe("vitest");
    expect(result.affectedArgs).toEqual(["--changed"]);
    expect(result.source).toBe("heuristic");
  });

  it("honors explicit override", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-runner-"));
    const result = detectTestRunner({ projectRoot: root, override: "jest" });
    expect(result.kind).toBe("jest");
    expect(result.source).toBe("config");
  });

  it("honors plan.policy.testRunner = none", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-runner-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }),
      "utf8",
    );
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { testRunner: "none" } } }),
      "utf8",
    );
    const result = detectTestRunner({ projectRoot: root });
    expect(result.kind).toBe("none");
    expect(result.source).toBe("config");
    expect(result.affectedArgs).toEqual([]);
  });

  it("falls back to full-suite-only when nothing matches", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-runner-"));
    const result = detectTestRunner({ projectRoot: root });
    expect(result.kind).toBe("none");
    expect(result.source).toBe("fallback");
  });
});
