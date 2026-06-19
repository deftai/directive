import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alignSpecNarratives,
  buildEdgesFromTasks,
  mapSpecStatus,
  parseRequirementDefinitions,
  parseSpecTasks,
  taskScopeNarratives,
} from "./fidelity.js";
import { parseTopLevelSections } from "./legacy-sections.js";
import { cmdVbriefValidation } from "./main.js";
import {
  loadSafetyManifest,
  rollback,
  SafetyManifest,
  sha256Of,
  writeSafetyManifest,
} from "./safety.js";
import {
  finalizeMigration,
  isolateInvalidOutput,
  slugifyId,
  validateMigrationOutput,
} from "./validation.js";

function writeInvalidPd(vbriefDir: string): void {
  writeFileSync(
    join(vbriefDir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "Bad", status: "in_progress", items: [] },
    }),
    "utf8",
  );
}

function writeValidPd(vbriefDir: string): void {
  writeFileSync(
    join(vbriefDir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "PROJECT-DEFINITION",
        status: "running",
        narratives: { Overview: "Test overview narrative.", "tech stack": "Python 3.12" },
        items: [],
      },
    }),
    "utf8",
  );
}

describe("remaining vbrief-validation branches", () => {
  it("covers fidelity merge and edge drops", () => {
    expect(alignSpecNarratives({ Overview: "first", summary: "second" }).Overview).toContain(
      "first",
    );
    expect(buildEdgesFromTasks([{ task_id: "t1", depends_on: ["t1", "bad id"] }])).toHaveLength(0);
    expect(
      taskScopeNarratives({ depends_on: ["a"], acceptance: ["x"], traces: ["FR-1"] }),
    ).toMatchObject({
      DependsOn: "a",
      AcceptanceCriteria: "- x",
      Traces: "FR-1",
    });
    expect(parseRequirementDefinitions("- FR-1: from bullet\n")).toEqual({});
    expect(mapSpecStatus("in-progress")).toBe("running");
    const fenced = "## A\n\n```\n## not a section\n```\n\n## B\n\nbody\n";
    expect(parseTopLevelSections(fenced)).toHaveLength(2);
    expect(parseSpecTasks("### t1.1.1 -- Widget\n\nBody line.\n")).toHaveLength(1);
  });

  it("covers validation isolate first collision and finalize relative path", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-val-br-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeInvalidPd(join(root, "vbrief"));
    const stderr: string[] = [];
    const [ok] = finalizeMigration(root, join(root, "vbrief"), ["seed"], {
      stderrWriter: (s) => stderr.push(s),
      isolateInvalid: () => join(root, "..", "outside.invalid"),
    });
    expect(ok).toBe(false);
    expect(isolateInvalidOutput(root, join(root, "vbrief"))).toContain("vbrief.invalid");
    const existing = new Set<string>();
    slugifyId("collision seed", existing);
    slugifyId("collision seed", existing);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers safety append drift and rename chain", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-safety-br-"));
    const target = join(root, ".gitignore");
    writeFileSync(target, "base\npartial", "utf8");
    const post = sha256Of(target);
    writeFileSync(join(root, "SPECIFICATION.premigrate.md"), "orig", "utf8");
    writeFileSync(join(root, "SPECIFICATION.md"), "stub", "utf8");
    const manifest = new SafetyManifest({
      backups: [
        {
          source: "SPECIFICATION.md",
          backup: "SPECIFICATION.premigrate.md",
          source_sha256: sha256Of(join(root, "SPECIFICATION.premigrate.md")),
          size_bytes: 4,
        },
      ],
      created_files: ["missing.txt"],
      file_modifications: [
        {
          path: ".gitignore",
          operation: "append",
          pre_hash: createHash("sha256").update("base\n").digest("hex"),
          post_hash: post,
          appended_content: "appended\n",
        },
        {
          path: "WEIRD.txt",
          operation: "unknown",
          pre_hash: "",
          post_hash: "",
          appended_content: "",
        },
      ],
      renames: [
        { original: "a.txt", current: "b.txt", renamed_by: "s1", renamed_at: "t1" },
        { original: "b.txt", current: "c.txt", renamed_by: "s2", renamed_at: "t2" },
      ],
    });
    writeSafetyManifest(root, manifest, { dryRun: false });
    const [ok, actions] = rollback(root, { force: true, confirmFn: () => true });
    expect(ok).toBe(true);
    expect(actions.some((a) => a.includes("cannot strip append cleanly"))).toBe(true);
    expect(new SafetyManifest().currentPathFor("a.txt")).toBe("a.txt");
    expect(loadSafetyManifest(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("covers main --all mode", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-main-all-"));
    try {
      mkdirSync(join(root, "vbrief"), { recursive: true });
      writeValidPd(join(root, "vbrief"));
      expect(cmdVbriefValidation(["--all", "--fixture-root", root])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validateMigrationOutput succeeds when directory is valid", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-bridge-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeValidPd(join(root, "vbrief"));
    const [errors] = validateMigrationOutput(join(root, "vbrief"));
    expect(errors).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
