import { describe, expect, it } from "vitest";
import {
  findAcHeading,
  parseCheckboxItems,
  parseListItems,
  sliceAcSection,
  stripCodeBlocks,
} from "./markdown-scanners.js";

describe("stripCodeBlocks", () => {
  it("removes fenced and inline code", () => {
    const body = "Closes #1 in prose\n```\nCloses #99\n```\n`Closes #2` ok";
    expect(stripCodeBlocks(body)).toBe("Closes #1 in prose\n\n ok");
  });
});

describe("parseCheckboxItems", () => {
  it("parses task list lines", () => {
    const text = "- [ ] todo\n- [x] done\n  not a checkbox";
    expect(parseCheckboxItems(text)).toEqual([
      { title: "todo", status: "proposed" },
      { title: "done", status: "completed" },
    ]);
  });
});

describe("AC section fallback", () => {
  it("extracts numbered items under heading", () => {
    const text = "## Acceptance Criteria\n1. first\n2. second\n## Other";
    const heading = findAcHeading(text);
    expect(heading).not.toBeNull();
    const section = sliceAcSection(text, heading as NonNullable<typeof heading>);
    expect(parseListItems(section).map((i) => i.title)).toEqual(["first", "second"]);
  });
});
