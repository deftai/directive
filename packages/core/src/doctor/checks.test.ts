import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkInstallPathConsistency,
  checkLegacyLayout,
  checkManifestAgreement,
  checkQuickStartResolves,
  checkSkillPathsResolve,
  deriveExitCode,
  runChecks,
  runChecksImpl,
} from "./checks.js";

describe("checks", () => {
  it("derives exit codes", () => {
    expect(deriveExitCode([], [])).toBe(0);
    expect(deriveExitCode([{ name: "x", status: "fail", detail: "d" }], [])).toBe(1);
    expect(deriveExitCode([{ name: "x", status: "error", detail: "d" }], [])).toBe(2);
    expect(deriveExitCode([], ["err"])).toBe(2);
  });

  it("skips quick-start when install root unknown", () => {
    const result = checkQuickStartResolves("/tmp", null);
    expect(result.status).toBe("skip");
  });

  it("passes quick-start when file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      writeFileSync(join(root, ".deft", "core", "QUICK-START.md"), "# qs\n", "utf8");
      const result = checkQuickStartResolves(root, ".deft/core", {
        isFile: (p) => p.endsWith("QUICK-START.md"),
      });
      expect(result.status).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails quick-start when missing", () => {
    const result = checkQuickStartResolves("/tmp", ".deft/core", { isFile: () => false });
    expect(result.status).toBe("fail");
  });

  it("skips skill paths when none referenced", () => {
    expect(checkSkillPathsResolve("/tmp", "# no skills\n").status).toBe("skip");
  });

  it("detects missing skill paths", () => {
    const text = "see .deft/core/skills/deft-directive-build/SKILL.md\n";
    const result = checkSkillPathsResolve("/tmp", text, { isFile: () => false });
    expect(result.status).toBe("fail");
  });

  it("detects redirect stub skills", () => {
    const text = "see .deft/core/skills/deft-directive-build/SKILL.md\n";
    const result = checkSkillPathsResolve("/tmp", text, {
      isFile: () => true,
      readText: () => "<!-- deft:deprecated-skill-redirect -->\n",
    });
    expect(result.status).toBe("fail");
  });

  it("passes skill paths when all resolve", () => {
    const text = "see .deft/core/skills/deft-directive-build/SKILL.md\n";
    const result = checkSkillPathsResolve("/tmp", text, {
      isFile: () => true,
      readText: () => "# skill\n",
    });
    expect(result.status).toBe("pass");
  });

  it("manifest agreement skip on greenfield", () => {
    const result = checkManifestAgreement("/tmp", null, { isFile: () => false });
    expect(result.status).toBe("skip");
  });

  it("manifest agreement dual drift", () => {
    const result = checkManifestAgreement("/tmp", null, {
      isFile: (p) => p.includes("VERSION"),
      readText: (p) => (p.includes("core") ? "tag: v1.0.0\n" : "tag: v2.0.0\n"),
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Two install manifests disagree");
  });

  it("manifest agreement bare without yaml fails", () => {
    const result = checkManifestAgreement("/tmp", null, {
      isFile: (p) => p.includes(".deft-version"),
      readText: (p) => (p.includes(".deft-version") ? "0.1.0\n" : null),
    });
    expect(result.status).toBe("fail");
  });

  it("manifest agreement yaml only passes with note", () => {
    const result = checkManifestAgreement("/tmp", ".deft/core", {
      isFile: (p) => p.includes("VERSION"),
      readText: () => "tag: v0.1.0\n",
    });
    expect(result.status).toBe("pass");
  });

  it("manifest agreement drift between yaml and bare", () => {
    const result = checkManifestAgreement("/tmp", ".deft/core", {
      isFile: () => true,
      readText: (p) => (p.includes(".deft-version") ? "0.2.0\n" : "tag: v0.1.0\n"),
    });
    expect(result.status).toBe("fail");
  });

  it("install path consistency skip without root", () => {
    expect(checkInstallPathConsistency("/tmp", null).status).toBe("skip");
  });

  it("install path consistency fail when dir missing", () => {
    const result = checkInstallPathConsistency("/tmp", ".deft/core", { isDir: () => false });
    expect(result.status).toBe("fail");
  });

  it("install path consistency pass", () => {
    const result = checkInstallPathConsistency("/tmp", ".deft/core", { isDir: () => true });
    expect(result.status).toBe("pass");
  });

  it("checkLegacyLayout skips a canonical .deft/core layout", () => {
    const result = checkLegacyLayout("/proj", { isDir: (p) => p.endsWith(".deft/core") });
    expect(result.status).toBe("skip");
    expect(result.data?.legacy_layout).toBe(false);
  });

  it("checkLegacyLayout fails with a stable-URL signpost on a legacy layout", () => {
    const result = checkLegacyLayout("/proj", {
      isDir: () => false,
      isFile: (p) => p.endsWith(".deft/VERSION"),
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Legacy Deft layout detected");
    expect(result.detail).toContain("UPGRADING.md");
    expect(result.data?.legacy_layout).toBe(true);
    expect(result.data?.legacy_layout_kind).toBe("orphan-deft-version");
  });

  it("runChecksImpl flags a legacy orphan .deft/VERSION layout (exit 1)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-legacy-"));
    try {
      mkdirSync(join(root, ".deft"), { recursive: true });
      writeFileSync(join(root, ".deft", "VERSION"), "tag: 'v0.26.0'\n", "utf8");
      writeFileSync(join(root, "AGENTS.md"), "Deft is installed in .deft/core.\n", "utf8");
      const isDir = (p: string) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      };
      const result = runChecksImpl(root, { isDir });
      const legacy = result.checks.find((c) => c.name === "legacy-layout");
      expect(legacy?.status).toBe("fail");
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runChecksImpl config error for missing project root", () => {
    const result = runChecksImpl("/nope", { isDir: () => false });
    expect(result.exitCode).toBe(2);
  });

  it("runChecks missing AGENTS.md", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      mkdirSync(root, { recursive: true });
      const payload = runChecks(root, {
        isDir: () => true,
        isFile: () => false,
        readText: () => null,
      });
      expect(payload.exit_code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
