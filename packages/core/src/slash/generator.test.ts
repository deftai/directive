import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  generateThinWrapper,
  generateThinWrappers,
  isThinWrapperMarkdown,
  MAX_CATALOG_TOKENS,
  MAX_DESCRIPTION_TOKENS,
  MAX_WRAPPER_BODY_TOKENS,
  measureTokenBudget,
  renderThinWrapperBody,
  renderThinWrapperFile,
} from "./generator.js";
import { listProductCommands, PRODUCT_COMMAND_COUNT, type ProductCommand } from "./product-set.js";

describe("slash thin-wrapper generator (#3052 / #55 L5)", () => {
  it("emits one thin wrapper per product command (count === 13)", () => {
    const wrappers = generateThinWrappers();
    expect(wrappers).toHaveLength(PRODUCT_COMMAND_COUNT);
    expect(wrappers.map((w) => w.logicalId)).toEqual(listProductCommands().map((c) => c.logicalId));
  });

  it("uses stable output for the product set", () => {
    const a = generateThinWrappers();
    const b = generateThinWrappers();
    expect(a).toEqual(b);
    expect(a.map((w) => w.fileMarkdown)).toEqual(b.map((w) => w.fileMarkdown));
  });

  it("renders frontmatter description + short dispatch body (template shape)", () => {
    const cmd = listProductCommands().find((c) => c.logicalId === "/deft:directive:run:map");
    expect(cmd).toBeDefined();
    const file = renderThinWrapperFile(cmd as ProductCommand);
    expect(file.startsWith("---\n")).toBe(true);
    expect(file).toMatch(/^description:\s.+/m);
    expect(file).toContain("strategies/map.md");
    expect(file).toContain("Read and follow");
    expect(file).toContain("$ARGUMENTS");
    expect(isThinWrapperMarkdown(file, "strategies/map.md")).toBe(true);
  });

  it("includes argument-hint frontmatter when the product entry has a hint", () => {
    const interview = listProductCommands().find(
      (c) => c.logicalId === "/deft:directive:run:interview",
    );
    expect(interview?.argumentHint).toBe("<name>");
    const file = renderThinWrapperFile(interview as ProductCommand);
    expect(file).toMatch(/^argument-hint:\s"<name>"$/m);
  });

  it("does not inline strategy or skill bodies", () => {
    const wrappers = generateThinWrappers();
    for (const w of wrappers) {
      // Thin pointer only — no phase/workflow dump markers.
      expect(w.bodyMarkdown).not.toMatch(/^##\s+(Phase|Workflow|Steps|Acceptance)\b/m);
      expect(w.fileMarkdown).not.toMatch(/^##\s+(Phase|Workflow|Steps|Acceptance)\b/m);
      // Body must reference the path without embedding multi-k content.
      expect(w.bodyMarkdown).toContain(w.dispatchPath);
      expect(
        w.bodyMarkdown.split("\n").filter((line) => line.trim().length > 0).length,
      ).toBeLessThanOrEqual(6);
      expect(isThinWrapperMarkdown(w.fileMarkdown, w.dispatchPath)).toBe(true);
    }

    // Probe dispatches to the skill path; body must not paste skill SKILL.md bulk.
    const probe = wrappers.find((w) => w.logicalId === "/deft:directive:run:probe");
    expect(probe).toBeDefined();
    expect(probe?.bodyMarkdown).toContain("skills/deft-directive-probe/SKILL.md");
    expect(probe?.bodyMarkdown.toLowerCase()).not.toContain("adversarial one-question-per-turn");
  });

  it("keeps filename IR aligned with logical ids for emitters", () => {
    for (const w of generateThinWrappers()) {
      expect(w.filename).toBe(`${w.filenameStem}.md`);
      expect(w.filenameStem.length).toBeGreaterThan(0);
      expect(w.filename.endsWith(".md")).toBe(true);
    }
    const ir = generateThinWrapper(
      listProductCommands().find((c) => c.logicalId === "/deft:continue") as ProductCommand,
    );
    expect(ir.filename).toBe("deft-continue.md");
    expect(ir.dispatchKind).toBe("resilience");
  });

  it("enforces token-budget constraints (body, description, catalog)", () => {
    const wrappers = generateThinWrappers();
    const report = measureTokenBudget(wrappers);
    expect(report.commandCount).toBe(13);
    expect(report.withinBodyBudget).toBe(true);
    expect(report.withinDescriptionBudget).toBe(true);
    expect(report.withinCatalogBudget).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.maxBodyTokens).toBeLessThanOrEqual(MAX_WRAPPER_BODY_TOKENS);
    expect(report.maxDescriptionTokens).toBeLessThanOrEqual(MAX_DESCRIPTION_TOKENS);
    expect(report.catalogTokens).toBeLessThanOrEqual(MAX_CATALOG_TOKENS);

    for (const w of wrappers) {
      expect(w.estimatedBodyTokens).toBeLessThanOrEqual(MAX_WRAPPER_BODY_TOKENS);
      // Invoke band is roughly 40–100; allow thinner pointers down to a few tokens.
      expect(w.estimatedBodyTokens).toBeGreaterThan(10);
      expect(w.estimatedDescriptionTokens).toBe(estimateTokens(w.description));
    }
  });

  it("rejects fat markdown as non-thin", () => {
    const fat = [
      "---",
      "description: fat",
      "---",
      "",
      "## Phase 1",
      "Read and follow `strategies/interview.md`.",
      "A".repeat(800),
      "",
    ].join("\n");
    expect(isThinWrapperMarkdown(fat, "strategies/interview.md")).toBe(false);
  });

  it("exposes an emitter-consumable IR without requiring a second name table", () => {
    // #3053 can map IR → host files using only generateThinWrappers() output.
    const ir = generateThinWrappers();
    const byFilename = new Map(ir.map((w) => [w.filename, w]));
    expect(byFilename.size).toBe(13);
    expect(byFilename.get("deft-directive-run-interview.md")?.logicalId).toBe(
      "/deft:directive:run:interview",
    );
    expect(renderThinWrapperBody(listProductCommands()[0] as ProductCommand)).toContain(
      "commands.md",
    );
  });
});
