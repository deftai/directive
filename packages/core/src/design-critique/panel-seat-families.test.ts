import { describe, expect, it } from "vitest";
import {
  evaluatePanelSeatComposition,
  PASTE_READY_FIRST_REMEDIATION,
  SAME_FAMILY_REMEDIATION,
  type ClaimedSeat,
} from "./panel-seat-families.js";

const GROK_CLAUDE_CODEX: readonly ClaimedSeat[] = [
  { family: "grok", launcher: "spawn_subagent" },
  { family: "claude", launcher: "claude" },
  { family: "codex", launcher: "codex" },
];

describe("evaluatePanelSeatComposition (#4067)", () => {
  it("accepts three claimed families with CLI launchers when claude and codex resolve", () => {
    const result = evaluatePanelSeatComposition({
      claimedSeats: GROK_CLAUDE_CODEX,
      path: { claude: true, codex: true },
    });
    expect(result).toEqual({ ok: true });
  });

  it("refuses a same-family N>=3 sibling set and prints re-seat, not wait for Stop 5", () => {
    const result = evaluatePanelSeatComposition({
      claimedSeats: [
        { family: "grok", launcher: "spawn_subagent" },
        { family: "grok", launcher: "spawn_subagent" },
        { family: "grok", launcher: "spawn_subagent" },
      ],
      path: { claude: true, codex: true },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("same-family");
    expect(result.remediation).toBe(SAME_FAMILY_REMEDIATION);
    expect(result.remediation).toContain("re-seat");
    expect(result.remediation.toLowerCase()).toContain("do not wait for stop 5");
  });

  it("refuses N>=3 when claimed families are missing", () => {
    const result = evaluatePanelSeatComposition({
      claimedSeats: [
        { family: "", launcher: "spawn_subagent" },
        { family: "  ", launcher: "claude" },
        { family: "codex", launcher: "codex" },
      ],
      path: { claude: true, codex: true },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing-families");
    expect(result.remediation).toBe(SAME_FAMILY_REMEDIATION);
  });

  it("Grok parent + PATH claude/codex is not paste-ready-first for the other two seats", () => {
    const result = evaluatePanelSeatComposition({
      claimedSeats: [
        { family: "grok", launcher: "spawn_subagent" },
        { family: "claude", launcher: "paste-ready" },
        { family: "codex", launcher: "paste-ready" },
      ],
      path: { claude: true, codex: true },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("paste-ready-first");
    expect(result.remediation).toBe(PASTE_READY_FIRST_REMEDIATION);
  });

  it("refuses paste-ready-first for a Codex seat when only that CLI is the miss", () => {
    const result = evaluatePanelSeatComposition({
      claimedSeats: [
        { family: "grok", launcher: "spawn_subagent" },
        { family: "claude", launcher: "claude" },
        { family: "codex", launcher: "paste-ready" },
      ],
      path: { claude: true, codex: true },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("paste-ready-first");
  });

  it("allows paste-ready when the named family's CLI is absent", () => {
    const result = evaluatePanelSeatComposition({
      claimedSeats: [
        { family: "grok", launcher: "spawn_subagent" },
        { family: "claude", launcher: "paste-ready" },
        { family: "codex", launcher: "paste-ready" },
      ],
      path: { claude: false, codex: false },
    });
    expect(result).toEqual({ ok: true });
  });

  it("does not require three families for N=1", () => {
    const result = evaluatePanelSeatComposition({
      claimedSeats: [{ family: "grok", launcher: "spawn_subagent" }],
      path: { claude: true, codex: true },
    });
    expect(result).toEqual({ ok: true });
  });

  it("does not classify families from model slugs", () => {
    const result = evaluatePanelSeatComposition({
      claimedSeats: [
        { family: "grok", launcher: "spawn_subagent" },
        { family: "claude", launcher: "claude" },
        { family: "codex", launcher: "codex" },
      ],
      path: { claude: true, codex: true },
    });
    expect(result).toEqual({ ok: true });
    const lied = evaluatePanelSeatComposition({
      claimedSeats: [
        { family: "grok", launcher: "spawn_subagent" },
        { family: "grok", launcher: "spawn_subagent" },
        { family: "grok", launcher: "spawn_subagent" },
      ],
      path: { claude: true, codex: true },
    });
    expect(lied.ok).toBe(false);
    if (lied.ok) return;
    expect(lied.code).toBe("same-family");
  });
});
