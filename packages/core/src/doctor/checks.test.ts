import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isAgentScratchWorktreePath } from "../fs/non-product-dirs.js";
import { CANONICAL_GITIGNORE_BASELINE } from "../init-deposit/gitignore.js";
import { MIGRATE_COMPLETION_NUDGE } from "../init-deposit/migrate.js";
import { renderXbriefMigrationLine } from "../xbrief-migrate/signpost.js";
import {
  checkCanonicalVendoredNpmSignpost,
  checkCompletedLifecycleConsistency,
  checkCompletedOpenItems,
  checkCompletedUnguardedWrite,
  checkCoverageCheckResumePolicy,
  checkCursorSdkAuth,
  checkDanglingNodeModulesLinks,
  checkGitignoreCoverage,
  checkInstallPathConsistency,
  checkLegacyLayout,
  checkManifestAgreement,
  checkManifestVersionReportable,
  checkQuickStartResolves,
  checkSkillPathsResolve,
  checkStaleXbriefSchemaDeposit,
  checkTypescript7SideBySide,
  checkXbriefEnvelopeMajorVersion,
  DANGLING_NODE_MODULES_LINKS_CHECK,
  DOCTOR_ADVISORY_FAIL_CHECKS,
  danglingNodeModulesRecoveryCommand,
  deriveExitCode,
  isDoctorAdvisoryFail,
  prefixCanonicalVendoredSignpostWarn,
  runChecks,
  runChecksImpl,
  SIGNPOST_ADVISORY_LABEL,
  scanXbriefEnvelopeVersions,
  XBRIEF_ENVELOPE_MIGRATE_COMMAND,
} from "./checks.js";
import { CANONICAL_UPGRADE_COMMAND } from "./constants.js";

describe("checks", () => {
  it("derives exit codes", () => {
    expect(deriveExitCode([], [])).toBe(0);
    expect(deriveExitCode([{ name: "x", status: "fail", detail: "d" }], [])).toBe(1);
    expect(deriveExitCode([{ name: "x", status: "error", detail: "d" }], [])).toBe(2);
    expect(deriveExitCode([], ["err"])).toBe(2);
    expect(
      deriveExitCode([{ name: "completed-open-items", status: "fail", detail: "advisory" }], []),
    ).toBe(0);
    expect(
      deriveExitCode(
        [{ name: "completed-unguarded-write", status: "fail", detail: "advisory" }],
        [],
      ),
    ).toBe(0);
    expect(deriveExitCode([{ name: "legacy-layout", status: "fail", detail: "legacy" }], [])).toBe(
      0,
    );
  });

  it("treats data.advisory true as exit-exempt even when the name is not in the set (#3379)", () => {
    const synthetic = {
      name: "synthetic-advisory-only",
      status: "fail" as const,
      detail: "advisory bit only",
      data: { advisory: true },
    };
    expect(DOCTOR_ADVISORY_FAIL_CHECKS.has(synthetic.name)).toBe(false);
    expect(isDoctorAdvisoryFail(synthetic.name, synthetic.data)).toBe(true);
    expect(deriveExitCode([synthetic], [])).toBe(0);
    expect(deriveExitCode([{ ...synthetic, data: {} }], [])).toBe(1);
  });

  it("canonical-vendored signpost fail is the migrate nudge and stays advisory (#4755)", () => {
    const root = mkdtempSync(join(tmpdir(), "doc-cv-4755-"));
    try {
      const core = join(root, ".deft", "core");
      mkdirSync(core, { recursive: true });
      writeFileSync(join(core, "VERSION"), "tag: 'v0.119.1'\nsha: abc\n", "utf8");
      const result = checkCanonicalVendoredNpmSignpost(root);
      expect(result.name).toBe("canonical-vendored-npm-signpost");
      expect(result.status).toBe("fail");
      expect(result.detail).toBe(MIGRATE_COMPLETION_NUDGE);
      expect(result.detail).not.toContain(CANONICAL_UPGRADE_COMMAND);
      expect(result.detail).not.toContain("npm i -g");
      expect(result.data?.advisory).toBe(true);
      expect(DOCTOR_ADVISORY_FAIL_CHECKS.has("canonical-vendored-npm-signpost")).toBe(true);
      const warn = prefixCanonicalVendoredSignpostWarn(
        result.name,
        `${result.name}: ${result.detail}`,
      );
      expect(warn.startsWith(`${SIGNPOST_ADVISORY_LABEL} `)).toBe(true);
      expect(warn).toContain(MIGRATE_COMPLETION_NUDGE);
      expect(warn).not.toContain("throttle-skipped full probe");
      expect(prefixCanonicalVendoredSignpostWarn("legacy-layout", "legacy-layout: dual")).toBe(
        "legacy-layout: dual",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("canonical-vendored signpost skips an npm-managed deposit (#4755)", () => {
    const root = mkdtempSync(join(tmpdir(), "doc-cv-4755-managed-"));
    try {
      const core = join(root, ".deft", "core");
      mkdirSync(core, { recursive: true });
      writeFileSync(join(core, "VERSION"), "tag: 'v0.119.1'\nmanaged_by: 'npm'\n", "utf8");
      const result = checkCanonicalVendoredNpmSignpost(root);
      expect(result.status).toBe("skip");
      expect(result.detail).not.toContain("directive migrate");
      expect(result.detail).not.toContain(CANONICAL_UPGRADE_COMMAND);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      expect(result.data?.advisory).not.toBe(true);
      expect(DOCTOR_ADVISORY_FAIL_CHECKS.has(result.name)).toBe(false);
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
      expect(itemsCheck.data?.advisory).toBe(true);
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

  it("hard-fails completed-lifecycle-consistency on unreadable completed artifacts (#3242)", () => {
    const root = mkdtempSync(join(tmpdir(), "doc-cc-unreadable-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "bad.xbrief.json"), "{not-json", "utf8");
      const result = checkCompletedLifecycleConsistency(root);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("malformed JSON");
      expect(result.detail).toContain("completed/bad.xbrief.json");
      expect(deriveExitCode([result], [])).toBe(1);
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
      expect(names).toContain("completed-unguarded-write");
      const statusCheck = result.checks.find((c) => c.name === "completed-lifecycle-consistency");
      expect(statusCheck?.status).toBe("fail");
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats completed-unguarded-write as advisory (#3679)", () => {
    const root = mkdtempSync(join(tmpdir(), "doc-unguarded-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "husk.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "husk", status: "completed", items: [], metadata: { kind: "fix" } },
        }),
        "utf8",
      );
      const result = checkCompletedUnguardedWrite(root);
      expect(result.status).toBe("fail");
      expect(result.data?.advisory).toBe(true);
      expect(DOCTOR_ADVISORY_FAIL_CHECKS.has("completed-unguarded-write")).toBe(true);
      expect(deriveExitCode([result], [])).toBe(0);
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
    expect(result.data?.suggested_fix).toBe("deft update");
  });

  it("missing YAML on eligible linked worktree suggests session:start (#5390)", () => {
    const result = checkManifestAgreement("/tmp/wt", ".deft/core", {
      isFile: (p) => p.replace(/\\/g, "/").includes("xbrief/.deft-version"),
      readText: (p) =>
        p.replace(/\\/g, "/").includes("xbrief/.deft-version") ? "0.119.13\n" : null,
      isLinkedWorktree: () => true,
      isFrameworkSource: () => false,
      payloadPresent: () => true,
      resolvePayloadSourceVersion: () => "0.119.13",
    });
    expect(result.status).toBe("fail");
    expect(result.data?.suggested_fix).toBe("deft session:start");
    expect(result.data?.missing_manifest_reconstitute_eligible).toBe(true);
    expect(result.detail).toContain("session:start");
    expect(result.detail).toContain("--rearm");
  });

  it("missing YAML on non-linked tree keeps deft update (#5390)", () => {
    const result = checkManifestAgreement("/tmp/primary", ".deft/core", {
      isFile: (p) => p.replace(/\\/g, "/").includes("xbrief/.deft-version"),
      readText: (p) =>
        p.replace(/\\/g, "/").includes("xbrief/.deft-version") ? "0.119.13\n" : null,
      isLinkedWorktree: () => false,
      isFrameworkSource: () => false,
      payloadPresent: () => true,
      resolvePayloadSourceVersion: () => "0.119.13",
    });
    expect(result.status).toBe("fail");
    expect(result.data?.suggested_fix).toBe("deft update");
    expect(result.data?.missing_manifest_reconstitute_eligible).toBe(false);
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
      isFile: (p) => {
        const n = p.replace(/\\/g, "/");
        if (n.endsWith("/.deft/core/VERSION") || n.endsWith(".deft/core/VERSION")) return true;
        // Only the root bare marker — not xbrief/vbrief — so disagreement does not fire.
        return n.endsWith("/.deft-version") && !n.includes("/xbrief/") && !n.includes("/vbrief/");
      },
      readText: (p) => {
        const n = p.replace(/\\/g, "/");
        if (n.includes(".deft-version")) return "0.2.0\n";
        return "tag: v0.1.0\n";
      },
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Drift detected");
  });

  it("bare marker disagreement skips with migrate hint when lifecycle unresolved (#5245 H1)", () => {
    const result = checkManifestAgreement("/tmp/legacy", ".deft/core", {
      isFile: (p) => {
        const n = p.replace(/\\/g, "/");
        if (n.includes("/xbrief/")) return false;
        return n.includes(".deft-version") || n.includes("/VERSION");
      },
      readText: (p) => {
        const n = p.replace(/\\/g, "/");
        if (n.includes("/vbrief/") && n.includes(".deft-version")) return "0.66.1\n";
        if (n.includes(".deft-version")) return "0.119.13\n";
        if (n.includes("VERSION")) return "tag: v0.119.13\n";
        return null;
      },
    });
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("migrate:xbrief");
    expect(result.data).toMatchObject({ bare_marker_disagreement: true });
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
    expect(result.data?.advisory).toBe(true);
  });

  it("runChecksImpl flags a legacy orphan .deft/VERSION layout as advisory", () => {
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
      expect(legacy?.data?.advisory).toBe(true);
      expect(legacy).toBeDefined();
      if (legacy === undefined) {
        return;
      }
      expect(deriveExitCode([legacy], [])).toBe(0);
      // Sibling hard fail (claimed .deft/core/ is absent) still exits 1.
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runChecksImpl config error for missing project root", () => {
    const result = runChecksImpl("/nope", { isDir: () => false });
    expect(result.exitCode).toBe(2);
  });

  it("coverage-check-resume-policy passes when absent; invalid stays exit-exempt (#3314)", () => {
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
      const absent = checkCoverageCheckResumePolicy(root);
      expect(absent.status).toBe("pass");
      expect(absent.detail).not.toContain("undecided");
      expect(deriveExitCode([absent], [])).toBe(0);

      writeFileSync(
        join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "T",
            status: "running",
            items: [],
            policy: {
              coverageDebt: { mode: "off" },
              checkResume: { localStamp: "off" },
            },
          },
        }),
        "utf8",
      );
      expect(checkCoverageCheckResumePolicy(root).status).toBe("pass");

      writeFileSync(
        join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "T",
            status: "running",
            items: [],
            policy: { coverageDebt: "nope" },
          },
        }),
        "utf8",
      );
      const invalid = checkCoverageCheckResumePolicy(root);
      expect(invalid.status).toBe("skip");
      expect(invalid.detail).toContain("invalid");
      expect(invalid.detail).not.toContain("undecided");
      expect(deriveExitCode([invalid], [])).toBe(0);
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
    expect(result.data?.advisory).toBe(true);
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

describe("checkXbriefEnvelopeMajorVersion (#3243)", () => {
  function writeEnvelope(
    root: string,
    relPath: string,
    version: string,
    infoKey: "xBRIEFInfo" | "vBRIEFInfo" = "xBRIEFInfo",
  ): void {
    const full = join(root, ...relPath.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(
      full,
      JSON.stringify({
        [infoKey]: { version, description: "fixture" },
        plan: { title: "t", status: "running", narratives: {}, items: [] },
      }),
      "utf8",
    );
  }

  it("skips greenfield with empty xbrief tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      mkdirSync(join(root, "xbrief", "active"), { recursive: true });
      const result = checkXbriefEnvelopeMajorVersion(root);
      expect(result.status).toBe("skip");
      expect(result.data?.reason).toBe("no-envelopes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes when all scanned envelopes are at framework major 0.8", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      writeEnvelope(root, "xbrief/PROJECT-DEFINITION.xbrief.json", "0.8");
      writeEnvelope(root, "xbrief/active/story.xbrief.json", "0.8");
      const result = checkXbriefEnvelopeMajorVersion(root);
      expect(result.status).toBe("pass");
      expect(result.detail).toContain("framework 0.8");
      expect(deriveExitCode([result], [])).toBe(0);
      const scan = scanXbriefEnvelopeVersions(root);
      expect(scan.worstDistance).toBe("current");
      expect(scan.behindMajor).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when lifecycle artifact declares 0.6 vs framework 0.8", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      writeEnvelope(root, "xbrief/PROJECT-DEFINITION.xbrief.json", "0.8");
      writeEnvelope(root, "xbrief/active/stale.xbrief.json", "0.6");
      const result = checkXbriefEnvelopeMajorVersion(root);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("behind-major");
      expect(result.detail).toContain("declared 0.6");
      expect(result.detail).toContain("framework 0.8");
      expect(result.detail).toContain("stale.xbrief.json");
      expect(result.detail).toContain(XBRIEF_ENVELOPE_MIGRATE_COMMAND);
      expect(result.data?.next_command).toBe(XBRIEF_ENVELOPE_MIGRATE_COMMAND);
      expect(deriveExitCode([result], [])).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fail closed for behind-minor (major-only check)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      // 0.7 vs framework 0.8 is behind-minor (minorGap 1), not behind-major.
      writeEnvelope(root, "xbrief/active/almost.xbrief.json", "0.7");
      const result = checkXbriefEnvelopeMajorVersion(root);
      expect(result.status).toBe("pass");
      expect(result.data?.worst_distance).toBe("behind-minor");
      expect(deriveExitCode([result], [])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for non-0.6 behind-major without migrate remediation", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      // 0.5 classifies as behind-major but migrate:xbrief only rewrites exact 0.6.
      writeEnvelope(root, "xbrief/active/ancient.xbrief.json", "0.5");
      const result = checkXbriefEnvelopeMajorVersion(root);
      expect(result.status).toBe("fail");
      expect(result.data?.status).toBe("behind-major-non-migratable");
      expect(result.detail).toContain("non-migratable");
      expect(result.detail).toContain("declared 0.5");
      expect(result.detail).toContain("framework 0.8");
      expect(result.detail).not.toContain(
        `Next action: run \`${XBRIEF_ENVELOPE_MIGRATE_COMMAND}\``,
      );
      // Actionable next steps — not migrate-only, not version-only bump (#3243).
      expect(result.detail).toContain("Next actions:");
      expect(result.detail).toMatch(/fix FS permissions/i);
      expect(result.detail).toMatch(/re-emit full xBRIEFInfo@/i);
      expect(result.detail).toMatch(/delete or replace invalid lifecycle artifacts/i);
      expect(result.detail).toContain("do not only bump the version field");
      expect(result.detail).toContain("only when declared is exact 0.6");
      expect(result.data?.next_command).toBeNull();
      expect(String(result.data?.suggestion ?? "")).toMatch(
        /not version-only|re-emit|permissions|delete\/replace/i,
      );
      expect(deriveExitCode([result], [])).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a live envelope is malformed JSON (not silent skip)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      const full = join(root, "xbrief", "active", "broken.xbrief.json");
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "{ not-json", "utf8");
      const result = checkXbriefEnvelopeMajorVersion(root);
      expect(result.status).toBe("fail");
      expect(result.data?.status).toBe("behind-major-non-migratable");
      expect(result.detail).toContain("broken.xbrief.json");
      expect(result.detail).toMatch(/missing\/unreadable|non-migratable/);
      expect(deriveExitCode([result], [])).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when PROJECT-DEFINITION exists but is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      const def = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
      mkdirSync(dirname(def), { recursive: true });
      writeFileSync(def, '{"xBRIEFInfo":{"version":"0.8"}}', "utf8");
      // isFile sees the path; readText cannot read it → behind-major null.
      const result = checkXbriefEnvelopeMajorVersion(root, {
        isFile: (p) => p === def || p.endsWith("PROJECT-DEFINITION.xbrief.json"),
        isDir: (p) => p.includes(`${sep}xbrief`) || p.endsWith("xbrief"),
        readText: () => null,
      });
      expect(result.status).toBe("fail");
      expect(result.data?.status).toBe("behind-major-non-migratable");
      expect(result.detail).toContain("PROJECT-DEFINITION.xbrief.json");
      expect(deriveExitCode([result], [])).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when PROJECT-DEFINITION stat throws non-ENOENT (not treated absent)", () => {
    // #3243 review: EACCES/EPERM on stat must include the definition path so
    // Doctor cannot skip/pass past a live definition it cannot inspect.
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      const def = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
      mkdirSync(dirname(def), { recursive: true });
      const eacces = Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
      const result = checkXbriefEnvelopeMajorVersion(root, {
        isFile: (p) => {
          if (p === def || p.endsWith("PROJECT-DEFINITION.xbrief.json")) {
            throw eacces;
          }
          return false;
        },
        isDir: (p) => p.includes(`${sep}xbrief`) || p.endsWith("xbrief"),
        readText: () => null,
      });
      expect(result.status).toBe("fail");
      expect(result.data?.status).toBe("behind-major-non-migratable");
      expect(result.detail).toContain("PROJECT-DEFINITION.xbrief.json");
      expect(result.detail).toMatch(/fix FS permissions/i);
      expect(deriveExitCode([result], [])).toBe(1);
      const scan = scanXbriefEnvelopeVersions(root, {
        isFile: (p) => {
          if (p === def || p.endsWith("PROJECT-DEFINITION.xbrief.json")) {
            throw eacces;
          }
          return false;
        },
        isDir: (p) => p.includes(`${sep}xbrief`) || p.endsWith("xbrief"),
        readText: () => null,
      });
      expect(
        scan.entries.some((e) => e.relativePath.endsWith("PROJECT-DEFINITION.xbrief.json")),
      ).toBe(true);
      expect(scan.behindMajor.some((e) => e.declaredVersion === null)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not invent PROJECT-DEFINITION when isFile throws ENOENT", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      mkdirSync(join(root, "xbrief", "active"), { recursive: true });
      const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      const result = checkXbriefEnvelopeMajorVersion(root, {
        isFile: () => {
          throw enoent;
        },
        isDir: (p) =>
          p.includes(`${sep}xbrief`) || p.endsWith("xbrief") || p.endsWith(`${sep}active`),
        readdir: () => [],
      });
      // Clean absence → greenfield skip, not fail closed on a phantom definition.
      expect(result.status).toBe("skip");
      expect(result.data?.reason).toBe("no-envelopes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an existing lifecycle dir cannot be listed (not skip/pass)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      const activeDir = join(root, "xbrief", "active");
      mkdirSync(activeDir, { recursive: true });
      // Dir exists (isDir true) but readdir throws → synthetic behind-major entry.
      const result = checkXbriefEnvelopeMajorVersion(root, {
        isDir: (p) =>
          p === activeDir ||
          p.endsWith(`${sep}active`) ||
          p.includes(`${sep}xbrief`) ||
          p.endsWith("xbrief"),
        readdir: () => {
          throw new Error("EACCES: permission denied");
        },
      });
      expect(result.status).toBe("fail");
      expect(result.data?.status).toBe("behind-major-non-migratable");
      expect(result.detail).toContain("xbrief/active");
      expect(result.detail).toMatch(/missing\/unreadable|non-migratable/);
      expect(result.data?.next_command).toBeNull();
      expect(deriveExitCode([result], [])).toBe(1);
      const scan = scanXbriefEnvelopeVersions(root, {
        isDir: (p) =>
          p === activeDir ||
          p.endsWith(`${sep}active`) ||
          p.includes(`${sep}xbrief`) ||
          p.endsWith("xbrief"),
        readdir: () => {
          throw new Error("EACCES: permission denied");
        },
      });
      expect(scan.entries.some((e) => e.relativePath === "xbrief/active")).toBe(true);
      expect(scan.behindMajor.some((e) => e.declaredVersion === null)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when lifecycle dir stat throws non-ENOENT before readdir", () => {
    // #3243 review: isDirectoryPath false on EACCES used to skip readdir fail-closed.
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      const activeDir = join(root, "xbrief", "active");
      mkdirSync(activeDir, { recursive: true });
      const eperm = Object.assign(new Error("EPERM: operation not permitted"), {
        code: "EPERM",
      });
      const result = checkXbriefEnvelopeMajorVersion(root, {
        isDir: (p) => {
          if (p === activeDir || p.endsWith(`${sep}active`)) {
            throw eperm;
          }
          // xbrief root present so we are not legacy-only.
          return p.includes(`${sep}xbrief`) || p.endsWith("xbrief");
        },
        readdir: () => {
          throw new Error("should not readdir after unreadable stat");
        },
      });
      expect(result.status).toBe("fail");
      expect(result.data?.status).toBe("behind-major-non-migratable");
      expect(result.detail).toContain("xbrief/active");
      expect(result.detail).toMatch(/fix FS permissions/i);
      expect(deriveExitCode([result], [])).toBe(1);
      const scan = scanXbriefEnvelopeVersions(root, {
        isDir: (p) => {
          if (p === activeDir || p.endsWith(`${sep}active`)) {
            throw eperm;
          }
          return p.includes(`${sep}xbrief`) || p.endsWith("xbrief");
        },
      });
      expect(scan.entries.some((e) => e.relativePath === "xbrief/active")).toBe(true);
      expect(scan.behindMajor.some((e) => e.declaredVersion === null)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips lifecycle folder cleanly when isDir throws ENOENT", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      mkdirSync(join(root, "xbrief"), { recursive: true });
      writeEnvelope(root, "xbrief/PROJECT-DEFINITION.xbrief.json", "0.8");
      const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      const result = checkXbriefEnvelopeMajorVersion(root, {
        isDir: (p) => {
          if (p.endsWith(`${sep}active`) || p.endsWith(`${sep}pending`)) {
            throw enoent;
          }
          return p.includes(`${sep}xbrief`) || p.endsWith("xbrief");
        },
      });
      // Absent pending/active is OK when definition is current.
      expect(result.status).toBe("pass");
      expect(deriveExitCode([result], [])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports mixed migratable and non-migratable behind-major in one fail", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-env-maj-"));
    try {
      writeEnvelope(root, "xbrief/active/stale06.xbrief.json", "0.6");
      writeEnvelope(root, "xbrief/pending/ancient.xbrief.json", "0.5");
      const result = checkXbriefEnvelopeMajorVersion(root);
      expect(result.status).toBe("fail");
      expect(result.data?.status).toBe("behind-major-mixed");
      expect(result.detail).toContain("mixed");
      expect(result.detail).toContain("stale06.xbrief.json");
      expect(result.detail).toContain("ancient.xbrief.json");
      expect(result.detail).toContain(XBRIEF_ENVELOPE_MIGRATE_COMMAND);
      expect(result.detail).toMatch(/rewrite|structure/i);
      expect(result.data?.migratable_count).toBe(1);
      expect(result.data?.non_migratable_count).toBe(1);
      expect(deriveExitCode([result], [])).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkCursorSdkAuth (#4295)", () => {
  it("skips when CURSOR_API_KEY is unset", () => {
    expect(checkCursorSdkAuth({}).status).toBe("skip");
  });
  it("passes when CURSOR_API_KEY is set", () => {
    expect(checkCursorSdkAuth({ CURSOR_API_KEY: "k" }).status).toBe("pass");
  });
  it("fails advisory when SDK launch is requested without a key", () => {
    const result = checkCursorSdkAuth({ DEFT_CURSOR_SDK_LAUNCH: "1" });
    expect(result.status).toBe("fail");
    expect(isDoctorAdvisoryFail(result.name, result.data)).toBe(true);
    expect(deriveExitCode([result], [])).toBe(0);
  });
});

describe("checkDanglingNodeModulesLinks (#3749)", () => {
  it("skips cleanly when node_modules is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-dangling-absent-"));
    try {
      const result = checkDanglingNodeModulesLinks(root);
      expect(result.name).toBe(DANGLING_NODE_MODULES_LINKS_CHECK);
      expect(result.status).toBe("skip");
      expect(result.detail).toMatch(/node_modules absent/i);
      expect(DOCTOR_ADVISORY_FAIL_CHECKS.has(result.name)).toBe(false);
      expect(deriveExitCode([result], [])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes when node_modules has no dangling links", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-dangling-pass-"));
    try {
      mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
      const result = checkDanglingNodeModulesLinks(root, { packageManager: "pnpm" });
      expect(result.status).toBe("pass");
      expect(result.data?.package_manager).toBe("pnpm");
      expect(deriveExitCode([result], [])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hard-fails with named recovery and worktree-path bonus via seams", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-dangling-fail-"));
    try {
      const nm = join(root, "node_modules");
      mkdirSync(nm, { recursive: true });
      const linkRel = "readable-stream";
      const target = join(
        root,
        ".deft-scratch",
        "worktrees",
        "b3738",
        "node_modules",
        "readable-stream",
      );
      const result = checkDanglingNodeModulesLinks(root, {
        packageManager: "pnpm",
        platform: "win32",
        isDir: (p) => p === nm || p === root,
        readdirWithFileTypes: (dir) => {
          if (dir === nm) {
            return [
              {
                name: linkRel,
                isDirectory: () => false,
                isSymbolicLink: () => true,
              },
            ];
          }
          return [];
        },
        readlink: () => target,
        targetExists: () => false,
      });
      expect(result.status).toBe("fail");
      expect(result.detail).toContain(linkRel);
      expect(result.detail).toContain("$env:CI='true'; pnpm install --frozen-lockfile");
      expect(result.detail).toContain("CI=true pnpm install --frozen-lockfile");
      expect(result.detail).toMatch(/agent scratch worktree/i);
      expect(result.detail).toContain("deft doctor --full");
      expect(result.data?.recovery).toBe(
        "$env:CI='true'; pnpm install --frozen-lockfile (PowerShell; POSIX: CI=true pnpm install --frozen-lockfile)",
      );
      expect(isDoctorAdvisoryFail(result.name, result.data)).toBe(false);
      expect(deriveExitCode([result], [])).toBe(1);
      const dangling = result.data?.dangling as Array<{ agentScratchWorktreeTarget: boolean }>;
      expect(dangling?.[0]?.agentScratchWorktreeTarget).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits npm ci recovery when package manager is npm", () => {
    expect(danglingNodeModulesRecoveryCommand("npm", "linux")).toBe("npm ci");
    expect(danglingNodeModulesRecoveryCommand("pnpm", "linux")).toBe(
      "pnpm install --frozen-lockfile",
    );
    expect(danglingNodeModulesRecoveryCommand("pnpm", "win32")).toBe(
      "$env:CI='true'; pnpm install --frozen-lockfile (PowerShell; POSIX: CI=true pnpm install --frozen-lockfile)",
    );
  });

  it("hard-fails when node_modules itself is a dangling root link", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-dangling-root-"));
    try {
      const nm = join(root, "node_modules");
      const result = checkDanglingNodeModulesLinks(root, {
        packageManager: "npm",
        isDir: () => false,
        lstat: (p) => (p === nm ? { isSymbolicLink: () => true } : null),
      });
      expect(result.status).toBe("fail");
      expect(result.detail).toMatch(/dangling junction\/symlink/i);
      expect(result.data?.dangling_root).toBe(true);
      expect(deriveExitCode([result], [])).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("advisory-fails bounded truncation with zero dangling (not silent clean pass)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-dangling-incomplete-"));
    try {
      const nm = join(root, "node_modules");
      mkdirSync(nm, { recursive: true });
      const result = checkDanglingNodeModulesLinks(root, {
        packageManager: "npm",
        isDir: (p) => p === nm || p === root,
        maxEntries: 1,
        readdirWithFileTypes: (dir) => {
          if (dir === nm) {
            return [
              {
                name: "a",
                isDirectory: () => true,
                isSymbolicLink: () => false,
              },
              {
                name: "b",
                isDirectory: () => true,
                isSymbolicLink: () => false,
              },
            ];
          }
          return [];
        },
      });
      expect(result.status).toBe("fail");
      expect(result.detail).toMatch(/truncated|entry\/depth bound/i);
      expect(result.detail).not.toMatch(/^No dangling/i);
      expect(result.data?.incomplete).toBe(true);
      expect(result.data?.incomplete_reason).toBe("bounded");
      expect(result.data?.advisory).toBe(true);
      expect(isDoctorAdvisoryFail(result.name, result.data)).toBe(true);
      expect(deriveExitCode([result], [])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hard-fails incomplete probes when a directory is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-dangling-unreadable-"));
    try {
      const nm = join(root, "node_modules");
      mkdirSync(nm, { recursive: true });
      const result = checkDanglingNodeModulesLinks(root, {
        packageManager: "npm",
        isDir: (p) => p === nm || p === root,
        readdirWithFileTypes: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      });
      expect(result.status).toBe("fail");
      expect(result.detail).toMatch(/unreadable/i);
      expect(result.data?.incomplete).toBe(true);
      expect(result.data?.incomplete_reason).toBe("unreadable");
      expect(result.data?.advisory).not.toBe(true);
      expect(isDoctorAdvisoryFail(result.name, result.data)).toBe(false);
      expect(deriveExitCode([result], [])).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat EACCES on a link target as dangling", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-dangling-eacces-target-"));
    try {
      const nm = join(root, "node_modules");
      mkdirSync(nm, { recursive: true });
      const deniedTarget = join(root, "denied-target");
      const result = checkDanglingNodeModulesLinks(root, {
        packageManager: "npm",
        isDir: (p) => p === nm || p === root,
        readdirWithFileTypes: (dir) => {
          if (dir === nm) {
            return [
              {
                name: "pkg",
                isDirectory: () => false,
                isSymbolicLink: () => true,
              },
            ];
          }
          return [];
        },
        readlink: () => deniedTarget,
        targetExists: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      });
      expect(result.status).toBe("pass");
      expect(result.detail).toMatch(/No dangling/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats broken link chains as dangling via ultimate target resolution", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-dangling-chain-"));
    try {
      const nm = join(root, "node_modules");
      mkdirSync(nm, { recursive: true });
      const finalGone = join(root, "gone-final");
      const mid = join(root, "mid-link");
      try {
        // Intermediate symlink exists; ultimate destination does not. Default
        // targetExists must follow (stat), not stop at lstat of the intermediate.
        symlinkSync(finalGone, mid);
        symlinkSync(mid, join(nm, "pkg"));
      } catch {
        // Host cannot create symlinks — skip without failing the suite.
        return;
      }
      const result = checkDanglingNodeModulesLinks(root, { packageManager: "npm" });
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("pkg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches AGENT_SCRATCH_DIRS worktrees including legacy swarm-worktrees", () => {
    expect(isAgentScratchWorktreePath("/repo/.deft-scratch/worktrees/x")).toBe(true);
    expect(isAgentScratchWorktreePath("C:\\repo\\swarm-worktrees\\worktrees\\y")).toBe(true);
    expect(isAgentScratchWorktreePath("/repo/node_modules/.pnpm/foo")).toBe(false);
  });

  it("runChecksImpl includes dangling check and hard-fails (#3749)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-dangling-impl-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "Deft is installed in .deft/core/.\n", "utf8");
      mkdirSync(join(root, "node_modules"), { recursive: true });
      const nm = join(root, "node_modules");
      const result = runChecksImpl(root, {
        isDir: (p) => p === root || p === nm,
        isFile: () => false,
        readText: (p) => (p.endsWith("AGENTS.md") ? "Deft is installed in .deft/core/.\n" : null),
        readdirWithFileTypes: (dir) => {
          if (dir === nm) {
            return [
              {
                name: "broken-pkg",
                isDirectory: () => false,
                isSymbolicLink: () => true,
              },
            ];
          }
          return [];
        },
        readlink: () => "/missing/target",
        targetExists: () => false,
        packageManager: "npm",
      });
      const dangling = result.checks.find((c) => c.name === DANGLING_NODE_MODULES_LINKS_CHECK);
      expect(dangling?.status).toBe("fail");
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
