import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODE_STRUCTURE_VERSION,
  DIRECTIVE_HOME,
  validateFile,
} from "../../verify-source/code-structure-validate.js";
import { loadJson, readText, repoRoot } from "./_helpers.js";

describe("test_code_structure_profile.py", () => {
  it("test_schema_required_keys_match_pr2_profile", () => {
    const schema = loadJson("vbrief/schemas/vbrief-core.schema.json") as Record<string, unknown>;
    const codeStructureSchema = (schema.$defs as Record<string, unknown>).CodeStructure as Record<
      string,
      unknown
    >;
    expect((codeStructureSchema.properties as Record<string, unknown>).version).toMatchObject({
      const: CODE_STRUCTURE_VERSION,
      type: "string",
    });
    expect(codeStructureSchema.required).toEqual([
      "version",
      "modules",
      "pathOwnership",
      "allowedPatterns",
      "projectionManifest",
    ]);
    expect(codeStructureSchema.additionalProperties).toBe(true);
    expect(
      ((schema.$defs as Record<string, unknown>).Architecture as Record<string, unknown>)
        .properties,
    ).toMatchObject({ codeStructure: { $ref: "#/$defs/CodeStructure" } });
  });
  it("test_directive_dogfood_code_structure_validates", () => {
    const path = join(repoRoot(), "vbrief/PROJECT-DEFINITION.vbrief.json");
    const data = loadJson("vbrief/PROJECT-DEFINITION.vbrief.json") as Record<string, unknown>;
    expect((data.plan as Record<string, unknown>).architecture).toHaveProperty("codeStructure");
    const directiveTopLevel = DIRECTIVE_HOME.split(".")[0] ?? "";
    expect(Object.keys(data)).not.toContain(directiveTopLevel);
    const result = validateFile(path, { projectRoot: repoRoot(), allowStandalone: false });
    expect(result.ok).toBe(true);
  });
  it("test_codebase_task_is_registered", () => {
    const taskfile = readText("Taskfile.yml");
    const codebaseTasks = readText("tasks/codebase.yml");
    expect(taskfile).toContain("codebase:");
    expect(taskfile).toContain("tasks/codebase.yml");
    expect(codebaseTasks).toContain("validate-structure:");
    expect(codebaseTasks).toContain("extract-default:");
    expect(codebaseTasks).toContain("provider-map:");
    expect(codebaseTasks).toContain("projection-registry:");
    expect(codebaseTasks).toContain("packages/cli/dist/bin.js");
    expect(codebaseTasks).toContain("code-structure-validate");
  });
  it("test_profile_doc_names_physical_home_and_later_slices", () => {
    const doc = readText("docs/code-structure-profile.md");
    expect(doc).toContain("PROJECT-DEFINITION.vbrief.json");
    expect(doc).toContain("plan.architecture.codeStructure");
    expect(doc).toContain("vbrief-core.schema.json");
    expect(doc).toContain("No standalone canonical");
    expect(doc).toContain("vbrief/schemas/codebase-map.schema.json");
    expect(doc).toContain("tests/fixtures/codebase-map.v1.golden.json");
    expect(doc).toContain("normative contract");
    expect(doc).toContain("codebase-provider.v1");
    expect(doc).toContain("MAP rendering, generated headers");
  });
});
