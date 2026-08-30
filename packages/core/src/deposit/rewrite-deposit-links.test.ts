import { describe, expect, it } from "vitest";
import {
  mapSourceToPackRelative,
  REWRITE_MARKER_PREFIX,
  rewriteMarkdownDepositLinks,
  rewriteRelativeLink,
  sourceRelForPackRel,
} from "./rewrite-deposit-links.js";

describe("mapSourceToPackRelative (#3937)", () => {
  it("flattens content/ children and keeps harness entries at the pack root", () => {
    expect(mapSourceToPackRelative("content/coding/coding.md")).toBe("coding/coding.md");
    expect(mapSourceToPackRelative("content/meta/security.md")).toBe("meta/security.md");
    expect(mapSourceToPackRelative("main.md")).toBe("main.md");
    expect(mapSourceToPackRelative("SKILL.md")).toBe("SKILL.md");
    expect(mapSourceToPackRelative("tasks/verify.yml")).toBe("tasks/verify.yml");
    expect(mapSourceToPackRelative(".githooks/pre-commit")).toBe(".githooks/pre-commit");
  });

  it("maps the content/ directory itself to the pack root", () => {
    expect(mapSourceToPackRelative("content")).toBe(".");
    expect(mapSourceToPackRelative("content/")).toBe(".");
  });

  it("returns null for repo-dev paths that do not ship", () => {
    expect(mapSourceToPackRelative("REFERENCES.md")).toBeNull();
    expect(mapSourceToPackRelative("docs/decisions/ADR-001.md")).toBeNull();
    expect(mapSourceToPackRelative("scripts/_precutover.py")).toBeNull();
    expect(mapSourceToPackRelative("PROJECT.md")).toBeNull();
  });

  it("inverts through sourceRelForPackRel", () => {
    expect(sourceRelForPackRel("coding/coding.md")).toBe("content/coding/coding.md");
    expect(sourceRelForPackRel("main.md")).toBe("main.md");
  });
});

describe("rewriteRelativeLink (#3937)", () => {
  it("strips the content/ prefix from root main.md without breaking the reverse main.md escape", () => {
    const fromMain = rewriteRelativeLink({
      sourceFileRel: "main.md",
      packFileRel: "main.md",
      target: "./content/coding/coding.md",
    });
    expect(fromMain).toEqual({
      next: "./coding/coding.md",
      rewritten: true,
      packMapped: true,
    });

    const fromCoding = rewriteRelativeLink({
      sourceFileRel: "content/coding/coding.md",
      packFileRel: "coding/coding.md",
      target: "../../main.md",
    });
    expect(fromCoding).toEqual({
      next: "../main.md",
      rewritten: true,
      packMapped: true,
    });
  });

  it("drops one ../ when a nested content file climbs to root main.md", () => {
    const result = rewriteRelativeLink({
      sourceFileRel: "content/skills/deft-directive-setup/SKILL.md",
      packFileRel: "skills/deft-directive-setup/SKILL.md",
      target: "../../../main.md",
    });
    expect(result).toEqual({
      next: "../../main.md",
      rewritten: true,
      packMapped: true,
    });
  });

  it("leaves a query-only target unchanged", () => {
    const result = rewriteRelativeLink({
      sourceFileRel: "main.md",
      packFileRel: "main.md",
      target: "?q=1",
    });
    expect(result.rewritten).toBe(false);
    expect(result.packMapped).toBe(true);
  });

  it("rewrites a directory self-link to dot", () => {
    const result = rewriteRelativeLink({
      sourceFileRel: "content/coding/coding.md",
      packFileRel: "coding/coding.md",
      target: "./",
    });
    expect(result.packMapped).toBe(true);
    expect(result.next === "." || result.next === "./").toBe(true);
  });

  it("treats a parent-escape above the repo root as unmapped", () => {
    const result = rewriteRelativeLink({
      sourceFileRel: "main.md",
      packFileRel: "main.md",
      target: "../../outside.md",
    });
    expect(result.packMapped).toBe(false);
    expect(result.rewritten).toBe(false);
  });

  it("leaves unshipped targets unchanged and unmapped", () => {
    const refs = rewriteRelativeLink({
      sourceFileRel: "main.md",
      packFileRel: "main.md",
      target: "./REFERENCES.md",
    });
    expect(refs).toEqual({ next: "./REFERENCES.md", rewritten: false, packMapped: false });

    const project = rewriteRelativeLink({
      sourceFileRel: "content/coding/coding.md",
      packFileRel: "coding/coding.md",
      target: "../../PROJECT.md",
    });
    expect(project.packMapped).toBe(false);
    expect(project.rewritten).toBe(false);
  });

  it("preserves a trailing slash on directory targets and skips URLs", () => {
    const dir = rewriteRelativeLink({
      sourceFileRel: "main.md",
      packFileRel: "main.md",
      target: "./content/templates/",
    });
    expect(dir.next).toBe("./templates/");
    const url = rewriteRelativeLink({
      sourceFileRel: "main.md",
      packFileRel: "main.md",
      target: "https://vbrief.org",
    });
    expect(url).toEqual({ next: "https://vbrief.org", rewritten: false, packMapped: true });
  });

  it("preserves fragments", () => {
    const result = rewriteRelativeLink({
      sourceFileRel: "main.md",
      packFileRel: "main.md",
      target: "./content/UPGRADING.md#frozen-pre-v020-document-model-migration-2068",
    });
    expect(result.next).toBe("./UPGRADING.md#frozen-pre-v020-document-model-migration-2068");
  });
});

describe("rewriteMarkdownDepositLinks (#3937)", () => {
  it("inserts the marker at the top when a leading HTML comment is unclosed", () => {
    const { content, rewriteCount } = rewriteMarkdownDepositLinks({
      content: "<!-- not closed\nSee [coding](./content/coding/coding.md).\n",
      sourceFileRel: "main.md",
      packFileRel: "main.md",
    });
    expect(rewriteCount).toBe(1);
    expect(content.startsWith(REWRITE_MARKER_PREFIX)).toBe(true);
  });

  it("does not restamp a file that already carries the rewrite marker", () => {
    const first = rewriteMarkdownDepositLinks({
      content: "See [coding](./content/coding/coding.md).\n",
      sourceFileRel: "main.md",
      packFileRel: "main.md",
    });
    const second = rewriteMarkdownDepositLinks({
      content: first.content,
      sourceFileRel: "main.md",
      packFileRel: "main.md",
    });
    expect(second.rewriteCount).toBe(0);
    expect(second.content).toBe(first.content);
    expect(first.content.split(REWRITE_MARKER_PREFIX).length - 1).toBe(1);
  });

  it("rewrites links and stamps an attested marker", () => {
    const { content, rewriteCount } = rewriteMarkdownDepositLinks({
      content: "See [coding](./content/coding/coding.md).\n",
      sourceFileRel: "main.md",
      packFileRel: "main.md",
    });
    expect(rewriteCount).toBe(1);
    expect(content).toContain("](./coding/coding.md)");
    expect(content).toContain(REWRITE_MARKER_PREFIX);
    expect(content).toContain('source="main.md"');
    expect(content).not.toContain("./content/coding");
  });

  it("is a no-op when every link already matches the deposit layout or is unmapped", () => {
    const source = "See [missing](./REFERENCES.md).\n";
    const { content, rewriteCount } = rewriteMarkdownDepositLinks({
      content: source,
      sourceFileRel: "main.md",
      packFileRel: "main.md",
    });
    expect(rewriteCount).toBe(0);
    expect(content).toBe(source);
  });
});
