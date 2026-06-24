import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BRIDGE_SENTINEL, evaluateBridgeDrift, scanSurfaceForDrift } from "./bridge-drift.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

const SOT_REL = "sot.ts";
/** Minimal SoT module carrying the reader API + sentinel anchor. */
const SOT_STUB = [
  "// deft:last-go-installer anchor",
  "export const LAST_GO_INSTALLER = null;",
  "export function lastGoInstaller() { return LAST_GO_INSTALLER; }",
  "export function isFrozen() { return LAST_GO_INSTALLER !== null; }",
  "",
].join("\n");

function seedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-drift-"));
  temps.push(root);
  writeFileSync(join(root, SOT_REL), SOT_STUB);
  return root;
}

describe("scanSurfaceForDrift", () => {
  it("flags a marked line that hardcodes a semver", () => {
    const src = `the frozen tag is v0.32.5 ${BRIDGE_SENTINEL}\n`;
    const findings = scanSurfaceForDrift("UPGRADING.md", src);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(1);
  });
  it("does NOT flag a marked line that references the SoT (no number)", () => {
    const src = `read lastGoInstaller() -- ${BRIDGE_SENTINEL}\n`;
    expect(scanSurfaceForDrift("UPGRADING.md", src)).toHaveLength(0);
  });
  it("does NOT flag a hardcoded semver without the sentinel", () => {
    const src = "deft-install was historically v0.27.1 here\n";
    expect(scanSurfaceForDrift("docs/x.md", src)).toHaveLength(0);
  });
});

describe("evaluateBridgeDrift (three-state)", () => {
  it("passes clean when no surface hardcodes a marked version", () => {
    const root = seedRepo();
    writeFileSync(
      join(root, "UPGRADING.md"),
      `Use lastGoInstaller() for the bridge tag. ${BRIDGE_SENTINEL}\n`,
    );
    const res = evaluateBridgeDrift(root, { sotPath: SOT_REL, surfaces: ["UPGRADING.md"] });
    expect(res.code).toBe(0);
    expect(res.stream).toBe("stdout");
  });

  it("fails (exit 1) when a surface hardcodes a marked version", () => {
    const root = seedRepo();
    writeFileSync(
      join(root, "UPGRADING.md"),
      `The final Go installer is v0.32.5. ${BRIDGE_SENTINEL}\n`,
    );
    const res = evaluateBridgeDrift(root, { sotPath: SOT_REL, surfaces: ["UPGRADING.md"] });
    expect(res.code).toBe(1);
    expect(res.stream).toBe("stderr");
    expect(res.findings).toHaveLength(1);
  });

  it("skips absent surfaces (passes whether or not story P's surfaces exist)", () => {
    const root = seedRepo();
    const res = evaluateBridgeDrift(root, {
      sotPath: SOT_REL,
      surfaces: ["UPGRADING.md", "does/not/exist.md"],
    });
    expect(res.code).toBe(0);
  });

  it("never scans the SoT module itself even if registered", () => {
    const root = seedRepo();
    // Plant a sentinel+semver line into the SoT stub; it must be exempt.
    writeFileSync(join(root, SOT_REL), `${SOT_STUB}// v9.9.9 ${BRIDGE_SENTINEL}\n`);
    const res = evaluateBridgeDrift(root, { sotPath: SOT_REL, surfaces: [SOT_REL] });
    expect(res.code).toBe(0);
  });

  it("returns config error (exit 2) when the SoT module is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-drift-nosot-"));
    temps.push(root);
    const res = evaluateBridgeDrift(root, { sotPath: SOT_REL, surfaces: [] });
    expect(res.code).toBe(2);
    expect(res.stream).toBe("stderr");
  });

  it("returns config error (exit 2) when the SoT anchor/API is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-drift-noanchor-"));
    temps.push(root);
    writeFileSync(join(root, SOT_REL), "export const X = 1;\n");
    const res = evaluateBridgeDrift(root, { sotPath: SOT_REL, surfaces: [] });
    expect(res.code).toBe(2);
  });

  it("reports the frozen state in the clean message", () => {
    const root = seedRepo();
    const res = evaluateBridgeDrift(root, {
      sotPath: SOT_REL,
      surfaces: [],
      pinned: "v0.32.5",
    });
    expect(res.code).toBe(0);
    expect(res.message).toContain("v0.32.5");
  });
});
