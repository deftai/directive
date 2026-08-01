import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportSpec, exportSpecMain, parseExportSpecArgv } from "../render/export-spec.js";
import { aggregateScopeSection, buildScopeOutlookSection } from "../render/scope-outlook.js";
import {
  EXPORT_SPEC_PD_BANNER,
  GENERATED_SPEC_PURPOSE,
  GENERATED_SPEC_SOURCE_PD,
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
    expect(authority?.banner).toContain("project:export-spec");
  });

  it("recognizes greenfield export banner without cross-classifying legacy spec", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const out = join(root, "SPECIFICATION.md");
    const [ok] = exportSpec({ projectRoot: root, outPath: out, audience: "stakeholder" });
    expect(ok).toBe(true);
    const md = readFileSync(out, "utf8");
    expect(md).toContain(GENERATED_SPEC_PURPOSE);
    expect(md).toContain(GENERATED_SPEC_SOURCE_PD);
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

  it("includes proposed scopes only for internal audience", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    // #1566: scopes are opt-in; pass includeScopes so audience filtering is exercised.
    const stakeholderOut = join(root, "SPEC-stakeholder.md");
    exportSpec({
      projectRoot: root,
      outPath: stakeholderOut,
      audience: "stakeholder",
      includeScopes: "all",
    });
    const stakeholderMd = readFileSync(stakeholderOut, "utf8");
    expect(stakeholderMd).toContain("## Scope outlook");
    expect(stakeholderMd).toContain("Accepted backlog");
    expect(stakeholderMd).not.toContain("Not yet accepted (proposed)");

    const internalOut = join(root, "SPEC-internal.md");
    exportSpec({
      projectRoot: root,
      outPath: internalOut,
      audience: "internal",
      includeScopes: "all",
    });
    const internalMd = readFileSync(internalOut, "utf8");
    expect(internalMd).toContain("Not yet accepted (proposed)");
    expect(internalMd).toContain("ideas, not approved backlog");
    expect(internalMd).toContain("Future idea");
  });

  it("exportSpec defaults to compact (no Scope outlook) (#1566)", () => {
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

  it("export banner matches EXPORT_SPEC_PD_BANNER constant", () => {
    const root = makeGreenfieldTree();
    roots.push(root);
    const out = join(root, "SPECIFICATION.md");
    exportSpec({ projectRoot: root, outPath: out });
    const md = readFileSync(out, "utf8");
    expect(md.startsWith(EXPORT_SPEC_PD_BANNER.trim())).toBe(true);
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

  it("parseExportSpecArgv rejects unknown flags", () => {
    const { errors } = parseExportSpecArgv(["--bogus-flag"]);
    expect(errors).toContain("Unknown flag: --bogus-flag");
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
