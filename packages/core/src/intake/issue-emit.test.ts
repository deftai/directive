import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addGithubIssueReference,
  existingGithubIssueRef,
  loadVbrief,
  renderIssueBody,
  renderUmbrellaBody,
  vbriefTitle,
  writeVbrief,
} from "./issue-emit.js";

describe("issue-emit helpers", () => {
  it("renders issue body sections", () => {
    const body = renderIssueBody({
      plan: {
        title: "T",
        narratives: { Description: "Desc", Acceptance: "Ship it" },
        items: [{ title: "AC1", narrative: { Acceptance: "done" } }],
      },
    });
    expect(body).toContain("## Description");
    expect(body).toContain("## Acceptance");
  });

  it("detects existing github issue ref", () => {
    const data = {
      plan: {
        references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
    };
    expect(existingGithubIssueRef(data)).toBe("https://github.com/o/r/issues/1");
  });

  it("writes reference back to vbrief", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-"));
    const path = join(dir, "x.vbrief.json");
    writeVbrief(path, { plan: { title: "Hello" } });
    const data = loadVbrief(path);
    addGithubIssueReference(data, "https://github.com/o/r/issues/9");
    writeVbrief(path, data);
    expect(existingGithubIssueRef(loadVbrief(path))).toBe("https://github.com/o/r/issues/9");
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders umbrella checklist", () => {
    const body = renderUmbrellaBody([["path/a.json", { plan: { title: "One" } }]]);
    expect(body).toContain("## Tracked vBRIEFs");
    expect(body).toContain("- [ ] One");
  });

  it("falls back vbrief title", () => {
    expect(vbriefTitle({})).toBe("Untitled vBRIEF");
  });
});
