/**
 * Tests for evaluateTelemetryCoverage (#3362).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateTelemetryCoverage, remediationFor } from "./evaluate.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeProd(root: string, rel: string, body: string): void {
  const full = join(root, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
}

describe("remediationFor (#3362)", () => {
  it("names the missing half", () => {
    expect(remediationFor("ghost", true, false)).toContain("no production caller");
    expect(remediationFor("ghost", true, false)).not.toContain("no field fixture");
    expect(remediationFor("ghost", false, true)).toContain("no field fixture");
    expect(remediationFor("ghost", false, true)).not.toContain("no production caller —");
    expect(remediationFor("ghost", true, true)).toContain(
      "no production caller / no field fixture",
    );
    expect(remediationFor("ghost", true, true)).toContain("wire it or remove it from the schema");
  });
});

describe("evaluateTelemetryCoverage (#3362)", () => {
  it("exits 2 when project root is missing", () => {
    const missing = join(tmpdir(), `tlm-missing-${Date.now()}`);
    const result = evaluateTelemetryCoverage({ projectRoot: missing });
    expect(result.code).toBe(2);
    expect(result.findings).toEqual([]);
    expect(result.stream).toBe("stderr");
  });

  it("is warn-only (exit 0) when a kind has no caller and no fixture", () => {
    const root = freshDir("tlm-open-");
    writeProd(root, "packages/core/src/ok/ok.ts", "export const n = 1;\n");
    const result = evaluateTelemetryCoverage({
      projectRoot: root,
      kinds: ["ghost"],
      enrolledKinds: [],
      skipTrial: true,
    });
    expect(result.code).toBe(0);
    expect(result.failOpen).toBe(true);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]?.remediation).toContain("no production caller / no field fixture");
    expect(result.message).toMatch(/warn-only|ADVISORY/i);
    expect(result.stream).toBe("stdout");
  });

  it("fails closed with exit 1 under --enforce", () => {
    const root = freshDir("tlm-enforce-");
    writeProd(
      root,
      "packages/core/src/session/session-start.ts",
      "emitter.emitSessionStart({ ready: true });\n",
    );
    const result = evaluateTelemetryCoverage({
      projectRoot: root,
      enforce: true,
      kinds: ["session_start", "ghost"],
      enrolledKinds: ["session_start"],
      skipTrial: true,
    });
    expect(result.code).toBe(1);
    expect(result.failOpen).toBe(false);
    expect(result.enforce).toBe(true);
    expect(result.findings.some((f) => f.subject === "ghost")).toBe(true);
    expect(result.message).toMatch(/FAIL: --enforce/);
    expect(result.stream).toBe("stderr");
  });

  it("flags a kind enrolled without a trial step as missing a fixture", () => {
    const root = freshDir("tlm-no-step-");
    writeProd(
      root,
      "packages/core/src/session/session-start.ts",
      "emitter.emitSessionStart({ ready: true });\n",
    );
    const result = evaluateTelemetryCoverage({
      projectRoot: root,
      enforce: true,
      kinds: ["session_start"],
      enrolledKinds: ["session_start"],
      trialKinds: [],
      skipTrial: true,
    });
    expect(result.code).toBe(1);
    expect(result.findings[0]?.missingFixture).toBe(true);
    expect(result.findings[0]?.remediation).toContain("no field fixture");
  });

  it("names only the missing fixture half when a caller exists", () => {
    const root = freshDir("tlm-fix-");
    writeProd(
      root,
      "packages/core/src/session/session-start.ts",
      "emitter.emitSessionStart({ ready: true });\n",
    );
    const result = evaluateTelemetryCoverage({
      projectRoot: root,
      enforce: true,
      kinds: ["session_start"],
      enrolledKinds: [],
      skipTrial: true,
    });
    expect(result.code).toBe(1);
    expect(result.findings[0]?.missingCaller).toBe(false);
    expect(result.findings[0]?.missingFixture).toBe(true);
    expect(result.findings[0]?.remediation).toContain("no field fixture");
    expect(result.findings[0]?.remediation).not.toContain("no production caller —");
  });

  it("is clean when every kind has a caller and a fixture", () => {
    const root = freshDir("tlm-clean-");
    writeProd(
      root,
      "packages/core/src/session/session-start.ts",
      "emitter.emitSessionStart({ ready: true });\n",
    );
    const result = evaluateTelemetryCoverage({
      projectRoot: root,
      enforce: true,
      kinds: ["session_start"],
      enrolledKinds: ["session_start"],
      skipTrial: true,
    });
    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.message).toMatch(/^OK:/);
  });

  it("flags an unmapped discovered emitter method with no caller", () => {
    const root = freshDir("tlm-method-");
    writeProd(
      root,
      "packages/core/src/run-summary/emit.ts",
      "export class RunSummaryEmitter {\n  emitGhostKind() {}\n}\n",
    );
    writeProd(root, "packages/core/src/ok/ok.ts", "export const n = 1;\n");
    const result = evaluateTelemetryCoverage({
      projectRoot: root,
      enforce: true,
      kinds: [],
      enrolledKinds: [],
      skipTrial: true,
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.subject === "emitGhostKind")).toBe(true);
  });

  it("is clean against this checkout (warn-only still holds if debt returns)", () => {
    const result = evaluateTelemetryCoverage({ projectRoot: process.cwd() });
    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.message).toMatch(/^OK:/);
  });

  it("flags a declared kind that the fake trial did not emit", () => {
    const root = freshDir("tlm-silent-step-");
    writeProd(
      root,
      "packages/core/src/session/session-start.ts",
      "emitter.emitSessionStart({ ready: true });\n",
    );
    const result = evaluateTelemetryCoverage({
      projectRoot: root,
      enforce: true,
      kinds: ["session_start"],
      enrolledKinds: ["session_start"],
      trialKinds: ["session_start"],
      trialResult: { presentKinds: [], stepOutcomes: [] },
    });
    expect(result.code).toBe(1);
    expect(result.findings[0]?.missingFixture).toBe(true);
    expect(result.findings[0]?.remediation).toContain("no field fixture");
  });

  it("flags a declared step that emitted a different kind", () => {
    const root = freshDir("tlm-wrong-step-");
    writeProd(
      root,
      "packages/core/src/session/session-start.ts",
      "emitter.emitSessionStart({ ready: true });\n",
    );
    const result = evaluateTelemetryCoverage({
      projectRoot: root,
      enforce: true,
      kinds: ["session_start"],
      enrolledKinds: ["session_start"],
      trialKinds: ["session_start"],
      trialResult: {
        presentKinds: ["session_start"],
        stepOutcomes: [{ declaredKind: "session_start", emittedKinds: ["check_invocation"] }],
      },
    });
    expect(result.code).toBe(1);
    expect(result.findings[0]?.missingFixture).toBe(true);
  });
});
