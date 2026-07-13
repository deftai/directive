import { describe, expect, it } from "vitest";
import { iterTaskBlocks, normalizeYamlNewlines, readRoot } from "./_taskfile-helpers.js";

describe("normalizeYamlNewlines (#2467)", () => {
  it("collapses CRLF and bare CR to LF", () => {
    expect(normalizeYamlNewlines("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizeYamlNewlines("already\nLF")).toBe("already\nLF");
  });

  it("keeps task section parsing stable under CRLF Taskfiles", () => {
    const yaml = ["version: '3'", "tasks:", "  hello:", "    cmds:", "      - echo hi", ""].join(
      "\r\n",
    );
    const blocks = iterTaskBlocks(yaml);
    expect(blocks.map((b) => b.name)).toEqual(["hello"]);
  });

  it("readRoot returns LF-normalized Taskfile.yml", () => {
    const text = readRoot("Taskfile.yml");
    expect(text.includes("\r")).toBe(false);
    expect(text.length).toBeGreaterThan(0);
  });
});
