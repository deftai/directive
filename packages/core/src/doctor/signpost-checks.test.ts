import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATE_COMPLETION_NUDGE } from "../init-deposit/migrate.js";
import { CANONICAL_UPGRADE_COMMAND } from "./constants.js";
import { createPlainSink } from "./output.js";
import { runLocalSignpostChecks } from "./signpost-checks.js";
import type { Finding } from "./types.js";

describe("runLocalSignpostChecks (#1997)", () => {
  it("warns on canonical-vendored deposit without npm-managed sentinel", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-sp-"));
    try {
      const core = join(root, ".deft", "core");
      mkdirSync(core, { recursive: true });
      writeFileSync(join(core, "VERSION"), "tag: v0.56.0\nsha: abc\n", "utf8");
      writeFileSync(join(root, "AGENTS.md"), "Deft is installed in .deft/core/.\n", "utf8");
      const findings: Finding[] = [];
      const lines: string[] = [];
      runLocalSignpostChecks(
        root,
        createPlainSink({ write: (text) => lines.push(text) }),
        (f) => findings.push(f),
        {
          runNpmConfigGet: () => ({ ok: false, value: "" }),
        },
      );
      const finding = findings.find((f) => f.check === "canonical-vendored-npm-signpost");
      expect(finding?.message).toBe(MIGRATE_COMPLETION_NUDGE);
      expect(finding?.message).not.toContain(CANONICAL_UPGRADE_COMMAND);
      const warn = lines.find((line) => line.includes("directive migrate"));
      expect(warn).toContain("Signpost advisory:");
      expect(warn).toContain(MIGRATE_COMPLETION_NUDGE);
      expect(warn).not.toContain("throttle-skipped full probe");
      expect(lines.join("")).not.toContain(CANONICAL_UPGRADE_COMMAND);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns on orphan .deft/VERSION legacy layout", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-sp-"));
    try {
      mkdirSync(join(root, ".deft"), { recursive: true });
      writeFileSync(join(root, ".deft", "VERSION"), "tag: v0.26.0\n", "utf8");
      const findings: Finding[] = [];
      runLocalSignpostChecks(root, createPlainSink(), (f) => findings.push(f), {
        runNpmConfigGet: () => ({ ok: false, value: "" }),
      });
      expect(findings.some((f) => f.check === "legacy-layout")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns on dual-layout (deft/ + .deft/core/) instead of skipping", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-sp-dual-"));
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      writeFileSync(join(root, ".deft", "core", "VERSION"), "tag: v0.84.0\n", "utf8");
      mkdirSync(join(root, "deft"), { recursive: true });
      writeFileSync(join(root, "deft", "main.md"), "# legacy framework\n", "utf8");
      writeFileSync(join(root, "AGENTS.md"), "Deft is installed in .deft/core/.\n", "utf8");
      const findings: Finding[] = [];
      runLocalSignpostChecks(root, createPlainSink(), (f) => findings.push(f), {
        runNpmConfigGet: () => ({ ok: false, value: "" }),
      });
      const legacy = findings.find((f) => f.check === "legacy-layout");
      expect(legacy).toBeDefined();
      expect(legacy?.message).toContain("Dual Deft layout detected");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the npm registry advisory active on the throttle-skipped path", () => {
    const findings: Finding[] = [];
    runLocalSignpostChecks("/tmp/project", createPlainSink(), (f) => findings.push(f), {
      runningInsideDeftRepo: () => false,
      runNpmConfigGet: (key) =>
        key === "@deftai:registry"
          ? { ok: true, value: "undefined" }
          : { ok: true, value: "https://npm.internal.example.com/" },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        check: "npm-registry-mirror",
      }),
    );
  });
});
