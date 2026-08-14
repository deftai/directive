/**
 * Tests for production caller scan (#3362).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanProductionCallers } from "./scan-callers.js";

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

describe("scanProductionCallers (#3362)", () => {
  it("ignores the emitter module, tests, and comments", () => {
    const root = freshDir("tlm-scan-");
    writeProd(
      root,
      "packages/core/src/run-summary/emit.ts",
      "export class RunSummaryEmitter {\n  emitGhostKind() {}\n  emitSessionStart() {}\n}\n",
    );
    writeProd(
      root,
      "packages/core/src/run-summary/emit.test.ts",
      "emitter.emitSessionStart({ ready: true });\n",
    );
    writeProd(
      root,
      "packages/core/src/session/session-start.ts",
      "// emitter.emitSessionStart({ ready: true });\nconst x = 1;\n",
    );
    const scan = scanProductionCallers({
      projectRoot: root,
      kinds: ["session_start"],
    });
    expect(scan.callersByKind.session_start ?? []).toEqual([]);
    expect(scan.discoveredMethods).toContain("emitSessionStart");
    expect(scan.discoveredMethods).toContain("emitGhostKind");
  });

  it("counts a production typed emit and a generic emit kind literal", () => {
    const root = freshDir("tlm-hit-");
    writeProd(
      root,
      "packages/core/src/session/session-start.ts",
      "emitter.emitSessionStart({ ready: true });\n",
    );
    writeProd(
      root,
      "packages/core/src/check/cached-orchestrator.ts",
      'emitter.emit("check_invocation", payload);\n',
    );
    const scan = scanProductionCallers({
      projectRoot: root,
      kinds: ["session_start", "check_invocation"],
    });
    expect(scan.callersByKind.session_start?.length).toBeGreaterThan(0);
    expect(scan.callersByKind.check_invocation?.length).toBeGreaterThan(0);
  });

  it("skips missing scan roots without throwing", () => {
    const root = freshDir("tlm-missing-root-");
    const scan = scanProductionCallers({
      projectRoot: root,
      scanRoots: ["packages/core/src", "does-not-exist"],
      kinds: ["session_start"],
    });
    expect(scan.callersByKind.session_start).toEqual([]);
  });
});
