import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { CANONICAL_GITIGNORE_BASELINE } from "../init-deposit/gitignore.js";
import { renderXbriefMigrationLine } from "../xbrief-migrate/signpost.js";
import {
  checkCompletedLifecycleConsistency,
  checkCompletedOpenItems,
  checkCoverageCheckResumePolicy,
  checkGitignoreCoverage,
  checkInstallPathConsistency,
  checkLegacyLayout,
  checkManifestAgreement,
  checkManifestVersionReportable,
  checkQuickStartResolves,
  checkSkillPathsResolve,
  checkStaleXbriefSchemaDeposit,
  checkTypescript7SideBySide,
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
    expect(
      deriveExitCode([{ name: "completed-open-items", status: "fail", detail: "advisory" }], []),
    ).toBe(0);
  });

  it("fails closed when completed/ plan.status is running (#3242)", () => {
    const root = mkdtempSync(join(tmpdir(), "doc-cc-status-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "drift.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "drift",
            status: "running",
            items: [{ title: "a", status: "completed" }],
          },
        }),
        "utf8",
      );
      const result = checkCompletedLifecycleConsistency(root);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("completed/drift.xbrief.json");
      expect(result.detail).toContain("plan.status=running");
      expect(result.detail).toContain("folder=completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports open plan.items under completed/ as exit-exempt fail (#3242)", () => {
    const root = mkdtempSync(join(tmpdir(), "doc-cc-items-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "open.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "open",
            status: "completed",
            items: [{ title: "todo", status: "pending" }],
          },
        }),
        "utf8",
      );
      const statusCheck = checkCompletedLifecycleConsistency(root);
      expect(statusCheck.status).toBe("pass");
      const itemsCheck = checkCompletedOpenItems(root);
      expect(itemsCheck.status).toBe("fail");
      expect(itemsCheck.detail).toContain("pending");
      expect(itemsCheck.detail).toContain("completed/open.xbrief.json");
      expect(deriveExitCode([itemsCheck], [])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes completed lifecycle checks when status and items are terminal (#3242)", () => {
    const root = mkdtempSync(join(tmpdir(), "doc-cc-ok-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "ok.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "ok",
            status: "completed",
            items: [{ title: "done", status: "completed" }],
          },
        }),
        "utf8",
      );
      expect(checkCompletedLifecycleConsistency(root).status).toBe("pass");
      expect(checkCompletedOpenItems(root).status).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runChecksImpl includes completed-lifecycle checks and hard-fails status drift (#3242)", () => {
    const root = mkdtempSync(join(tmpdir(), "doc-cc-impl-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "# agents\n", "utf8");
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "drift.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "drift", status: "running", items: [] },
        }),
        "utf8",
      );
      const result = runChecksImpl(root, {
        isDir: (p) => p === root || p.includes("xbrief"),
        isFile: (p) => p.endsWith("AGENTS.md"),
        readText: (p) => (p.endsWith("AGENTS.md") ? "# agents\n" : null),
      });
      const names = result.checks.map((c) => c.name);
      expect(names).toContain("completed-lifecycle-consistency");
      expect(names).toContain("completed-open-items");
      const statusCheck = result.checks.find((c) => c.name === "completed-lifecycle-consistency");
      expect(statusCheck?.status).toBe("fail");
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("passes when deprecated-redirect sentinel appears only in documentation (#1408)", () => {
    const text = "see .deft/core/skills/deft-directive-build/SKILL.md\n";
    const docBody = [
      "---",
      "name: deft-directive-build",
      "---",
      "# Skill",
      "",
      "Pre-cutover docs mention `<!-- deft:deprecated-redirect -->` in prose.",
    ].join("\n");
    const result = checkSkillPathsResolve("/tmp", text, {
      isFile: () => true,
      readText: () => docBody,
    });
    expect(result.status).toBe("pass");
  });

  it("passes .agents/skills runtime paths when files resolve (#1404)", () => {
    const text = "-> `.deft/core/.agents/skills/deft-directive-build/SKILL.md`\n";
    const result = checkSkillPathsResolve("/tmp", text, {
      isFile: () => true,
      readText: () => "Read and follow: skills/deft-directive-build/SKILL.md\n",
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
    const result = checkLegacyLayout("/proj", { isDir: (p) => p.endsWith(`.deft${sep}core`) });
    expect(result.status).toBe("skip");
    expect(result.data?.legacy_layout).toBe(false);
  });

  it("checkLegacyLayout fails with a stable-URL signpost on a legacy layout", () => {
    const result = checkLegacyLayout("/proj", {
      isDir: () => false,
      isFile: (p) => p.endsWith(`.deft${sep}VERSION`),
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

  it("coverage-check-resume-policy is exit-exempt when undecided (#3189)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-ccr-"));
    try {
      mkdirSync(join(root, "xbrief"), { recursive: true });
      writeFileSync(
        join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "T", status: "running", items: [], policy: {} },
        }),
        "utf8",
      );
      const only = checkCoverageCheckResumePolicy(root);
      expect(only.status).toBe("skip");
      expect(only.detail).toContain("undecided");
      expect(only.detail).toContain("advisory");
      expect(deriveExitCode([only], [])).toBe(0);

      // decided path passes
      writeFileSync(
        join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "T",
            status: "running",
            items: [],
            policy: {
              coverageDebt: { status: "decided", mode: "off", autoFile: false },
              checkResume: {
                status: "decided",
                localStamp: "off",
                ciTrustsLocalStamp: false,
              },
            },
          },
        }),
        "utf8",
      );
      const decided = checkCoverageCheckResumePolicy(root);
      expect(decided.status).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("checkManifestVersionReportable (#2294)", () => {
  const seamsFor = (text: string | null) => ({
    isFile: (p: string) => p.endsWith("VERSION") && text !== null,
    readText: (p: string) => (p.endsWith("VERSION") ? text : null),
  });

  it("passes when a semver tag resolves", () => {
    const result = checkManifestVersionReportable(
      "/proj",
      ".deft/core",
      seamsFor("ref: 'v0.68.1'\nsha: 'abcdef1'\ntag: 'v0.68.1'\n"),
    );
    expect(result.status).toBe("pass");
    expect(result.data?.version).toBe("0.68.1");
    expect(result.data?.source).toBe("tag");
  });

  it("advisory-fails (sha only) when tag/ref are empty but a sha is present", () => {
    const result = checkManifestVersionReportable(
      "/proj",
      ".deft/core",
      seamsFor("ref: ''\nsha: '06329f3'\ntag: ''\ninstall_root: '.deft/core'\n"),
    );
    expect(result.status).toBe("fail");
    expect(result.data?.version).toBeNull();
    expect(result.data?.sha).toBe("06329f3");
    expect(result.detail).toContain("directive update");
    expect(result.detail).toContain("#2294");
  });

  it("does NOT change the doctor exit code (advisory only)", () => {
    const shaOnly = checkManifestVersionReportable(
      "/proj",
      ".deft/core",
      seamsFor("ref: ''\nsha: '06329f3'\ntag: ''\n"),
    );
    expect(deriveExitCode([shaOnly], [])).toBe(0);
  });

  it("skips when no manifest is present", () => {
    const result = checkManifestVersionReportable("/proj", ".deft/core", seamsFor(null));
    expect(result.status).toBe("skip");
    expect(result.data?.manifest_path).toBeNull();
  });

  it("skips when the manifest carries neither semver nor sha", () => {
    const result = checkManifestVersionReportable(
      "/proj",
      ".deft/core",
      seamsFor("ref: ''\nsha: ''\ntag: ''\ninstall_root: '.deft/core'\n"),
    );
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("no provenance");
  });
});

describe("checkGitignoreCoverage (#2206)", () => {
  function seamsFor(gitignoreText: string | null): { readText: (path: string) => string | null } {
    return {
      readText: (p: string) => (p.endsWith(".gitignore") ? gitignoreText : null),
    };
  }

  it("skips when .gitignore is absent", () => {
    const result = checkGitignoreCoverage("/proj", seamsFor(null));
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("directive init");
  });

  it("passes when all canonical entries are present", () => {
    // Join the live baseline so this fixture cannot drift when #3146-class
    // selective triage-cache state entries are added to CANONICAL_GITIGNORE_BASELINE.
    const lines = CANONICAL_GITIGNORE_BASELINE.join("\n");
    const result = checkGitignoreCoverage("/proj", seamsFor(lines));
    expect(result.status).toBe("pass");
    expect((result.data?.missing as string[]).length).toBe(0);
  });

  it("fails when canonical entries are missing", () => {
    const result = checkGitignoreCoverage("/proj", seamsFor("node_modules/\n"));
    expect(result.status).toBe("fail");
    const missing = result.data?.missing as string[];
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain(".deft-cache/");
    expect(result.detail).toContain("directive update");
  });

  it("reports xBRIEF-era eval result paths as missing (#2206)", () => {
    const partial =
      ".deft-cache/\n.deft/.cli/\n.deft/ritual-state.json\n.deft/last-session.json\n" +
      ".deft/routing.local.json\nvbrief/.triage-cache/candidates.jsonl\n" +
      "vbrief/.triage-cache/summary-history.jsonl\nvbrief/.triage-cache/scope-lifecycle.jsonl\n" +
      "vbrief/.triage-cache/decompositions/\nvbrief/.triage-cache/doctor-state.json\n" +
      "xbrief/.triage-cache/candidates.jsonl\nxbrief/.triage-cache/summary-history.jsonl\n" +
      "xbrief/.triage-cache/scope-lifecycle.jsonl\nxbrief/.triage-cache/decompositions/\n" +
      "xbrief/.triage-cache/doctor-state.json\nvbrief/*.lock\n.deft/core.bak-*/\n.deft/*.bak-*\n" +
      "*.premigrate.*\n";
    const result = checkGitignoreCoverage("/proj", seamsFor(partial));
    expect(result.status).toBe("fail");
    const missing = result.data?.missing as string[];
    expect(missing).toContain("xbrief/.eval/results/");
    expect(missing).toContain("vbrief/.eval/results/");
    expect(missing).toContain(".deft/xbrief-migrate-backup-*/");
  });

  it("is advisory: does NOT change the doctor exit code", () => {
    const fail = checkGitignoreCoverage("/proj", seamsFor("node_modules/\n"));
    expect(fail.status).toBe("fail");
    expect(deriveExitCode([fail], [])).toBe(0);
  });
});

describe("checkTypescript7SideBySide (#2591)", () => {
  function seamsFor(packageJsonText: string | null): { readText: (path: string) => string | null } {
    return {
      readText: (p: string) => (p.endsWith("package.json") ? packageJsonText : null),
    };
  }

  it("skips when package.json is absent", () => {
    const result = checkTypescript7SideBySide("/proj", seamsFor(null));
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("package.json not found");
  });

  it("skips when package.json is unreadable", () => {
    const result = checkTypescript7SideBySide("/proj", seamsFor("{not-json"));
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("unreadable");
  });

  it("skips when package.json has no dependency sections", () => {
    const result = checkTypescript7SideBySide("/proj", seamsFor(JSON.stringify({ name: "demo" })));
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("no dependency sections");
  });

  it("passes when typescript-eslint is absent", () => {
    const pkg = JSON.stringify({
      devDependencies: { eslint: "^9.0.0", typescript: "^7.0.2" },
    });
    const result = checkTypescript7SideBySide("/proj", seamsFor(pkg));
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("No typescript-eslint packages");
  });

  it("passes when eslint and typescript-eslint are present but typescript is missing", () => {
    const pkg = JSON.stringify({
      devDependencies: {
        eslint: "^9.0.0",
        "typescript-eslint": "^8.0.0",
      },
    });
    const result = checkTypescript7SideBySide("/proj", seamsFor(pkg));
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("No typescript dependency");
  });

  it("reads typescript from dependencies when devDependencies omits it", () => {
    const pkg = JSON.stringify({
      dependencies: { typescript: "^7.0.2" },
      devDependencies: {
        eslint: "^9.0.0",
        "@typescript-eslint/eslint-plugin": "^8.0.0",
      },
    });
    const result = checkTypescript7SideBySide("/proj", seamsFor(pkg));
    expect(result.status).toBe("fail");
  });

  it("passes when typescript uses the @typescript/typescript6 alias", () => {
    const pkg = JSON.stringify({
      devDependencies: {
        eslint: "^9.0.0",
        "@typescript-eslint/parser": "^8.0.0",
        typescript: "npm:@typescript/typescript6@^6.0.2",
        "@typescript/native": "npm:typescript@^7.0.2",
      },
    });
    const result = checkTypescript7SideBySide("/proj", seamsFor(pkg));
    expect(result.status).toBe("pass");
  });

  it("fails for bare typescript@7 with @typescript-eslint/parser and eslint", () => {
    const pkg = JSON.stringify({
      devDependencies: {
        eslint: "^9.0.0",
        "@typescript-eslint/parser": "^8.0.0",
        typescript: "^7.0.2",
      },
    });
    const result = checkTypescript7SideBySide("/proj", seamsFor(pkg));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("languages/typescript.md");
    expect(result.detail).toContain("@typescript/typescript6");
  });

  it("passes for typescript@5 with eslint and typescript-eslint", () => {
    const pkg = JSON.stringify({
      devDependencies: {
        eslint: "^9.0.0",
        "typescript-eslint": "^8.0.0",
        typescript: "^5.7.0",
      },
    });
    const result = checkTypescript7SideBySide("/proj", seamsFor(pkg));
    expect(result.status).toBe("pass");
  });

  it("passes for ts7 without eslint", () => {
    const pkg = JSON.stringify({
      devDependencies: {
        "@typescript-eslint/parser": "^8.0.0",
        typescript: "^7.0.2",
      },
    });
    const result = checkTypescript7SideBySide("/proj", seamsFor(pkg));
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("eslint is not declared");
  });

  it("is advisory: does NOT change the doctor exit code", () => {
    const pkg = JSON.stringify({
      devDependencies: {
        eslint: "^9.0.0",
        "@typescript-eslint/parser": "^8.0.0",
        typescript: "npm:typescript@^7.0.2",
      },
    });
    const fail = checkTypescript7SideBySide("/proj", seamsFor(pkg));
    expect(fail.status).toBe("fail");
    expect(deriveExitCode([fail], [])).toBe(0);
  });
});

describe("checkStaleXbriefSchemaDeposit (#2368)", () => {
  const LIFECYCLE = ["proposed", "pending", "active", "completed", "cancelled"] as const;

  function scaffoldMigratedXbrief(root: string): void {
    for (const folder of LIFECYCLE) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "fixture" },
        plan: { title: "Migrated", status: "running", items: [] },
      }),
      "utf8",
    );
  }

  it("skips when the project is not on a migrated xbrief layout", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-schema-"));
    try {
      const result = checkStaleXbriefSchemaDeposit(root, { isFile: () => false });
      expect(result.status).toBe("skip");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes when the deposited schema is already on xBRIEFInfo", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-schema-"));
    try {
      scaffoldMigratedXbrief(root);
      mkdirSync(join(root, "xbrief", "schemas"), { recursive: true });
      writeFileSync(
        join(root, "xbrief", "schemas", "vbrief-core.schema.json"),
        JSON.stringify({ xBRIEFInfo: { version: "0.8" } }),
        "utf8",
      );
      const result = checkStaleXbriefSchemaDeposit(root);
      expect(result.status).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("advises directive update (not migrate:xbrief) for a stale deposited schema", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-schema-"));
    try {
      scaffoldMigratedXbrief(root);
      mkdirSync(join(root, "xbrief", "schemas"), { recursive: true });
      writeFileSync(
        join(root, "xbrief", "schemas", "vbrief-core.schema.json"),
        JSON.stringify({ vBRIEFInfo: { version: "0.6", description: "stale deposit" } }),
        "utf8",
      );
      const result = checkStaleXbriefSchemaDeposit(root);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("directive update");
      expect(result.detail).toContain("not `deft migrate:xbrief`");
      expect(deriveExitCode([result], [])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not recommend migrate:xbrief on the doctor signpost line for stale schema only", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-schema-"));
    try {
      scaffoldMigratedXbrief(root);
      mkdirSync(join(root, "xbrief", "schemas"), { recursive: true });
      writeFileSync(
        join(root, "xbrief", "schemas", "vbrief-core.schema.json"),
        JSON.stringify({ vBRIEFInfo: { version: "0.6" } }),
        "utf8",
      );
      const line = renderXbriefMigrationLine(root);
      expect(line).toContain("xBrief migration: none");
      expect(line).not.toContain("migrate:xbrief");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
