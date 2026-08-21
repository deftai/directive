import { describe, expect, it } from "vitest";
import { captureLiteralAcceptanceCommandsDetailed } from "./capture.js";

/**
 * Leftover of #3572 after the 0.105.0 advisory demotion: markdown blockquote
 * `>` is not a shell prompt. Dollar-sign prompts stay.
 *
 * Fixture is the ProjectMON#103 SLizard finding as ingested into Overview.
 */

const PROJECTMON_103_SLIZARD_BLOCKQUOTE =
  '> **P2** (50% confidence) — User/data-derived value `escapeCell(to)` interpolated into markdown bullet without newline sanitization — embedded `\\n` breaks out of the bullet and renders as a new block (CWE-116). Apply `.replace(/\\r?\\n/g, " ")` before embedding.';

describe("markdown blockquote is not a prompt (#3572 leftover)", () => {
  it("does not capture or reject the ProjectMON#103 SLizard blockquote as prompt@", () => {
    const detailed = captureLiteralAcceptanceCommandsDetailed(
      `${PROJECTMON_103_SLIZARD_BLOCKQUOTE}\n$ task check`,
    );
    const allText = [
      ...detailed.commands.map((c) => c.command),
      ...detailed.rejected.map((r) => r.command),
    ];
    expect(allText.some((text) => text.includes("escapeCell(to)"))).toBe(false);
    expect(detailed.rejected.some((r) => (r.sourceSpan ?? "").startsWith("prompt@"))).toBe(false);

    const taskCheck = detailed.commands.find((c) => c.command === "task check");
    expect(taskCheck).toBeDefined();
    expect(taskCheck?.sourceSpan).toMatch(/^prompt@L/);
  });

  it("does not treat a greater-than line as a prompt while dollar-sign still captures", () => {
    const detailed = captureLiteralAcceptanceCommandsDetailed("> task check\n$ task doctor");
    expect(detailed.commands.map((c) => c.command)).toEqual(["task doctor"]);
    expect(detailed.commands[0]?.sourceSpan).toMatch(/^prompt@L/);
    expect(detailed.rejected.some((r) => (r.sourceSpan ?? "").startsWith("prompt@"))).toBe(false);
  });
});
