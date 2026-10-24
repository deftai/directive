/**
 * Red proofs for #5796: Taskfile wiring owns only includes.deft (comment-aware).
 * Whole-file `.deft/core/` substring must not fail a runtime-correct include.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_PACKAGE_PATH_PREFIX } from "./constants.js";
import { checkWiringTargetsRuntime } from "./wiring.js";

const temps: string[] = [];

function tempRoot(prefix = "wiring-tf-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temps.push(root);
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const p = temps.pop();
    if (p) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

function writeTaskfile(root: string, body: string): void {
  writeFileSync(join(root, "Taskfile.yml"), body, "utf8");
}

const RUNTIME_INCLUDE = `./${RUNTIME_PACKAGE_PATH_PREFIX}Taskfile.yml`;

describe("checkWiringTargetsRuntime Taskfile.yml (#5796)", () => {
  it("accepts runtime includes.deft when .deft/core appears only in a YAML comment", () => {
    const root = tempRoot();
    writeTaskfile(
      root,
      [
        "version: '3'",
        "",
        "includes:",
        "  deft:",
        `    taskfile: ${RUNTIME_INCLUDE}`,
        "    optional: true",
        "",
        "tasks:",
        "  # Historical note: formerly `.deft/core/run doctor`",
        "  doctor:",
        "    cmds:",
        "      - echo ok",
        "",
      ].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.mismatched).not.toContain("Taskfile.yml");
    expect(result.ok).toBe(true);
  });

  it("rejects includes.deft that still targets .deft/core Taskfile.yml", () => {
    const root = tempRoot();
    writeTaskfile(
      root,
      [
        "version: '3'",
        "",
        "includes:",
        "  deft:",
        "    taskfile: ./.deft/core/Taskfile.yml",
        "    optional: true",
        "",
        "tasks:",
        "  doctor:",
        "    cmds:",
        "      - echo ok",
        "",
      ].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain("Taskfile.yml");
  });

  it("rejects a Taskfile that lacks includes.deft even if the runtime path appears only in a comment", () => {
    const root = tempRoot();
    writeTaskfile(
      root,
      [
        "version: '3'",
        "",
        `# See ${RUNTIME_INCLUDE} for the pin Taskfile`,
        "includes:",
        "  app:",
        "    taskfile: ./app/Taskfile.yml",
        "",
        "tasks:",
        "  build:",
        "    cmds:",
        "      - echo build",
        "",
      ].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain("Taskfile.yml");
  });

  it("accepts a minimal Taskfile whose includes.deft targets the runtime pin", () => {
    const root = tempRoot();
    writeTaskfile(
      root,
      [
        "version: '3'",
        "",
        "includes:",
        "  deft:",
        `    taskfile: ${RUNTIME_INCLUDE}`,
        "    optional: true",
        "",
      ].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(true);
    expect(result.mismatched).toEqual([]);
  });

  it("accepts go-task short scalar includes.deft targeting the runtime pin", () => {
    const root = tempRoot();
    writeTaskfile(
      root,
      ["version: '3'", "", "includes:", `  deft: ${RUNTIME_INCLUDE}`, ""].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(true);
    expect(result.mismatched).not.toContain("Taskfile.yml");
  });

  it("accepts go-task flow-map includes.deft targeting the runtime pin", () => {
    const root = tempRoot();
    writeTaskfile(
      root,
      [
        "version: '3'",
        "",
        "includes:",
        `  deft: { taskfile: ${RUNTIME_INCLUDE}, optional: true }`,
        "",
      ].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(true);
    expect(result.mismatched).not.toContain("Taskfile.yml");
  });

  it("rejects short scalar includes.deft that still targets .deft/core", () => {
    const root = tempRoot();
    writeTaskfile(
      root,
      ["version: '3'", "", "includes:", "  deft: ./.deft/core/Taskfile.yml", ""].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain("Taskfile.yml");
  });
});
