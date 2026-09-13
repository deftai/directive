import { describe, expect, it } from "vitest";
import {
  BENIGN_PONG_PROMPT,
  type ClaimedSeat,
  evaluateN3LaunchProbe,
  evaluatePanelSeatComposition,
  PASTE_READY_FIRST_REMEDIATION,
  SAME_FAMILY_REMEDIATION,
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

  it("does not observe launchability: PATH plus claimed families can pass while the probe fails (#4432)", () => {
    const composition = evaluatePanelSeatComposition({
      claimedSeats: GROK_CLAUDE_CODEX,
      path: { claude: true, codex: true },
    });
    expect(composition).toEqual({ ok: true });
    const probe = evaluateN3LaunchProbe({
      spendN: 3,
      argvClass: "critic-bypass",
      prompt: BENIGN_PONG_PROMPT,
      envelopePath: null,
      threadAccess: false,
      launchableFamilies: ["claude"],
      onFail: "amend-spend",
    });
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.code).toBe("not-launchable");
    expect(probe.recovery).toBe("amend-spend");
    expect(probe.haltToken).toBeNull();
  });
});

describe("evaluateN3LaunchProbe (#4432)", () => {
  const launchable = ["grok", "claude", "codex"];
  const valid = {
    spendN: 3,
    argvClass: "critic-bypass",
    prompt: BENIGN_PONG_PROMPT,
    envelopePath: null,
    threadAccess: false,
    launchableFamilies: launchable,
    onFail: "dispatch-fail",
  };

  it("does not require a probe for N=1", () => {
    expect(
      evaluateN3LaunchProbe({
        ...valid,
        spendN: 1,
        argvClass: "auth-pong",
        launchableFamilies: ["claude"],
      }),
    ).toEqual({ ok: true });
  });

  it("accepts N>=3 when the benign pong uses critic bypass flags and three families launch", () => {
    expect(evaluateN3LaunchProbe(valid)).toEqual({ ok: true });
  });

  it("refuses the auth pong without bypass flags", () => {
    const result = evaluateN3LaunchProbe({ ...valid, argvClass: "auth-pong" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("probe-invalid");
    expect(result.recovery).toBe("dispatch-fail");
    expect(result.haltToken).toBe("dispatch-fail");
  });

  it("does not let an invalid envelope probe inherit amend-spend", () => {
    const result = evaluateN3LaunchProbe({
      ...valid,
      envelopePath: "dest/envelope.md",
      onFail: "amend-spend",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("probe-invalid");
    expect(result.recovery).toBe("dispatch-fail");
    expect(result.haltToken).toBe("dispatch-fail");
  });

  it("refuses an envelope path or Read-and-follow prompt", () => {
    const withPath = evaluateN3LaunchProbe({
      ...valid,
      envelopePath: "dest/envelope.md",
    });
    expect(withPath.ok).toBe(false);
    if (withPath.ok) return;
    expect(withPath.code).toBe("probe-invalid");
    const withPrompt = evaluateN3LaunchProbe({
      ...valid,
      prompt: "Read and follow dest/envelope.md",
    });
    expect(withPrompt.ok).toBe(false);
    if (withPrompt.ok) return;
    expect(withPrompt.code).toBe("probe-invalid");
  });

  it("refuses thread access", () => {
    const result = evaluateN3LaunchProbe({ ...valid, threadAccess: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("probe-invalid");
  });

  it("records amend-spend or dispatch-fail and does not emit a new halt token", () => {
    const amend = evaluateN3LaunchProbe({
      ...valid,
      launchableFamilies: ["claude"],
      onFail: "amend-spend",
    });
    expect(amend.ok).toBe(false);
    if (amend.ok) return;
    expect(amend.recovery).toBe("amend-spend");
    expect(amend.haltToken).toBeNull();
    const halt = evaluateN3LaunchProbe({
      ...valid,
      launchableFamilies: ["claude"],
      onFail: "dispatch-fail",
    });
    expect(halt.ok).toBe(false);
    if (halt.ok) return;
    expect(halt.recovery).toBe("dispatch-fail");
    expect(halt.haltToken).toBe("dispatch-fail");
    expect(halt.haltToken).not.toBe("unreachable-launcher");
  });
});
