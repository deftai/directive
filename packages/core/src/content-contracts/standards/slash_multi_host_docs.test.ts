/**
 * Content contracts for multi-host slash registration docs (#3055 / epic #55 Wave 3).
 */
import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const GUIDE = "docs/slash-multi-host.md";
const COMMANDS = "commands.md";

describe("slash multi-host docs (#3055)", () => {
  it("guide file exists under content docs", () => {
    expect(isFile(GUIDE)).toBe(true);
  });

  it("guide covers multi-host deposit, opt-out, L2 set, prefer-commit, dogfood, #75", () => {
    const text = readText(GUIDE);
    for (const tok of [
      "hostSlashCommands",
      "writeSlashCommandDeposit",
      "exactly 13",
      "Prefer committing",
      "Dogfood checklist",
      "#75",
      ".claude/commands/",
      ".cursor/commands/",
      ".grok/commands/",
      ".codex/prompts/",
      "thin",
      "LockedDecisions",
    ]) {
      expect(text, `guide missing ${tok}`).toContain(tok);
    }
  });

  it("commands.md namespaces section points at native multi-host registration", () => {
    const text = readText(COMMANDS);
    expect(text).toContain("### Native multi-host registration (#55 / #3052–#3055)");
    expect(text).toContain("docs/slash-multi-host.md");
    expect(text).toContain("hostSlashCommands");
    expect(text).toContain("Prefer **committing**");
    expect(text).toMatch(/#75/);
  });
});
