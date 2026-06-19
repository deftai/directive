import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_STRUCTURE_VERSION,
  discoverCodeStructurePaths,
  evaluateCodeStructure,
  extractCodeStructureHomes,
  loadJsonFile,
  validateCodeStructure,
  validateFile,
} from "./code-structure-validate.js";
import { scanPythonGhCalls } from "./python-call-scan.js";
import { evaluateRuleOwnership, lintRules, loadMap } from "./rule-ownership-lint.js";
import { evaluateScmBoundary } from "./scm-boundary.js";
import { evaluateVerifyStubs } from "./verify-stubs.js";

describe("verify-source coverage boost", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("code structure flags module shape and ownership conflicts", () => {
    const record = {
      version: CODE_STRUCTURE_VERSION,
      modules: [
        { id: "bad", name: "", purpose: "", pathGlobs: ["../escape"] },
        {
          id: "a",
          name: "A",
          purpose: "p",
          pathGlobs: ["src/*.py", "src/*.py"],
        },
        {
          id: "b",
          name: "B",
          purpose: "p",
          pathGlobs: ["src/*.py"],
        },
      ],
      pathOwnership: [{ pathGlob: "src/*.py", module: "missing" }],
      allowedPatterns: [
        { id: "dup", name: "n", description: "d", module: "a" },
        { id: "dup", name: "n2", description: "d2", module: "a", appliesTo: ["/abs"] },
      ],
      projectionManifest: [
        {
          path: "out.md",
          kind: "map",
          source: "wrong.home",
          generated: false,
          task: "t",
        },
      ],
      filePurposeOverrides: [{ path: "x", purpose: "", module: "nope" }],
      glossaryRefs: [{ term: "", uri: "missing.md" }],
      imports: ["secret"],
    };
    const result = validateCodeStructure(record, "mem", root ?? ".");
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(5);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("validateFile handles home conflict and standalone paths", () => {
    root = mkdtempSync(join(tmpdir(), "cs-boost-"));
    const path = join(root, "x.vbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          architecture: {
            codeStructure: {
              version: CODE_STRUCTURE_VERSION,
              modules: [{ id: "a", name: "A", purpose: "p", pathGlobs: ["a.md"] }],
              pathOwnership: [],
              allowedPatterns: [],
              projectionManifest: [],
            },
          },
        },
        "x-directive/architecture": {
          codeStructure: {
            version: CODE_STRUCTURE_VERSION,
            modules: [{ id: "b", name: "B", purpose: "p", pathGlobs: ["b.md"] }],
            pathOwnership: [],
            allowedPatterns: [],
            projectionManifest: [],
          },
        },
      }),
      "utf8",
    );
    const result = validateFile(path, { projectRoot: root, allowStandalone: false });
    expect(result.errors.some((e) => e.code === "CS-HOME-CONFLICT")).toBe(true);
  });

  it("discoverCodeStructurePaths finds sibling vbrief files", () => {
    root = mkdtempSync(join(tmpdir(), "cs-disc-"));
    const vbrief = join(root, "vbrief", "active");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "story.vbrief.json"),
      JSON.stringify({
        plan: {
          architecture: {
            codeStructure: {
              version: CODE_STRUCTURE_VERSION,
              modules: [{ id: "a", name: "A", purpose: "p", pathGlobs: ["x.md"] }],
              pathOwnership: [],
              allowedPatterns: [],
              projectionManifest: [],
            },
          },
        },
      }),
      "utf8",
    );
    const paths = discoverCodeStructurePaths(root);
    expect(paths.some((p) => p.endsWith("story.vbrief.json"))).toBe(true);
  });

  it("evaluateCodeStructure supports json and strict modes", () => {
    root = mkdtempSync(join(tmpdir(), "cs-json-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        plan: {
          architecture: {
            codeStructure: {
              version: CODE_STRUCTURE_VERSION,
              modules: [
                {
                  id: "solo",
                  name: "Solo",
                  purpose: "one file module",
                  pathGlobs: ["README.md"],
                },
              ],
              pathOwnership: [],
              allowedPatterns: [],
              projectionManifest: [],
              filePurposeOverrides: Array.from({ length: 30 }, (_, i) => ({
                path: `f${i}.md`,
                purpose: `p${i}`,
              })),
            },
          },
        },
      }),
      "utf8",
    );
    const json = evaluateCodeStructure(root, { json: true, strict: true });
    expect(json.stdout).toContain('"validated"');
    expect(json.code).toBe(1);
  });

  it("loadJsonFile throws on missing and invalid object", () => {
    root = mkdtempSync(join(tmpdir(), "cs-load-"));
    expect(() => loadJsonFile(join(root, "nope.json"))).toThrow(/not found/);
    const bad = join(root, "arr.json");
    writeFileSync(bad, "[]", "utf8");
    expect(() => loadJsonFile(bad)).toThrow(/must be an object/);
  });

  it("extractCodeStructureHomes reads both homes", () => {
    const data = {
      plan: { architecture: { codeStructure: { version: CODE_STRUCTURE_VERSION } } },
      "x-directive/architecture": { codeStructure: { version: CODE_STRUCTURE_VERSION } },
    };
    expect(extractCodeStructureHomes(data)).toHaveLength(2);
  });

  it("rule ownership lint surfaces text and read drift", () => {
    root = mkdtempSync(join(tmpdir(), "rom-boost-"));
    writeFileSync(join(root, "owner.md"), "## S\n\nother text\n", "utf8");
    const mapPath = join(root, "map.json");
    writeFileSync(
      mapPath,
      JSON.stringify({
        rules: [
          {
            id: "r1",
            text: "expected",
            owner_file: "owner.md",
            owner_section: "## S",
            authority: "MUST",
            last_verified: "d",
          },
          {
            id: "r2",
            text: "t",
            owner_file: "gone.md",
            owner_section: "## S",
            authority: "lesson",
            last_verified: "d",
          },
        ],
      }),
      "utf8",
    );
    const payload = loadMap(mapPath);
    const diags = lintRules(payload, root);
    expect(diags.length).toBeGreaterThanOrEqual(2);
    const result = evaluateRuleOwnership(root, { mapPath, root });
    expect(result.code).toBe(1);
  });

  it("python call scan covers subprocess variants and Popen", () => {
    const source = `from subprocess import Popen
import subprocess
import os
def run():
    subprocess.check_output(["gh", "api"])
    subprocess.check_call(["ghx", "x"])
    subprocess.call("gh pr list", shell=True)
    Popen(["gh", "l"])
    os.system("ghx issue list")
`;
    const sites = scanPythonGhCalls(source);
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it("scm boundary rejects allow-list directories as unreadable", () => {
    root = mkdtempSync(join(tmpdir(), "scm-read-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    const allowDir = join(root, "allow-dir");
    mkdirSync(allowDir, { recursive: true });
    const result = evaluateScmBoundary(root, { allowListPath: allowDir });
    expect(result.code).toBe(2);
    expect(result.message).toContain("unreadable");
  });

  it("verify-stubs truncates output after fifty findings", () => {
    root = mkdtempSync(join(tmpdir(), "stub-many-"));
    mkdirSync(join(root, "pkg"), { recursive: true });
    const lines = Array.from({ length: 60 }, (_, i) => `# TODO ${i}`).join("\n");
    writeFileSync(join(root, "pkg", "many.py"), lines, "utf8");
    const result = evaluateVerifyStubs(root);
    expect(result.code).toBe(1);
    expect(result.message).toContain("... and 10 more");
  });

  it("code structure validates projection banner on existing paths", () => {
    root = mkdtempSync(join(tmpdir(), "cs-proj-"));
    const out = join(root, "out", "MAP.md");
    mkdirSync(join(root, "out"), { recursive: true });
    writeFileSync(out, "# manual map\n", "utf8");
    const record = {
      version: CODE_STRUCTURE_VERSION,
      modules: [{ id: "a", name: "A", purpose: "p", pathGlobs: ["src/**"] }],
      pathOwnership: [],
      allowedPatterns: [],
      projectionManifest: [
        {
          path: "out/MAP.md",
          kind: "map",
          source: "plan.architecture.codeStructure",
          generated: true,
        },
      ],
    };
    const result = validateCodeStructure(record, "mem", root);
    expect(result.errors.some((e) => e.code === "CS-PROJECTION-BANNER")).toBe(true);
  });

  it("code structure handles duplicate module ids and glossary without uri", () => {
    const record = {
      version: CODE_STRUCTURE_VERSION,
      modules: [
        { id: "dup", name: "A", purpose: "p", pathGlobs: ["a.md"] },
        { id: "dup", name: "B", purpose: "p", pathGlobs: ["b.md"] },
      ],
      pathOwnership: [],
      allowedPatterns: [],
      projectionManifest: [],
      glossaryRefs: [{ term: "T" }],
      filePurposeOverrides: null,
    };
    const result = validateCodeStructure(record, "mem");
    expect(result.errors.some((e) => e.code === "CS-MODULE-ID")).toBe(true);
  });

  it("python call scan handles empty argv edge cases", () => {
    expect(scanPythonGhCalls("subprocess.run([])\n")).toHaveLength(0);
    expect(scanPythonGhCalls("subprocess.run()\n")).toHaveLength(0);
  });

  it("rule ownership loadMap rejects duplicate ids and malformed rules", () => {
    root = mkdtempSync(join(tmpdir(), "rom-schema-"));
    const mapPath = join(root, "map.json");
    writeFileSync(
      mapPath,
      JSON.stringify({
        rules: [
          {
            id: "a",
            text: "t",
            owner_file: "f",
            owner_section: "## S",
            authority: "MUST",
            last_verified: "d",
          },
          {
            id: "a",
            text: "t2",
            owner_file: "f",
            owner_section: "## S",
            authority: "MUST",
            last_verified: "d",
          },
        ],
      }),
      "utf8",
    );
    expect(() => loadMap(mapPath)).toThrow(/Duplicate ROM rule id/);
  });

  it("evaluateCodeStructure emits FAIL lines for invalid explicit path", () => {
    root = mkdtempSync(join(tmpdir(), "cs-fail-"));
    const path = join(root, "bad.vbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          architecture: {
            codeStructure: {
              version: "wrong",
              modules: [],
              pathOwnership: [],
              allowedPatterns: [],
              projectionManifest: [],
            },
          },
        },
      }),
      "utf8",
    );
    const result = evaluateCodeStructure(root, { paths: [path] });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL:");
  });

  it("scm boundary quiet suppresses clean message", () => {
    root = mkdtempSync(join(tmpdir(), "scm-quiet-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    const result = evaluateScmBoundary(root, { quiet: true });
    expect(result.code).toBe(0);
    expect(result.message).toBe("");
  });

  it("verify-stubs scans shell scripts and skips non-matching extensions", () => {
    root = mkdtempSync(join(tmpdir(), "stub-ext-"));
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "run.sh"), "# HACK workaround\n", "utf8");
    writeFileSync(join(root, "bin", "notes.txt"), "TODO\n", "utf8");
    const result = evaluateVerifyStubs(root);
    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.label).toBe("HACK");
  });

  it("code structure boundedness warns on large pathOwnership", () => {
    const modules = [{ id: "a", name: "A", purpose: "p", pathGlobs: ["src/**"] }];
    const ownership = Array.from({ length: 20 }, (_, i) => ({
      pathGlob: `p${i}/**`,
      module: "a",
    }));
    const result = validateCodeStructure(
      {
        version: CODE_STRUCTURE_VERSION,
        modules,
        pathOwnership: ownership,
        allowedPatterns: [],
        projectionManifest: [],
      },
      "mem",
    );
    expect(result.warnings.some((w) => w.code === "CS-BOUNDEDNESS")).toBe(true);
  });

  it("evaluateCodeStructure json mode on empty tree", () => {
    root = mkdtempSync(join(tmpdir(), "cs-json-empty-"));
    const result = evaluateCodeStructure(root, { json: true });
    expect(result.stdout).toContain('"validated": []');
  });

  it("verify-stubs truncates long finding context in output", () => {
    root = mkdtempSync(join(tmpdir(), "stub-long-"));
    mkdirSync(join(root, "pkg"), { recursive: true });
    writeFileSync(join(root, "pkg", "long.go"), `// TODO ${"x".repeat(130)}\n`, "utf8");
    const result = evaluateVerifyStubs(root);
    expect(result.message.length).toBeLessThan(300);
  });

  it("scm boundary truncates finding list after fifty hits", () => {
    root = mkdtempSync(join(tmpdir(), "scm-many-"));
    const files: Record<string, string> = {};
    for (let i = 0; i < 55; i += 1) {
      files[`triage_${i}.py`] = `import subprocess\nsubprocess.run(["gh", "${i}"])\n`;
    }
    const scripts = join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(scripts, name), body, "utf8");
    }
    const result = evaluateScmBoundary(root);
    expect(result.code).toBe(1);
    expect(result.message).toContain("... and 5 more");
  });
});
