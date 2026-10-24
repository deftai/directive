/**
 * Red proofs for #5796: Taskfile wiring owns only includes.deft (comment-aware).
 * Whole-file `.deft/core/` substring must not fail a runtime-correct include.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_PACKAGE_PATH_PREFIX } from "./constants.js";
import { MANAGED_SECTION_CLOSE, MANAGED_SECTION_OPEN_PREFIX } from "./ownership.js";
import { checkWiringTargetsRuntime, hasDirectiveWiringEvidence } from "./wiring.js";

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

  it("accepts four-space-indented short scalar includes.deft targeting the runtime pin", () => {
    const root = tempRoot();
    writeTaskfile(
      root,
      ["version: '3'", "", "includes:", `    deft: ${RUNTIME_INCLUDE}`, ""].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(true);
    expect(result.mismatched).not.toContain("Taskfile.yml");
  });

  it("accepts quoted-key short scalar includes.deft targeting the runtime pin", () => {
    const root = tempRoot();
    writeTaskfile(
      root,
      ["version: '3'", "", "includes:", `  "deft": ${RUNTIME_INCLUDE}`, ""].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(true);
    expect(result.mismatched).not.toContain("Taskfile.yml");
  });

  it("accepts four-space quoted-key expanded includes.deft targeting the runtime pin", () => {
    const root = tempRoot();
    writeTaskfile(
      root,
      [
        "version: '3'",
        "",
        "includes:",
        '    "deft":',
        `        taskfile: ${RUNTIME_INCLUDE}`,
        "        optional: true",
        "",
      ].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(true);
    expect(result.mismatched).not.toContain("Taskfile.yml");
  });

  it("rejects legacy includes.deft when nested vars.taskfile points at runtime", () => {
    // Greptile P1 on #5796: shared parseTaskfileIncludes accepts any taskfile:
    // at indent >= includes+4, so vars.taskfile can overwrite includes.deft.
    const root = tempRoot();
    writeTaskfile(
      root,
      [
        "version: '3'",
        "",
        "includes:",
        "  deft:",
        "    taskfile: ./.deft/core/Taskfile.yml",
        "    vars:",
        `      taskfile: ${RUNTIME_INCLUDE}`,
        "",
      ].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain("Taskfile.yml");
  });

  it("rejects includes.deft legacy path when a prior includes.DEFT points at runtime", () => {
    // Greptile P1 on HEAD: indent parser /i matched DEFT before exact deft.
    // Locked disposition owns only includes.deft — DEFT must not mask it.
    const root = tempRoot();
    writeTaskfile(
      root,
      [
        "version: '3'",
        "",
        "includes:",
        "  DEFT:",
        `    taskfile: ${RUNTIME_INCLUDE}`,
        "  deft:",
        "    taskfile: ./.deft/core/Taskfile.yml",
        "",
      ].join("\n"),
    );

    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain("Taskfile.yml");
  });
});

describe("checkWiringTargetsRuntime companion probes (coverage for #5796 headroom)", () => {
  it("accepts AGENTS managed section targeting runtime", () => {
    const root = tempRoot("wiring-agents-");
    writeFileSync(
      join(root, "AGENTS.md"),
      [
        "# Agents",
        `${MANAGED_SECTION_OPEN_PREFIX} v1 -->`,
        `Use ${RUNTIME_PACKAGE_PATH_PREFIX} for Directive wiring.`,
        MANAGED_SECTION_CLOSE,
        "",
      ].join("\n"),
      "utf8",
    );
    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(true);
    expect(hasDirectiveWiringEvidence(root)).toBe(true);
  });

  it("allows deft-hook prose inside AGENTS managed section for checkWiring only", () => {
    const root = tempRoot("wiring-agents-hook-");
    writeFileSync(
      join(root, "AGENTS.md"),
      [
        `${MANAGED_SECTION_OPEN_PREFIX} v1 -->`,
        `Use ${RUNTIME_PACKAGE_PATH_PREFIX} and recover via deft-hook when needed.`,
        MANAGED_SECTION_CLOSE,
        "",
      ].join("\n"),
      "utf8",
    );
    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(true);
    expect(result.mismatched).not.toContain("AGENTS.md");
  });

  it("treats AGENTS without managed section as non-mismatched", () => {
    const root = tempRoot("wiring-agents-bare-");
    writeFileSync(join(root, "AGENTS.md"), "# no managed section\n", "utf8");
    const result = checkWiringTargetsRuntime(root);
    expect(result.mismatched).not.toContain("AGENTS.md");
    expect(hasDirectiveWiringEvidence(root)).toBe(false);
  });

  it("rejects AGENTS managed section that still names .deft/core/", () => {
    const root = tempRoot("wiring-agents-core-");
    writeFileSync(
      join(root, "AGENTS.md"),
      [
        `${MANAGED_SECTION_OPEN_PREFIX} v1 -->`,
        "legacy .deft/core/run doctor",
        MANAGED_SECTION_CLOSE,
        "",
      ].join("\n"),
      "utf8",
    );
    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain("AGENTS.md");
  });

  it("accepts pre-commit shim sourcing _directive-run.sh without bare deft-hook", () => {
    const root = tempRoot("wiring-hook-");
    mkdirSync(join(root, ".githooks"), { recursive: true });
    writeFileSync(
      join(root, ".githooks", "pre-commit"),
      '#!/bin/sh\n. "$REPO_ROOT/.githooks/_directive-run.sh"\n',
      "utf8",
    );
    writeFileSync(
      join(root, ".githooks", "_directive-run.sh"),
      `#!/bin/sh\nexec node ./${RUNTIME_PACKAGE_PATH_PREFIX}dist/bin.js "$@"\n`,
      "utf8",
    );
    const result = checkWiringTargetsRuntime(root);
    expect(result.mismatched).not.toContain(".githooks/pre-commit");
    expect(hasDirectiveWiringEvidence(root)).toBe(true);
  });

  it("rejects hook JSON that still embeds .deft/core/", () => {
    const root = tempRoot("wiring-cursor-");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "hooks.json"),
      '{"hooks":{"preToolUse":["./.deft/core/hooks/run"]}}\n',
      "utf8",
    );
    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain(".cursor/hooks.json");
  });

  it("accepts hook JSON targeting the runtime prefix", () => {
    const root = tempRoot("wiring-cursor-ok-");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "hooks.json"),
      `{"hooks":{"preToolUse":["./${RUNTIME_PACKAGE_PATH_PREFIX}hooks/run"]}}\n`,
      "utf8",
    );
    const result = checkWiringTargetsRuntime(root);
    expect(result.ok).toBe(true);
    expect(hasDirectiveWiringEvidence(root)).toBe(true);
  });

  it("marks unreadable present probes as mismatched via seams", () => {
    const root = tempRoot("wiring-unread-");
    writeFileSync(join(root, "Taskfile.yml"), "version: '3'\n", "utf8");
    const result = checkWiringTargetsRuntime(root, {
      isFile: (p) => p.endsWith("Taskfile.yml"),
      readText: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain("Taskfile.yml");
  });
});
