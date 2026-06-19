import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      path,
      pythonJsonPretty({
        vBRIEFInfo: { version: "0.6" },
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

  it("raises on invalid JSON and non-object payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-badjson-"));
    const path = projectDefinitionPath(root);
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(path, "not-json", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(/not valid JSON/);
    writeFileSync(path, "[]", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(/not a JSON object/);
    rmSync(root, { recursive: true, force: true });
  });
});
