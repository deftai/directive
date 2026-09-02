import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportSpec, exportSpecMain, parseExportSpecArgv } from "../render/export-spec.js";
import { aggregateScopeSection, buildScopeOutlookSection } from "../render/scope-outlook.js";
import { renderSpec } from "../render/spec-render.js";
import { detectPreCutover } from "../vbrief-validate/precutover.js";
import {
  GENERATED_SPEC_PURPOSE,
  GENERATED_SPEC_SOURCE_PD,
  GENERATED_SPEC_SOURCE_PD_XBRIEF,
  GENERATED_SPEC_SOURCE_SPEC,
  GENERATED_SPEC_SOURCE_SPEC_XBRIEF,
  LEGACY_GENERATED_SPEC_SOURCE_MARKERS,
} from "./constants.js";
import { checkSpecMigrationFidelity } from "./migration-fidelity.js";
import { renderNarrativeSections, resolveExportNarratives } from "./narratives.js";
import {
  isCurrentGeneratedSpecification,
  isFullSpecState,
  isGreenfieldSpecExport,
  readSpecMarkdown,
  resolveSpecAuthority,
} from "./resolver.js";

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeProjectDef(
  vbriefDir: string,
  narratives: Record<string, string>,
  title = "Test Project",
): void {
  writeJson(join(vbriefDir, "PROJECT-DEFINITION.xbrief.json"), {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      title,
      status: "running",
      narratives,
      items: [],
    },
  });
}

function writeScope(
  vbriefDir: string,
  folder: string,
  filename: string,
  plan: Record<string, unknown>,
): void {
  const dir = join(vbriefDir, folder);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, filename), { xBRIEFInfo: { version: "0.8" }, plan });
}

function makeGreenfieldTree(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-gf-"));
  const vbrief = join(root, "xbrief");
  mkdirSync(vbrief, { recursive: true });
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(vbrief, folder), { recursive: true });
  }
  writeProjectDef(vbrief, {
    Overview: "Greenfield overview text.",
    ProjectConfig: "secret config",
    "tech stack": "TypeScript",
    Configuration: "defaults",
  });
  writeScope(vbrief, "proposed", "2026-06-28-idea.xbrief.json", {
    title: "Future idea",
    status: "proposed",
    narratives: { Overview: "Not committed yet." },
  });
  writeScope(vbrief, "pending", "2026-06-28-backlog.xbrief.json", {
    title: "Accepted story",
    status: "pending",
    narratives: { Overview: "Ready when promoted." },
  });
  writeScope(vbrief, "active", "2026-06-28-active.xbrief.json", {
    title: "Active story",
    status: "running",
    narratives: { Overview: "In progress." },
  });
  writeScope(vbrief, "completed", "2026-06-28-completed.xbrief.json", {
    title: "Completed story",
    status: "completed",
    narratives: { Overview: "Already delivered." },
  });
  return root;
}

describe("spec-authority resolver", () => {
  let roots: string[] = [];
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots = [];
  });

  it("classifies greenfield when PD exists without specification.xbrief.json", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const authority = resolveSpecAuthority(root);
    expect(authority?.kind).toBe("greenfield");
    expect(authority?.sourcePath).toBe(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"));
    expect(authority?.banner).toContain("project:export-spec");
    expect(authority?.banner).toContain(GENERATED_SPEC_SOURCE_PD_XBRIEF);
  });

  it("recognizes greenfield export banner without cross-classifying legacy spec", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const out = join(root, "SPECIFICATION.md");
    const [ok] = exportSpec({ projectRoot: root, outPath: out, audience: "stakeholder" });
    expect(ok).toBe(true);
    const md = readFileSync(out, "utf8");
    expect(md).toContain(GENERATED_SPEC_PURPOSE);
    expect(md).toContain(GENERATED_SPEC_SOURCE_PD_XBRIEF);
    expect(isGreenfieldSpecExport(root)).toBe(true);
    expect(isFullSpecState(root)).toBe(false);
    expect(isCurrentGeneratedSpecification(root)).toBe(true);
  });

  it("filters config narratives from stakeholder export", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const authority = resolveSpecAuthority(root);
    expect(authority).not.toBeNull();
    const narratives = resolveExportNarratives(authority as NonNullable<typeof authority>);
    expect(narratives.Overview).toContain("Greenfield");
    expect(narratives.ProjectConfig).toBeUndefined();
    expect(narratives["tech stack"]).toBeUndefined();
    expect(narratives.Configuration).toBeUndefined();
  });

  it("keeps stakeholder omitted scope selection compact", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const out = join(root, "SPEC-stakeholder.md");
    exportSpec({ projectRoot: root, outPath: out, audience: "stakeholder" });
    expect(readFileSync(out, "utf8")).not.toContain("## Scope outlook");
  });

  it("renders proposed-only outlook for internal audience when scope selection is omitted", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const out = join(root, "SPEC-internal.md");
    exportSpec({ projectRoot: root, outPath: out, audience: "internal" });
    const md = readFileSync(out, "utf8");
    expect(md).toContain("## Scope outlook");
    expect(md).toContain("Not yet accepted (proposed)");
    expect(md).toContain("ideas, not approved backlog");
    expect(md).toContain("Future idea");
    expect(md).not.toContain("Accepted backlog (pending)");
    expect(md).not.toContain("Active story");
    expect(md).not.toContain("Completed story");
  });

  it.each([
    {
      audience: "stakeholder" as const,
      mode: "current" as const,
      expected: ["Accepted story", "Active story"],
      excluded: ["Future idea", "Completed story"],
    },
    {
      audience: "internal" as const,
      mode: "current" as const,
      expected: ["Future idea", "Accepted story", "Active story"],
      excluded: ["Completed story"],
    },
    {
      audience: "stakeholder" as const,
      mode: "all" as const,
      expected: ["Accepted story", "Active story", "Completed story"],
      excluded: ["Future idea"],
    },
    {
      audience: "internal" as const,
      mode: "all" as const,
      expected: ["Future idea", "Accepted story", "Active story", "Completed story"],
      excluded: [],
    },
  ])("applies explicit $mode scope selection for $audience audience", ({
    audience,
    mode,
    expected,
    excluded,
  }) => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const out = join(root, `SPEC-${audience}-${mode}.md`);
    exportSpec({ projectRoot: root, outPath: out, audience, includeScopes: mode });
    const md = readFileSync(out, "utf8");
    expect(md).toContain("## Scope outlook");
    for (const title of expected) expect(md).toContain(title);
    for (const title of excluded) expect(md).not.toContain(title);
  });

  it.each([
    false,
    "off" as const,
  ])("treats explicit scope-off value %s as a hard override for internal audience", (includeScopes) => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const out = join(root, "SPEC-internal-off.md");
    exportSpec({ projectRoot: root, outPath: out, audience: "internal", includeScopes });
    expect(readFileSync(out, "utf8")).not.toContain("## Scope outlook");
  });

  it("exportSpec retains compact default for stakeholder audience (#1566)", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const out = join(root, "SPEC-compact.md");
    exportSpec({ projectRoot: root, outPath: out });
    const md = readFileSync(out, "utf8");
    expect(md).toContain("Greenfield overview");
    expect(md).not.toContain("## Scope outlook");
  });

  it("fails migration fidelity when premigrate narratives lack canonical landing (#2005)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-mig-"));
    roots.push(root);
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, { Overview: "Only overview migrated." });
    writeJson(join(vbrief, "specification.premigrate.vbrief.json"), {
      plan: {
        narratives: {
          ProblemStatement: "Lost problem",
          Goals: "Lost goals",
        },
      },
    });
    const errors = checkSpecMigrationFidelity(root);
    expect(errors.length).toBe(1);
    expect(errors[0].toLowerCase()).toContain("problemstatement");
    expect(errors[0]).toContain("#2005");
  });

  it("passes migration fidelity when product narratives land in PD", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-mig-ok-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, {
      Overview: "Overview",
      ProblemStatement: "Migrated problem",
      Goals: "Migrated goals",
    });
    writeJson(join(vbrief, "specification.premigrate.xbrief.json"), {
      plan: { narratives: { ProblemStatement: "Old", Goals: "Old" } },
    });
    expect(checkSpecMigrationFidelity(root)).toEqual([]);
  });

  it("export banner names the resolved xBRIEF PROJECT-DEFINITION source", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const out = join(root, "SPECIFICATION.md");
    exportSpec({ projectRoot: root, outPath: out });
    const md = readFileSync(out, "utf8");
    expect(md).toContain(GENERATED_SPEC_SOURCE_PD_XBRIEF);
    expect(md).not.toContain("vbrief/PROJECT-DEFINITION.vbrief.json");
  });

  it("buildScopeOutlookSection returns empty when no scopes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-empty-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    expect(buildScopeOutlookSection(vbrief)).toEqual([]);
  });

  it("exportSpec fails when PROJECT-DEFINITION is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-nopd-"));
    roots.push(root);
    const [ok, msg] = exportSpec({ projectRoot: root });
    expect(ok).toBe(false);
    expect(msg).toContain("PROJECT-DEFINITION");
  });

  it("exportSpec fails when greenfield Overview is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-noov-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, { Overview: "" });
    const [ok, msg] = exportSpec({ projectRoot: root });
    expect(ok).toBe(false);
    expect(msg).toContain("Overview");
  });

  it("recognizes full-spec state with matching banner", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-full-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview" });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Full spec",
        status: "running",
        narratives: { Overview: "Spec overview", ProblemStatement: "Problem" },
      },
    });
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      `${GENERATED_SPEC_PURPOSE}\n<!-- Source of truth: xbrief/specification.xbrief.json -->\n`,
      "utf8",
    );
    expect(isFullSpecState(root)).toBe(true);
    expect(isGreenfieldSpecExport(root)).toBe(false);
  });

  it("treats a stale vbrief spec banner as current when xbrief spec and lifecycle exist (#4117)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-stale-vbrief-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview" });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Full spec",
        status: "running",
        narratives: { Overview: "Spec overview" },
        items: [],
      },
    });
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      `${GENERATED_SPEC_PURPOSE}\n${GENERATED_SPEC_SOURCE_SPEC}\n`,
      "utf8",
    );
    expect(isFullSpecState(root)).toBe(true);
    expect(isCurrentGeneratedSpecification(root)).toBe(true);
    expect(detectPreCutover(root)).toEqual({ preCutover: false, reasons: [] });
  });

  it("does not alias a stale vbrief banner when the named file still exists with different content (#4117)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-stale-present-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview" });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Full spec",
        status: "running",
        narratives: { Overview: "Spec overview" },
        items: [],
      },
    });
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeJson(join(root, "vbrief", "specification.vbrief.json"), {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Different", status: "running", narratives: {}, items: [] },
    });
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      `${GENERATED_SPEC_PURPOSE}\n${GENERATED_SPEC_SOURCE_SPEC}\n`,
      "utf8",
    );
    expect(isFullSpecState(root)).toBe(false);
    expect(isCurrentGeneratedSpecification(root)).toBe(false);
  });

  it("does not alias a stale vbrief banner when the named path is a directory (#4117)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-stale-dir-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview" });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Full spec",
        status: "running",
        narratives: { Overview: "Spec overview" },
        items: [],
      },
    });
    mkdirSync(join(root, "vbrief", "specification.vbrief.json"), { recursive: true });
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      `${GENERATED_SPEC_PURPOSE}\n${GENERATED_SPEC_SOURCE_SPEC}\n`,
      "utf8",
    );
    expect(isFullSpecState(root)).toBe(false);
    expect(isCurrentGeneratedSpecification(root)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "does not alias a stale vbrief banner when the named file is unreadable (#4117)",
    () => {
      const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-stale-unreadable-"));
      roots.push(root);
      const vbrief = join(root, "xbrief");
      for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
        mkdirSync(join(vbrief, folder), { recursive: true });
      }
      writeProjectDef(vbrief, { Overview: "PD overview" });
      writeJson(join(vbrief, "specification.xbrief.json"), {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Full spec",
          status: "running",
          narratives: { Overview: "Spec overview" },
          items: [],
        },
      });
      mkdirSync(join(root, "vbrief"), { recursive: true });
      const legacy = join(root, "vbrief", "specification.vbrief.json");
      writeJson(legacy, {
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "Different", status: "running", narratives: {}, items: [] },
      });
      chmodSync(legacy, 0o000);
      writeFileSync(
        join(root, "SPECIFICATION.md"),
        `${GENERATED_SPEC_PURPOSE}\n${GENERATED_SPEC_SOURCE_SPEC}\n`,
        "utf8",
      );
      try {
        expect(isFullSpecState(root)).toBe(false);
        expect(isCurrentGeneratedSpecification(root)).toBe(false);
      } finally {
        chmodSync(legacy, 0o644);
      }
    },
  );

  it("treats a stale vbrief PD banner as current when the named file is gone (#4117)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-stale-pd-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview" });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Full spec",
        status: "running",
        narratives: { Overview: "Spec overview" },
        items: [],
      },
    });
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      `${GENERATED_SPEC_PURPOSE}\n${GENERATED_SPEC_SOURCE_PD}\n`,
      "utf8",
    );
    expect(isFullSpecState(root)).toBe(true);
    expect(isCurrentGeneratedSpecification(root)).toBe(true);
    expect(detectPreCutover(root)).toEqual({ preCutover: false, reasons: [] });
  });

  it("keeps the generated-source legacy-alias list to the two known vbrief banners (#4117)", () => {
    expect([...LEGACY_GENERATED_SPEC_SOURCE_MARKERS]).toEqual([
      GENERATED_SPEC_SOURCE_SPEC,
      GENERATED_SPEC_SOURCE_PD,
    ]);
  });

  it("still classifies a hand-authored SPECIFICATION.md as pre-cutover (#4117)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-hand-authored-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview" });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Full spec",
        status: "running",
        narratives: { Overview: "Spec overview" },
        items: [],
      },
    });
    writeFileSync(join(root, "SPECIFICATION.md"), "# Hand authored spec\n", "utf8");
    expect(isFullSpecState(root)).toBe(false);
    expect(isCurrentGeneratedSpecification(root)).toBe(false);
    expect(detectPreCutover(root).preCutover).toBe(true);
  });

  it("recognizes a source-derived banner from an explicit spec path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-explicit-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview" });
    const specification = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Explicit full spec",
        status: "approved",
        narratives: { Overview: "Spec overview" },
        items: [],
      },
    };
    writeJson(join(vbrief, "specification.xbrief.json"), specification);
    const explicitDir = join(root, "inputs");
    mkdirSync(explicitDir, { recursive: true });
    const explicitSpecPath = join(explicitDir, "custom-spec.json");
    writeJson(explicitSpecPath, specification);

    const out = join(root, "SPECIFICATION.md");
    const [ok] = renderSpec(explicitSpecPath, out);

    expect(ok).toBe(true);
    expect(readFileSync(out, "utf8")).toContain(
      `<!-- Source of truth: ${explicitSpecPath.replaceAll("\\", "/")} -->`,
    );
    expect(isFullSpecState(root)).toBe(true);
    expect(isCurrentGeneratedSpecification(root)).toBe(true);
  });

  it("recognizes an equivalent explicit spec through a normalized relative marker", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-relative-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview" });
    const specification = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Relative explicit full spec",
        status: "approved",
        narratives: { Overview: "Spec overview" },
        items: [],
      },
    };
    writeJson(join(vbrief, "specification.xbrief.json"), specification);
    mkdirSync(join(root, "inputs"), { recursive: true });
    writeJson(join(root, "inputs", "custom-spec.json"), specification);
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      `${GENERATED_SPEC_PURPOSE}\n<!-- Source of truth: inputs/../inputs/custom-spec.json -->\n`,
      "utf8",
    );

    expect(isFullSpecState(root)).toBe(true);
    expect(isCurrentGeneratedSpecification(root)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "keeps unsafe explicit spec filename bytes reversible without breaking the banner",
    () => {
      const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-encoded-"));
      roots.push(root);
      const vbrief = join(root, "xbrief");
      for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
        mkdirSync(join(vbrief, folder), { recursive: true });
      }
      writeProjectDef(vbrief, { Overview: "PD overview" });
      const specification = {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Encoded explicit full spec",
          status: "approved",
          narratives: { Overview: "Spec overview" },
          items: [],
        },
      };
      writeJson(join(vbrief, "specification.xbrief.json"), specification);
      const explicitDir = join(root, "inputs");
      mkdirSync(explicitDir, { recursive: true });
      const explicitSpecPath = join(explicitDir, "custom\r\nspec-->alias\\name.json");
      writeJson(explicitSpecPath, specification);

      const out = join(root, "SPECIFICATION.md");
      const [ok] = renderSpec(explicitSpecPath, out);
      const sourceLine = readFileSync(out, "utf8")
        .split("\n")
        .find((line) => line.startsWith("<!-- Source of truth:"));

      expect(ok).toBe(true);
      expect(sourceLine).toContain("%0D%0A");
      expect(sourceLine).toContain("--%3E");
      expect(sourceLine).toContain("%5C");
      expect(sourceLine?.match(/-->/g)).toHaveLength(1);
      expect(isFullSpecState(root)).toBe(true);
      expect(isCurrentGeneratedSpecification(root)).toBe(true);
    },
  );

  it("rejects a generated source marker unrelated to the resolved spec artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-unrelated-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview" });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Resolved specification",
        status: "approved",
        narratives: { Overview: "Resolved overview" },
        items: [],
      },
    });
    const unrelatedPath = join(root, "inputs", "unrelated.json");
    mkdirSync(join(root, "inputs"), { recursive: true });
    writeJson(unrelatedPath, {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Unrelated artifact",
        status: "approved",
        narratives: { Overview: "Different content" },
        items: [],
      },
    });
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      `${GENERATED_SPEC_PURPOSE}\n<!-- Source of truth: ${unrelatedPath.replaceAll("\\", "/")} -->\n`,
      "utf8",
    );

    expect(isFullSpecState(root)).toBe(false);
    expect(isCurrentGeneratedSpecification(root)).toBe(false);
  });

  it("rejects a resolved source marker paired with the wrong purpose", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-purpose-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview" });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Spec", status: "approved", narratives: {}, items: [] },
    });
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      "<!-- Purpose: rendered roadmap -->\n" +
        "<!-- Source of truth: xbrief/specification.xbrief.json -->\n",
      "utf8",
    );

    expect(isFullSpecState(root)).toBe(false);
    expect(isCurrentGeneratedSpecification(root)).toBe(false);
  });

  it("parseExportSpecArgv rejects unknown flags", () => {
    const { errors } = parseExportSpecArgv(["--bogus-flag"]);
    expect(errors).toContain("Unknown flag: --bogus-flag");
  });

  it("parseExportSpecArgv rejects mistyped include-scopes / legacy values (#1566)", () => {
    const scopes = parseExportSpecArgv(["--include-scopes=curret"]);
    expect(scopes.errors.some((e) => e.includes("Invalid --include-scopes=curret"))).toBe(true);
    const legacy = parseExportSpecArgv(["--include-legacy-artifacts=onn"]);
    expect(legacy.errors.some((e) => e.includes("Invalid --include-legacy-artifacts=onn"))).toBe(
      true,
    );
  });

  it("parseExportSpecArgv accepts audience, limit, no-scopes, and positional paths", () => {
    const { options, errors } = parseExportSpecArgv([
      "/proj",
      "/out.md",
      "--audience=internal",
      "--proposed-limit=5",
      "--no-scopes",
    ]);
    expect(errors).toEqual([]);
    expect(options.projectRoot).toBe("/proj");
    expect(options.outPath).toBe("/out.md");
    expect(options.audience).toBe("internal");
    expect(options.proposedLimit).toBe(5);
    expect(options.includeScopes).toBe("off");
  });

  it("preserves omitted scope selection separately from explicit off", () => {
    expect(parseExportSpecArgv(["--audience=internal"]).options.includeScopes).toBeUndefined();
    expect(
      parseExportSpecArgv(["--audience=internal", "--include-scopes=off"]).options.includeScopes,
    ).toBe("off");
  });

  it("exportSpecMain returns 2 on argv errors, 1 on export failure, 0 on success", () => {
    expect(exportSpecMain(["--bad-flag"])).toBe(2);
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-main-"));
    roots.push(root);
    expect(exportSpecMain([root])).toBe(1);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, { Overview: "Overview text" });
    expect(exportSpecMain([root])).toBe(0);
  });

  it("exports full-spec state via specification.xbrief.json path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-full-exp-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeProjectDef(vbrief, { Overview: "PD overview", Architecture: "PD arch" });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Canonical spec",
        status: "running",
        items: [],
        narratives: {
          Overview: "Spec overview",
          ProblemStatement: "Problem",
          Goals: "Goals",
        },
      },
    });
    const out = join(root, "SPEC-full.md");
    const [ok] = exportSpec({ projectRoot: root, outPath: out });
    expect(ok).toBe(true);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("Canonical spec");
    expect(md).toContain("Problem");
    expect(md).toContain("PD arch");
    expect(md).toContain(GENERATED_SPEC_SOURCE_SPEC_XBRIEF);
  });

  it("exportSpec skips scopes when includeScopes is false", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const out = join(root, "SPEC-no-scopes.md");
    exportSpec({ projectRoot: root, outPath: out, includeScopes: false });
    const md = readFileSync(out, "utf8");
    expect(md).not.toContain("## Scope outlook");
  });

  it("buildScopeOutlookSection covers active, completed, deps, and proposed limit", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-scope-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeScope(vbrief, "proposed", "a.xbrief.json", {
      id: "scope-a",
      title: "Proposed A",
      status: "proposed",
      narratives: { Overview: "Idea A" },
    });
    writeScope(vbrief, "proposed", "b.xbrief.json", {
      id: "scope-b",
      title: "Proposed B",
      status: "proposed",
      narratives: { Description: "Idea B" },
    });
    writeScope(vbrief, "proposed", "c.xbrief.json", {
      id: "scope-c",
      title: "Proposed C",
      status: "proposed",
      narratives: { Overview: "Idea C" },
    });
    writeScope(vbrief, "active", "running.xbrief.json", {
      id: "scope-run",
      title: "Running story",
      status: "running",
      narratives: { Acceptance: "- Ship feature\n- Test feature" },
      items: [
        {
          title: "Task one",
          status: "done",
          narrative: { Acceptance: "Criterion one" },
        },
      ],
      edges: [{ from: "scope-a", to: "scope-run" }],
    });
    writeScope(vbrief, "completed", "done.xbrief.json", {
      id: "scope-done",
      title: "Finished",
      status: "completed",
      narratives: { UserStory: "Done story" },
    });
    const limited = buildScopeOutlookSection(vbrief, { includeProposed: true, proposedLimit: 2 });
    const text = limited.join("\n");
    expect(text).toContain("showing 2 of 3");
    expect(text).toContain("Running story");
    expect(text).toContain("Finished");
    expect(text).toContain("Criterion one");
    expect(aggregateScopeSection(vbrief).join("\n")).toContain("Active");
  });

  it("checkSpecMigrationFidelity returns empty when spec or premigrate absent", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-mig-skip-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    expect(checkSpecMigrationFidelity(root)).toEqual([]);

    writeProjectDef(vbrief, { Overview: "Only overview" });
    writeJson(join(vbrief, "specification.premigrate.xbrief.json"), {
      plan: { narratives: { Overview: "Old overview only" } },
    });
    expect(checkSpecMigrationFidelity(root)).toEqual([]);

    writeJson(join(vbrief, "specification.xbrief.json"), {
      plan: { narratives: { Overview: "Canonical" } },
    });
    expect(checkSpecMigrationFidelity(root)).toEqual([]);
  });

  it("resolveExportNarratives merges PD identity hints into full-spec export", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-narr-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, {
      Overview: "PD overview",
      Architecture: "PD-only architecture",
      RisksAndUnknowns: "PD risks",
    });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      plan: {
        narratives: { Overview: "Spec overview", ProblemStatement: "Problem" },
      },
    });
    const authority = resolveSpecAuthority(root);
    expect(authority).not.toBeNull();
    const merged = resolveExportNarratives(authority as NonNullable<typeof authority>);
    expect(merged.Architecture).toBe("PD-only architecture");
    expect(merged.RisksAndUnknowns).toBe("PD risks");
    const sections = renderNarrativeSections({
      Zeta: "last",
      Overview: "Overview",
      Alpha: "first",
    });
    expect(sections.join("\n")).toContain("## Alpha");
    expect(sections.join("\n")).toContain("## Zeta");
  });

  it("isFullSpecState and isGreenfieldSpecExport return false without matching markdown", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    expect(isGreenfieldSpecExport(root)).toBe(false);
    const vbrief = join(root, "xbrief");
    writeJson(join(vbrief, "specification.xbrief.json"), {
      plan: { narratives: { Overview: "Spec" } },
    });
    expect(isFullSpecState(root)).toBe(false);
  });

  it("resolveSpecAuthority returns null without PROJECT-DEFINITION", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-nopd-res-"));
    roots.push(root);
    expect(resolveSpecAuthority(root)).toBeNull();
    expect(readSpecMarkdown(root)).toBe("");
  });

  it("parseExportSpecArgv ignores invalid proposed-limit values", () => {
    const { options, errors } = parseExportSpecArgv(["--proposed-limit=0", "--proposed-limit=bad"]);
    expect(errors).toEqual([]);
    expect(options.proposedLimit).toBeUndefined();
  });

  it("isCurrentGeneratedSpecification is true for greenfield export banner", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    exportSpec({ projectRoot: root });
    expect(isCurrentGeneratedSpecification(root)).toBe(true);
  });

  it("checkSpecMigrationFidelity passes when narratives land in scope vBRIEFs", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-mig-scope-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    writeProjectDef(vbrief, { Overview: "Overview" });
    writeJson(join(vbrief, "specification.premigrate.xbrief.json"), {
      plan: { narratives: { ProblemStatement: "Old problem", Goals: "Old goals" } },
    });
    writeScope(vbrief, "pending", "story.xbrief.json", {
      title: "Story",
      status: "pending",
      narratives: { ProblemStatement: "Migrated problem", Goals: "Migrated goals" },
    });
    expect(checkSpecMigrationFidelity(root)).toEqual([]);
  });

  it("buildScopeOutlookSection skips invalid scope JSON and malformed edges", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-bad-scope-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    writeFileSync(join(vbrief, "active", "broken.xbrief.json"), "{bad", "utf8");
    writeScope(vbrief, "active", "linked.xbrief.json", {
      id: "a",
      title: "Linked",
      status: "running",
      narratives: { Overview: "Linked scope" },
      edges: [{ from: "missing", to: "a" }, null, { source: "a", target: "a" }],
    });
    const text = buildScopeOutlookSection(vbrief).join("\n");
    expect(text).toContain("Linked");
  });

  it("buildScopeOutlookSection renders item acceptance bullets and array criteria", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-items-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    writeScope(vbrief, "pending", "story.xbrief.json", {
      title: "Story",
      status: "pending",
      narratives: { Acceptance: ["Criterion A", "Criterion B"] },
      items: [
        { title: "Child", status: "open", narrative: { Acceptance: ["Child criterion"] } },
        { title: "Bad item" },
      ],
    });
    const text = buildScopeOutlookSection(vbrief).join("\n");
    expect(text).toContain("Criterion A");
    expect(text).toContain("Child criterion");
  });

  it("exportSpec fails when full-spec validation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-auth-bad-spec-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, { Overview: "PD" });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      plan: { title: "Bad", status: "bogus-status", items: [] },
    });
    const [ok, msg] = exportSpec({ projectRoot: root });
    expect(ok).toBe(false);
    expect(msg.length).toBeGreaterThan(0);
  });
});
