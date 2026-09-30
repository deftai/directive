/**
 * Prefer-A pins for setup Phase 2 completion + persisted planning narratives (#5176).
 */
import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

const SETUP_SKILL = "skills/deft-directive-setup/SKILL.md";

function packedSetupBody(): string {
  const pack = JSON.parse(readRepoFile("packs/skills/skills-pack-0.1.json")) as {
    skills: Array<{ id: string; body: string }>;
  };
  const setup = pack.skills.find((skill) => skill.id === "deft-directive-setup");
  if (setup === undefined) throw new Error("deft-directive-setup pack entry missing");
  return setup.body;
}

function phase2(text: string): string {
  const start = text.indexOf("## Phase 2");
  const end = text.indexOf("## Phase 3");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("setup persisted planning narratives (#5176 Prefer-A)", () => {
  for (const [surface, text] of [
    ["packed", packedSetupBody()],
    ["rendered", readRepoFile(SETUP_SKILL)],
  ] as const) {
    it(`${surface} Phase 2 completion requires verify:persisted-planning-narratives`, () => {
      const section = phase2(text);
      expect(section).toContain("deft verify:persisted-planning-narratives");
      expect(section).toContain("all four postconditions");
      expect(section).toContain("project:write-narratives");
      expect(section).toContain("DCR R.4668");
      expect(section).toContain("agent.setup_answers_persisted_in_pd");
      expect(section).toContain(
        "Complete Phase 2 while Overview and tech stack (and DCR-equivalent tracked bag) are all empty / whitespace (#5176)",
      );
    });
  }
});
