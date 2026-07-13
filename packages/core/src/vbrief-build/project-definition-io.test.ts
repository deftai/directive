import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonJsonPretty } from "./json.js";
import {
  atomicWriteProjectDefinition,
  loadProjectDefinitionForMutation,
  projectDefinitionMutationLock,
  projectDefinitionPath,
} from "./project-definition-io.js";
import { ProjectDefinitionIOError } from "./types.js";

describe("projectDefinitionIO", () => {
  it("round-trips policy mutations under lock", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-"));
    const path = projectDefinitionPath(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    writeFileSync(
      path,
      pythonJsonPretty({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "running", policy: { wipCap: 10 }, items: [] },
      }),
      "utf8",
    );
    projectDefinitionMutationLock(root, () => {
      const [data, pdPath] = loadProjectDefinitionForMutation(root);
      (data.plan as Record<string, unknown>).policy = { wipCap: 12 };
      atomicWriteProjectDefinition(pdPath, data);
    });
    expect(existsSync(`${path}.lock`)).toBe(false);
    const roundtrip = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect((roundtrip.plan as Record<string, unknown>).policy).toEqual({ wipCap: 12 });
    rmSync(root, { recursive: true, force: true });
  });

  it("raises when project definition missing", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-miss-"));
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(ProjectDefinitionIOError);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves the xbrief path on a migrated tree, vbrief otherwise (#2302)", () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), "vb-pd-legacy-"));
    expect(
      projectDefinitionPath(legacyRoot).endsWith(`xbrief${sep}PROJECT-DEFINITION.xbrief.json`),
    ).toBe(true);
    rmSync(legacyRoot, { recursive: true, force: true });

    const migratedRoot = mkdtempSync(join(tmpdir(), "vb-pd-migrated-"));
    mkdirSync(join(migratedRoot, "xbrief", "active"), { recursive: true });
    writeFileSync(join(migratedRoot, "xbrief", "active", "some.xbrief.json"), "{}", "utf8");
    expect(
      projectDefinitionPath(migratedRoot).endsWith(`xbrief${sep}PROJECT-DEFINITION.xbrief.json`),
    ).toBe(true);
    rmSync(migratedRoot, { recursive: true, force: true });
  });

  it("names the resolved xbrief path in the not-found error on a migrated tree (#2302)", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-migrated-miss-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", "some.xbrief.json"), "{}", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(
      /xbrief[/\\]PROJECT-DEFINITION\.xbrief\.json/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("raises on invalid JSON and non-object payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-badjson-"));
    const path = projectDefinitionPath(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    writeFileSync(path, "not-json", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(/not valid JSON/);
    writeFileSync(path, "[]", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(/not a JSON object/);
    rmSync(root, { recursive: true, force: true });
  });
});
