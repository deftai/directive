import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectOnePolicy, registeredPolicyNames } from "./index.js";
import {
  extractModulePathGlobs,
  FIELD_PROJECT_INVARIANTS,
  FIELD_PROJECT_INVARIANTS_CLI_ALIAS,
  inspectProjectInvariants,
  parseProjectInvariants,
  resolveProjectInvariants,
  resolveProjectInvariantsFromData,
} from "./project-invariants.js";

function writeProjectDef(root: string, policy: Record<string, unknown>): void {
  const dir = join(root, "xbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], policy },
    }),
    { encoding: "utf8" },
  );
}

describe("projectInvariants parse (#3425 Story A)", () => {
  it("treats absent and null as an empty valid list", () => {
    expect(parseProjectInvariants(undefined)).toEqual({ invariants: [], errors: [] });
    expect(parseProjectInvariants(null)).toEqual({ invariants: [], errors: [] });
    expect(parseProjectInvariants([])).toEqual({ invariants: [], errors: [] });
  });

  it("rejects a non-array", () => {
    const parsed = parseProjectInvariants({ id: "x" });
    expect(parsed.invariants).toEqual([]);
    expect(parsed.errors[0]).toMatch(/must be an array/);
  });

  it("requires id, statement, and a non-empty contract surface", () => {
    expect(parseProjectInvariants([{}]).errors.join(" ")).toMatch(/id is required/);
    expect(parseProjectInvariants([{ id: "a" }]).errors.join(" ")).toMatch(/statement is required/);
    expect(
      parseProjectInvariants([{ id: "a", statement: "keep loadable" }]).errors.join(" "),
    ).toMatch(/contract surface/);
  });

  it("parses paths and module ids from nested and shorthand forms", () => {
    const parsed = parseProjectInvariants([
      {
        id: "visage-load-save",
        statement: "Launch-prep must not make a project folder unloadable.",
        contractSurface: {
          paths: ["src/launch-prep/**"],
          moduleIds: ["project-io"],
        },
      },
      {
        id: "sibling-purpose",
        statement: "Existing modules stay independently useful.",
        contract_surface: ["packages/host/**"],
      },
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.invariants).toHaveLength(2);
    expect(parsed.invariants[0]).toEqual({
      id: "visage-load-save",
      statement: "Launch-prep must not make a project folder unloadable.",
      contractSurface: { paths: ["src/launch-prep/**"], moduleIds: ["project-io"] },
    });
    expect(parsed.invariants[1]?.contractSurface).toEqual({
      paths: ["packages/host/**"],
      moduleIds: [],
    });
  });

  it("rejects duplicate ids", () => {
    const parsed = parseProjectInvariants([
      { id: "dup", statement: "one", paths: ["a/**"] },
      { id: "dup", statement: "two", paths: ["b/**"] },
    ]);
    expect(parsed.errors.join(" ")).toMatch(/duplicate id 'dup'/);
    expect(parsed.invariants).toHaveLength(1);
  });

  it("rejects non-object entries and accepts Statement / path_globs aliases", () => {
    const parsed = parseProjectInvariants([
      "nope",
      {
        id: "aliased",
        Statement: "Keep host loadable.",
        contract: { path_globs: ["src/host/**"], module_ids: ["host"] },
      },
    ]);
    expect(parsed.errors.join(" ")).toMatch(/entry must be an object/);
    expect(parsed.invariants[0]).toMatchObject({
      id: "aliased",
      statement: "Keep host loadable.",
      contractSurface: { paths: ["src/host/**"], moduleIds: ["host"] },
    });
  });
});

describe("projectInvariants resolve + inspect", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function root(): string {
    const r = mkdtempSync(join(tmpdir(), "deft-proj-inv-"));
    roots.push(r);
    return r;
  }

  it("defaults to empty when the field is absent", () => {
    const r = root();
    writeProjectDef(r, {});
    const resolved = resolveProjectInvariants(r);
    expect(resolved.invariants).toEqual([]);
    expect(resolved.source).toBe("default");
    expect(resolved.error).toBeNull();
  });

  it("treats an authored empty list as typed", () => {
    const data = { plan: { policy: { projectInvariants: [] } } };
    const resolved = resolveProjectInvariantsFromData(data);
    expect(resolved.source).toBe("typed");
    expect(resolved.invariants).toEqual([]);
  });

  it("loads a valid list from PROJECT-DEFINITION", () => {
    const r = root();
    writeProjectDef(r, {
      projectInvariants: [
        {
          id: "host-load",
          statement: "Do not break host load.",
          paths: ["src/host/**"],
        },
      ],
    });
    const resolved = resolveProjectInvariants(r);
    expect(resolved.source).toBe("typed");
    expect(resolved.invariants).toHaveLength(1);
    expect(resolved.invariants[0]?.id).toBe("host-load");
  });

  it("resolves from in-memory data and inspects without a project root", () => {
    const data = {
      plan: {
        policy: {
          projectInvariants: [{ id: "a", statement: "s", paths: ["src/**"] }],
        },
      },
    };
    expect(resolveProjectInvariantsFromData(data).source).toBe("typed");
    expect(inspectProjectInvariants(data).source).toBe("typed");
    expect(inspectProjectInvariants(null).source).toBe("default");
    expect(resolveProjectInvariantsFromData(null).source).toBe("default");
  });

  it("fails closed to default-on-error for an invalid list", () => {
    const r = root();
    writeProjectDef(r, { projectInvariants: "nope" });
    const resolved = resolveProjectInvariants(r);
    expect(resolved.source).toBe("default-on-error");
    expect(resolved.invariants).toEqual([]);
    expect(resolved.error).toMatch(/must be an array/);
  });

  it("inspects via policy:show alias and canonical name", () => {
    const r = root();
    writeProjectDef(r, { projectInvariants: [] });
    expect(registeredPolicyNames()).toContain(FIELD_PROJECT_INVARIANTS);
    const field = inspectProjectInvariants(null, r);
    expect(field.name).toBe(FIELD_PROJECT_INVARIANTS);
    expect(field.current).toEqual([]);
    expect(field.source).toBe("typed");
    const byAlias = inspectOnePolicy(FIELD_PROJECT_INVARIANTS_CLI_ALIAS, r);
    const byCanonical = inspectOnePolicy(FIELD_PROJECT_INVARIANTS, r);
    expect(byAlias?.name).toBe(FIELD_PROJECT_INVARIANTS);
    expect(byCanonical?.source).toBe("typed");
  });
});

describe("extractModulePathGlobs", () => {
  it("maps codeStructure.modules id to pathGlobs", () => {
    const globs = extractModulePathGlobs({
      plan: {
        architecture: {
          codeStructure: {
            modules: [
              { id: "typescript-engine", pathGlobs: ["packages/**/*.ts"] },
              { id: "skip-me" },
            ],
          },
        },
      },
    });
    expect(globs["typescript-engine"]).toEqual(["packages/**/*.ts"]);
    expect(globs["skip-me"]).toBeUndefined();
  });

  it("returns {} for missing architecture", () => {
    expect(extractModulePathGlobs({})).toEqual({});
    expect(extractModulePathGlobs(null)).toEqual({});
  });
});
