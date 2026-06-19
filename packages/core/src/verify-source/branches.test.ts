import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_STRUCTURE_VERSION,
  discoverCodeStructurePaths,
  validateCodeStructure,
  validateFile,
} from "./code-structure-validate.js";
import { scanPythonGhCalls } from "./python-call-scan.js";
import { loadMap, parseHeading } from "./rule-ownership-lint.js";
import { evaluateVerifyStubs, scanFileForStubs } from "./verify-stubs.js";

describe("verify-source branch coverage", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("parseHeading rejects headings without space after hashes", () => {
    expect(parseHeading("##NoSpace")).toBeNull();
    expect(parseHeading("####### too many")).toBeNull();
  });

  it("python call scan reads tuple argv and os.system non-literals safely", () => {
    expect(scanPythonGhCalls('import subprocess\nsubprocess.run(("gh", "x"))\n')).toHaveLength(1);
    expect(scanPythonGhCalls("import os\nos.system(cmd)\n")).toHaveLength(0);
    expect(scanPythonGhCalls("import subprocess\nsubprocess.run('ghx pr list')\n")).toHaveLength(1);
  });

  it("verify-stubs ignores bare pass when previous line is a comment", () => {
    root = mkdtempSync(join(tmpdir(), "stub-pass-"));
    mkdirSync(join(root, "pkg"), { recursive: true });
    const full = join(root, "pkg", "m.py");
    writeFileSync(full, "def f():\n    # def g():\n    pass\n", "utf8");
    const findings = scanFileForStubs("pkg/m.py", full);
    expect(findings.some((f) => f.label === "bare pass")).toBe(false);
  });

  it("code structure validates non-object collection entries", () => {
    const result = validateCodeStructure(
      {
        version: CODE_STRUCTURE_VERSION,
        modules: ["bad"],
        pathOwnership: ["bad"],
        allowedPatterns: [null],
        projectionManifest: [1],
      },
      "mem",
    );
    expect(result.errors.length).toBeGreaterThan(3);
  });

  it("discoverCodeStructurePaths retains unreadable PROJECT-DEFINITION", () => {
    root = mkdtempSync(join(tmpdir(), "cs-disc-bad-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "{bad", "utf8");
    const paths = discoverCodeStructurePaths(root);
    expect(paths.some((p) => p.endsWith("PROJECT-DEFINITION.vbrief.json"))).toBe(true);
  });

  it("validateFile adds CS-HOME when standalone disallowed", () => {
    root = mkdtempSync(join(tmpdir(), "cs-home-"));
    const path = join(root, "vbrief", "active", "story.vbrief.json");
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      path,
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
    const result = validateFile(path, { projectRoot: root, allowStandalone: false });
    expect(result.errors.some((e) => e.code === "CS-HOME")).toBe(true);
  });

  it("verify-stubs skips excluded directories and non-source extensions", () => {
    root = mkdtempSync(join(tmpdir(), "stub-skip-"));
    mkdirSync(join(root, "tests", "pkg"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "tests", "pkg", "t.go"), "// TODO\n", "utf8");
    writeFileSync(join(root, "lib", "readme.txt"), "TODO\n", "utf8");
    const result = evaluateVerifyStubs(root);
    expect(result.findings).toHaveLength(0);
    expect(result.code).toBe(0);
  });

  it("rule ownership loadMap rejects missing required fields", () => {
    root = mkdtempSync(join(tmpdir(), "rom-field-"));
    const mapPath = join(root, "map.json");
    writeFileSync(mapPath, JSON.stringify({ rules: [{ id: "only-id" }] }), "utf8");
    expect(() => loadMap(mapPath)).toThrow(/missing required field/);
  });
});
