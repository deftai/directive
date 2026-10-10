/**
 * Runtime setup install|repair owner tests (Wave 2a / R8).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup, setupChangeCount } from "./setup.js";

const TEMPS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-2a-"));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("runSetup install|repair (R8 / AC8.*)", () => {
  it("install writes GENERATION, wiring-ready, AGENTS managed section, gitignore, seed", () => {
    const root = tempRoot();
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.stub).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(true);
    const gen = JSON.parse(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")) as {
      runtimeVersion: string;
      packageManager: string;
    };
    expect(gen.runtimeVersion).toBeTruthy();
    expect(["npm", "pnpm"]).toContain(gen.packageManager);
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${gen.runtimeVersion}.json`)),
    ).toBe(true);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/node_modules\/@deftai\/directive-runtime/);
    expect(agents).toMatch(/deft:managed-section/);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toMatch(/node_modules/);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toMatch(/wiring-ready/);
    expect(existsSync(join(root, "xbrief", ".directive-seed-placeholder"))).toBe(true);
    expect(result.created.length).toBeGreaterThan(0);
  });

  it("repair does not create seed placeholders (AC8.4)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    rmSync(join(root, "xbrief"), { recursive: true, force: true });
    const result = runSetup({ operation: "repair", from: "0.0.0", root });
    expect(existsSync(join(root, "xbrief", ".directive-seed-placeholder"))).toBe(false);
    expect(result.created.some((p) => p.includes("seed"))).toBe(false);
  });

  it("second repair is idempotent (AC6.9 / AC8.2)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const second = runSetup({ operation: "repair", from: "0.0.0", root });
    const third = runSetup({ operation: "repair", from: "0.0.0", root });
    expect(setupChangeCount(third)).toBe(0);
    // second may still settle; third must be empty
    expect(second.conflicts).toEqual([]);
    expect(third.created).toEqual([]);
    expect(third.modified).toEqual([]);
  });

  it("preserves existing xbrief bytes on repair (AC6.8)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const marker = join(root, "xbrief", "active", "user.xbrief.json");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(marker, '{"keep":true}\n');
    const before = readFileSync(marker, "utf8");
    runSetup({ operation: "repair", from: "0.0.0", root });
    expect(readFileSync(marker, "utf8")).toBe(before);
  });
});
