import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runDeftTs } from "./deft-ts-runner.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("deft-ts codebase-projection-registry", () => {
  it("lists registered kinds as JSON on stdout", () => {
    const result = runDeftTs("codebase-projection-registry", ["--list"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { kind: string }[];
    expect(payload[0]?.kind).toBe("codebase-map");
  });

  it("prefers --list over --kind", () => {
    const result = runDeftTs("codebase-projection-registry", ["--list", "--kind", "codebase-map"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as unknown[];
    expect(Array.isArray(payload)).toBe(true);
  });

  it("exits 1 for unknown projection kind", () => {
    const result = runDeftTs("codebase-projection-registry", ["--kind", "unknown-map"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown projection kind");
  });
});

describe("deft-ts codebase-default-extractor", () => {
  it("emits a codebase-map artifact for a minimal tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-extract-"));
    temps.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.py"), "print('hello')\n", "utf8");
    const result = runDeftTs("codebase-default-extractor", ["--project-root", root]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { kind: string; modules: unknown[] };
    expect(payload.kind).toBe("codebase-map");
    expect(payload.modules.length).toBeGreaterThan(0);
  });

  it("emits degraded artifact when project root has no sources", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-extract-empty-"));
    temps.push(root);
    mkdirSync(join(root, "vbrief"), { recursive: true });
    const result = runDeftTs("codebase-default-extractor", ["--project-root", root]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { degraded: unknown[]; modules: unknown[] };
    expect(payload.modules).toEqual([]);
    expect(payload.degraded.length).toBeGreaterThan(0);
  });
});

describe("deft-ts codebase-provider", () => {
  it("exits 2 when PROJECT-DEFINITION is invalid JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-provider-"));
    temps.push(root);
    const vbriefPath = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(vbriefPath, "{not-json", "utf8");
    const result = runDeftTs("codebase-provider", ["--project-root", root]);
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stderr) as { ok: boolean; errors: { code: string }[] };
    expect(payload.ok).toBe(false);
    expect(payload.errors[0]?.code).toBe("CS-CONFIG");
  });
});
