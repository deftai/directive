import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExpectedPrdMarkdown, buildPrdMarkdown } from "../render/prd-render.js";
import { renderSpecMarkdown } from "../render/spec-render.js";
import { evaluateSpecPrdFresh, runSpecPrdFreshCli } from "./spec-prd-fresh.js";

const SPEC = {
  xBRIEFInfo: { version: "0.8" },
  plan: {
    title: "Freshness Fixture",
    status: "approved",
    narratives: { Overview: "Hello freshness." },
    items: [],
  },
};

function writeSpec(root: string): string {
  const xbrief = join(root, "xbrief");
  mkdirSync(xbrief, { recursive: true });
  const specPath = join(xbrief, "specification.xbrief.json");
  writeFileSync(specPath, JSON.stringify(SPEC, null, 2), "utf8");
  return specPath;
}

describe("evaluateSpecPrdFresh", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function project(): string {
    const root = mkdtempSync(join(tmpdir(), "spec-prd-fresh-"));
    temps.push(root);
    return root;
  }

  it("exits 0 when banners and PRD projection match a fresh buffer", () => {
    const root = project();
    const specPath = writeSpec(root);
    const specRender = renderSpecMarkdown(specPath, {
      includeScopes: "off",
      includeLegacyArtifacts: false,
    });
    expect(specRender.ok).toBe(true);
    if (!specRender.ok) return;
    writeFileSync(join(root, "SPECIFICATION.md"), specRender.markdown, "utf8");
    writeFileSync(
      join(root, "PRD.md"),
      buildPrdMarkdown("Freshness Fixture", { Overview: "Hello freshness." }, specPath),
      "utf8",
    );
    const result = evaluateSpecPrdFresh(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("ignores LegacyArtifacts when matching compact task spec:render (#4086)", () => {
    const root = project();
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    const specPath = join(xbrief, "specification.xbrief.json");
    writeFileSync(
      specPath,
      JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Freshness Fixture",
            status: "approved",
            narratives: {
              Overview: "Hello freshness.",
              LegacyArtifacts: "Preserved migration section",
            },
            items: [],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const compact = renderSpecMarkdown(specPath, {
      includeScopes: "off",
      includeLegacyArtifacts: false,
    });
    expect(compact.ok).toBe(true);
    if (!compact.ok) return;
    expect(compact.markdown).not.toContain("Preserved migration section");
    const withLegacy = renderSpecMarkdown(specPath, {
      includeScopes: "off",
      includeLegacyArtifacts: true,
    });
    expect(withLegacy.ok).toBe(true);
    if (!withLegacy.ok) return;
    expect(withLegacy.markdown).toContain("Preserved migration section");
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      `${withLegacy.markdown.replace(/\n+$/u, "")}\n\n## Scope outlook\n\n### Historical dump\n`,
      "utf8",
    );
    const result = evaluateSpecPrdFresh(root);
    expect(result.code).toBe(0);
    expect(result.findings.filter((f) => f.artifact === "SPECIFICATION.md")).toEqual([]);
  });

  it("fails banner-canon when SPECIFICATION.md still names the legacy source", () => {
    const root = project();
    const specPath = writeSpec(root);
    const specRender = renderSpecMarkdown(specPath, { includeScopes: "off" });
    expect(specRender.ok).toBe(true);
    if (!specRender.ok) return;
    const dirty = specRender.markdown.replace(
      "xbrief/specification.xbrief.json",
      "vbrief/specification.vbrief.json",
    );
    writeFileSync(join(root, "SPECIFICATION.md"), dirty, "utf8");
    const result = evaluateSpecPrdFresh(root);
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.assertion === "banner-canon")).toBe(true);
  });

  it("fails projection-fresh when PRD.md body drifts from a re-render buffer", () => {
    const root = project();
    const specPath = writeSpec(root);
    const fresh = buildPrdMarkdown("Freshness Fixture", { Overview: "Hello freshness." }, specPath);
    writeFileSync(join(root, "PRD.md"), fresh.replace("Hello freshness.", "stale body"), "utf8");
    const result = evaluateSpecPrdFresh(root);
    expect(result.code).toBe(1);
    expect(
      result.findings.some((f) => f.artifact === "PRD.md" && f.assertion === "projection-fresh"),
    ).toBe(true);
  });

  it("matches task prd:render authority-aware narratives, not raw spec ProjectConfig (#4086)", () => {
    const root = project();
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Authority Fixture",
            status: "running",
            narratives: {
              Overview: "PD overview identity.",
              ProjectConfig: "secret config",
            },
            items: [],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const specPath = join(xbrief, "specification.xbrief.json");
    writeFileSync(
      specPath,
      JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Freshness Fixture",
            status: "approved",
            narratives: {
              Goals: "Ship freshness.",
              ProjectConfig: "must not appear in PRD",
            },
            items: [],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const expected = buildExpectedPrdMarkdown(root);
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(expected.markdown).toContain("PD overview identity.");
    expect(expected.markdown).toContain("Ship freshness.");
    expect(expected.markdown).not.toContain("must not appear in PRD");
    const raw = buildPrdMarkdown(
      "Freshness Fixture",
      { Goals: "Ship freshness.", ProjectConfig: "must not appear in PRD" },
      specPath,
    );
    expect(raw).toContain("must not appear in PRD");
    writeFileSync(join(root, "PRD.md"), expected.markdown, "utf8");
    const pass = evaluateSpecPrdFresh(root);
    expect(pass.code).toBe(0);
    writeFileSync(join(root, "PRD.md"), raw, "utf8");
    const fail = evaluateSpecPrdFresh(root);
    expect(fail.code).toBe(1);
    expect(
      fail.findings.some((f) => f.artifact === "PRD.md" && f.assertion === "projection-fresh"),
    ).toBe(true);
  });

  it("fails PRD freshness when canonical prd:render would refuse the authority (#4086)", () => {
    const root = project();
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Authority Fixture",
            status: "running",
            narratives: { Overview: "PD overview identity." },
            items: [],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const specPath = join(xbrief, "specification.xbrief.json");
    writeFileSync(
      specPath,
      JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Freshness Fixture",
            status: "approved",
            narratives: { Overview: 1 },
            items: [],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const expected = buildExpectedPrdMarkdown(root);
    expect(expected.ok).toBe(false);
    writeFileSync(
      join(root, "PRD.md"),
      buildPrdMarkdown("Freshness Fixture", { Overview: "stale" }, specPath),
      "utf8",
    );
    const result = evaluateSpecPrdFresh(root);
    expect(result.code).toBe(1);
    expect(
      result.findings.some(
        (f) =>
          f.artifact === "PRD.md" &&
          f.assertion === "projection-fresh" &&
          f.detail.includes("re-render failed"),
      ),
    ).toBe(true);
  });

  it("does not recut scope outlook: prefix match is enough for SPECIFICATION.md", () => {
    const root = project();
    const specPath = writeSpec(root);
    const specRender = renderSpecMarkdown(specPath, {
      includeScopes: "off",
      includeLegacyArtifacts: false,
    });
    expect(specRender.ok).toBe(true);
    if (!specRender.ok) return;
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      `${specRender.markdown.replace(/\n+$/u, "")}\n\n## Scope outlook\n\n### Historical dump\n`,
      "utf8",
    );
    const result = evaluateSpecPrdFresh(root);
    expect(result.findings.filter((f) => f.artifact === "SPECIFICATION.md")).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("exits 0 for greenfield PRD when PROJECT-DEFINITION exists and spec does not (#4086)", () => {
    const root = project();
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Greenfield Fixture",
            status: "running",
            narratives: { Overview: "Greenfield overview identity." },
            items: [],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const expected = buildExpectedPrdMarkdown(root);
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    writeFileSync(join(root, "PRD.md"), expected.markdown, "utf8");
    const result = evaluateSpecPrdFresh(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("exits 2 when PRD.md exists but neither spec nor PROJECT-DEFINITION is present", () => {
    const root = project();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "PRD.md"), "# stale\n", "utf8");
    const result = evaluateSpecPrdFresh(root);
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/PROJECT-DEFINITION|specification source/i);
  });

  it("exits 2 when --project-root is missing its argument", () => {
    const cli = runSpecPrdFreshCli(["--project-root"]);
    expect(cli.exitCode).toBe(2);
    expect(cli.stderr).toContain("expected one argument");
  });
});
