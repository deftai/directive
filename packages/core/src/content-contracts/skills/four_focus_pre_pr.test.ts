import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

const SKILL = "skills/deft-directive-pre-pr/SKILL.md";
const FOUR_FOCUS = "skills/deft-directive-pre-pr/references/four-focus.md";

describe("four-focus pre-pr gate", () => {
  it("reference file exists", () => {
    expect(repoFileExists(FOUR_FOCUS)).toBe(true);
  });

  it("skill has Phase 6 four-focus", () => {
    const text = readRepoFile(SKILL);
    expect(text).toContain("## Phase 6 -- Four-focus (A/B/C/D)");
    expect(text).toContain("references/four-focus.md");
    expect(text).toContain("pre-pr-four-focus.rhai");
  });

  it("four-focus table names all four passes", () => {
    const text = readRepoFile(FOUR_FOCUS);
    expect(text).toContain("Acceptance + tests");
    expect(text).toContain("Bug hunt");
    expect(text).toContain("Stealth / secrets / log leaks");
    expect(text).toContain("Regression + extra scope");
  });

  it("output schema requires evidence", () => {
    const text = readRepoFile(FOUR_FOCUS);
    expect(text).toContain("\"evidence\"");
    expect(text).toContain("Drop any finding whose `evidence` is missing or empty");
  });

  it("anti-patterns refuse push without four-focus", () => {
    const skill = readRepoFile(SKILL);
    const ref = readRepoFile(FOUR_FOCUS);
    expect(skill).toContain("Push because RWLDL / `task check` was green if four-focus did not run");
    expect(ref).toContain("Push because RWLDL / `task check` was green if four-focus did not run");
  });

  it("agents-entry and maintainer AGENTS pin four-focus", () => {
    const template = readRepoFile("templates/agents-entry.md");
    const agents = readRepoFile("AGENTS.md");
    expect(template).toContain("four-focus");
    expect(agents).toContain("four-focus");
    expect(template).toContain("skills/deft-directive-pre-pr/references/four-focus.md");
  });

  it("preamble requires four-focus before push", () => {
    const preamble = readRepoFile("templates/agent-prompt-preamble.md");
    expect(preamble).toContain("Phase 6 four-focus");
    expect(preamble).toContain("RWLDL-clean is not push-ready");
  });
});
