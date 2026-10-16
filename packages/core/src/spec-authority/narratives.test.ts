import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderNarrativeSections, resolveExportNarratives } from "./narratives.js";
import { resolveSpecAuthority } from "./resolver.js";

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeProjectDef(vbriefDir: string, narratives: Record<string, string>): void {
  writeJson(join(vbriefDir, "PROJECT-DEFINITION.xbrief.json"), {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      title: "Test Project",
      status: "running",
      narratives,
      items: [],
    },
  });
}

describe("resolveExportNarratives Requirements/AcceptanceCriteria (#4871)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps greenfield string Requirements and AcceptanceCriteria; still excludes TechStack", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4871-gf-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, {
      Overview: "Greenfield overview",
      Requirements: "Must export requirements",
      AcceptanceCriteria: "- greenfield AC",
      "tech stack": "TypeScript",
      TechStack: "Also excluded",
    });
    const authority = resolveSpecAuthority(root);
    expect(authority?.kind).toBe("greenfield");
    const merged = resolveExportNarratives(authority!);
    expect(merged.Requirements).toBe("Must export requirements");
    expect(merged.AcceptanceCriteria).toBe("- greenfield AC");
    expect(merged["tech stack"]).toBeUndefined();
    expect(merged.TechStack).toBeUndefined();
  });

  it("falls back to PD Requirements/AcceptanceCriteria when full-spec omits them", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4871-pd-only-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, {
      Overview: "PD overview",
      Requirements: "PD requirements",
      AcceptanceCriteria: "PD acceptance",
      "tech stack": "TypeScript",
    });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      plan: { narratives: { Overview: "Spec overview", ProblemStatement: "Problem" } },
    });
    const authority = resolveSpecAuthority(root);
    expect(authority?.kind).toBe("full-spec");
    const merged = resolveExportNarratives(authority!);
    expect(merged.Requirements).toBe("PD requirements");
    expect(merged.AcceptanceCriteria).toBe("PD acceptance");
    expect(merged["tech stack"]).toBeUndefined();
  });

  it("does not fall back non-identity PD keys outside Requirements/AcceptanceCriteria", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4871-no-goals-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, {
      Overview: "PD overview",
      Goals: "PD-only goals must not union",
      Requirements: "PD requirements",
    });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      plan: { narratives: { Overview: "Spec overview" } },
    });
    const authority = resolveSpecAuthority(root);
    const merged = resolveExportNarratives(authority!);
    expect(merged.Goals).toBeUndefined();
    expect(merged.Requirements).toBe("PD requirements");
  });

  it("keeps spec Requirements/AcceptanceCriteria when both sources conflict", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4871-conflict-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, {
      Overview: "PD overview",
      Requirements: "Stale PD requirements",
      AcceptanceCriteria: "Stale PD AC",
    });
    writeJson(join(vbrief, "specification.xbrief.json"), {
      plan: {
        narratives: {
          Overview: "Spec overview",
          Requirements: "Authoritative spec requirements",
          AcceptanceCriteria: "Authoritative spec AC",
        },
      },
    });
    const authority = resolveSpecAuthority(root);
    const merged = resolveExportNarratives(authority!);
    expect(merged.Requirements).toBe("Authoritative spec requirements");
    expect(merged.AcceptanceCriteria).toBe("Authoritative spec AC");
  });

  it("does not silently coerce array-shaped Requirements into export narratives", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4871-array-"));
    roots.push(root);
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeProjectDef(vbrief, { Overview: "PD overview" });
    writeJson(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Test Project",
        status: "running",
        narratives: {
          Overview: "PD overview",
          Requirements: ["line-a", "line-b"],
          AcceptanceCriteria: ["ac-1"],
        },
        items: [],
      },
    });
    const authority = resolveSpecAuthority(root);
    expect(authority?.kind).toBe("greenfield");
    const merged = resolveExportNarratives(authority!);
    expect(merged.Overview).toBe("PD overview");
    expect(merged.Requirements).toBeUndefined();
    expect(merged.AcceptanceCriteria).toBeUndefined();
  });

  it("orders AcceptanceCriteria after Requirements in preferred product order", () => {
    const sections = renderNarrativeSections({
      Zeta: "last leftover",
      AcceptanceCriteria: "AC body",
      Requirements: "Req body",
      Overview: "Overview body",
    });
    const joined = sections.join("\n");
    expect(joined.indexOf("## Overview")).toBeLessThan(joined.indexOf("## Requirements"));
    expect(joined.indexOf("## Requirements")).toBeLessThan(joined.indexOf("## AcceptanceCriteria"));
    expect(joined.indexOf("## AcceptanceCriteria")).toBeLessThan(joined.indexOf("## Zeta"));
  });
});
