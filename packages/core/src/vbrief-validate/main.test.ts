import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateConformance, scanVbrief } from "./conformance.js";
import { matchesFilenameConvention } from "./filename.js";
import * as vbriefValidate from "./index.js";
import { cmdVbriefValidate, runConformance, runValidate } from "./main.js";
import { validateAll } from "./validate-all.js";

describe("filename convention", () => {
  it("re-exports the public module surface", () => {
    expect(vbriefValidate.VALID_STATUSES.has("running")).toBe(true);
    expect(vbriefValidate.LIFECYCLE_FOLDERS.length).toBeGreaterThan(0);
  });

  it("accepts valid slugs and rejects edge cases", () => {
    expect(matchesFilenameConvention("2026-01-01-my-feature.xbrief.json")).toBe(true);
    expect(matchesFilenameConvention("2026-01-01-a.xbrief.json")).toBe(true);
    expect(matchesFilenameConvention("2026-01-01-a-b-c.xbrief.json")).toBe(true);
    expect(matchesFilenameConvention("PROJECT-DEFINITION.xbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-.xbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-trailing-.xbrief.json")).toBe(false);
    expect(matchesFilenameConvention("bad-name.xbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-UPPER.xbrief.json")).toBe(false);
  });
});

describe("validateAll", () => {
  it("validates a minimal valid project definition", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-validate-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "PROJECT-DEFINITION",
          status: "running",
          narratives: { Overview: "Overview text.", TechStack: "Rust" },
          items: [],
        },
      }),
      "utf8",
    );
    const { errors, warnings } = validateAll(vbrief);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("flags invalid schema version", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-bad-ver-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.5" },
        plan: { title: "X", status: "running", items: [] },
      }),
      "utf8",
    );
    const { errors } = validateAll(vbrief);
    expect(errors.some((e) => e.includes("vBRIEFInfo.version"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("conformance scan", () => {
  it("flags bare plan keys and allows path planRef", () => {
    const bare = scanVbrief("xbrief/x.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], customField: true, planRef: "#123" },
    });
    expect(bare.some((f) => f.key === "customField")).toBe(true);
    expect(bare.some((f) => f.key === "planRef")).toBe(true);

    const pathRef = scanVbrief("xbrief/y.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        planRef: "completed/parent.xbrief.json",
      },
    });
    expect(pathRef.some((f) => f.key === "planRef")).toBe(false);
  });

  it("allows namespaced observableChange and rejects the bare core key (#4495)", () => {
    const bare = scanVbrief("xbrief/x.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        observableChange: { changeKind: "fields-only" },
      },
    });
    expect(bare.some((f) => f.key === "observableChange")).toBe(true);

    const namespaced = scanVbrief("xbrief/y.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        "x-directive/observableChange": { changeKind: "fields-only" },
      },
    });
    expect(namespaced.some((f) => f.key === "x-directive/observableChange")).toBe(false);
    expect(namespaced.some((f) => f.key === "observableChange")).toBe(false);
  });
});

describe("CLI", () => {
  it("returns 0 when vbrief dir missing", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-cli-missing-"));
    expect(runValidate(["--vbrief-dir", join(root, "missing")])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns 2 on unknown validate flag", () => {
    expect(runValidate(["--not-a-flag"])).toBe(2);
  });

  it("runs conformance clean on valid fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-conf-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    execSync("git init", { cwd: root, stdio: "ignore" });
    expect(runConformance(["--all", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports warnings without failing unless escalated", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-warn-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    writeFileSync(
      join(vbrief, "pending", "2026-01-01-warn-only.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "W", status: "pending", items: [], references: [] },
      }),
      "utf8",
    );
    expect(runValidate(["--vbrief-dir", vbrief])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("routes --staged argv to conformance for verify:vbrief-conformance alias", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-cmd-staged-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    execSync("git init", { cwd: root, stdio: "ignore" });
    expect(cmdVbriefValidate(["--staged", "--project-root", root, "--quiet"])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("conformance PROJECT-DEFINITION on-disk injection (#4876)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  function initGit(root: string): void {
    execSync("git init", { cwd: root, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
    execSync("git config user.name test", { cwd: root, stdio: "ignore" });
  }

  it("counts untracked canonical PROJECT-DEFINITION instead of clean-zero", () => {
    const root = tempRoot("vb-4876-clean-pd-");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    initGit(root);
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [],
        },
      }),
      "utf8",
    );

    const result = evaluateConformance(root);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("1 vBRIEF file(s) clean");
    expect(result.message).not.toContain("0 vBRIEF file(s) clean");
  });

  it("fails closed on bare plan.policy in untracked PROJECT-DEFINITION", () => {
    const root = tempRoot("vb-4876-bare-policy-");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    initGit(root);
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [],
          policy: { allowDirectCommitsToMaster: false },
        },
      }),
      "utf8",
    );

    const result = evaluateConformance(root);
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.key === "policy")).toBe(true);
    expect(result.message).toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
  });

  it("still allows clean-zero when PROJECT-DEFINITION is absent", () => {
    const root = tempRoot("vb-4876-absent-pd-");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    initGit(root);

    const result = evaluateConformance(root);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("0 vBRIEF file(s) clean");
  });

  it("keeps DEFT_PROJECT_PATH / projectDefinitionPath injection for noncanonical paths", () => {
    const root = tempRoot("vb-4876-configured-");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    initGit(root);
    const configured = join(root, "config", "custom-project.xbrief.json");
    writeFileSync(
      configured,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Custom",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [],
          policy: { allowDirectCommitsToMaster: true },
        },
      }),
      "utf8",
    );

    const result = evaluateConformance(root, { projectDefinitionPath: configured });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.key === "policy")).toBe(true);
    expect(result.message).toContain("<configured PROJECT-DEFINITION>");
  });
});
