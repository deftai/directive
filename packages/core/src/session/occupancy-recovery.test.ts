import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHostSessionId } from "./host-session-owner.js";
import {
  applyWorktreeOccupancy,
  evaluateOccupancyCeremonyEligibility,
  formatOccupancyRemediation,
  type OccupancyCeremonyEligibility,
  occupancyPath,
  readOccupancy,
  resolveOccupancyLeaseRoot,
  stealOccupancy,
} from "./occupancy.js";
import {
  applyOccupancyEligibilityToDenial,
  formatCeremonyRecoveryAfterOccupancySteal,
  formatOccupancyAwareRitualRecovery,
  occupancyAwareDenialMessage,
  SHELL_COVERAGE_HONESTY,
} from "./occupancy-recovery.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function admitted(): OccupancyCeremonyEligibility {
  return {
    admitCeremony: true,
    occupancyCase: "absent",
    sessionId: "solo",
    occupantId: null,
    restrictedPrimary: false,
    denialMessage: null,
  };
}

function refused(
  overrides: Partial<OccupancyCeremonyEligibility> = {},
): OccupancyCeremonyEligibility {
  return {
    admitCeremony: false,
    occupancyCase: "restricted-primary",
    sessionId: "solo",
    occupantId: null,
    restrictedPrimary: true,
    denialMessage:
      "occupancy refuses a mutation claim on the primary checkout. " +
      "Run `deft session:start --primary-claim-exception=operator-default-branch --session-id=solo`.",
    ...overrides,
  };
}

describe("occupancy-aware ritual recovery (#4290)", () => {
  it("admits session:ready and names shell coverage", () => {
    const text = formatOccupancyAwareRitualRecovery(admitted(), "rearm");
    expect(text).toContain("session:ready");
    expect(text).toContain("one-shot");
    expect(text).toContain(SHELL_COVERAGE_HONESTY);
  });

  it("strips embedded ritual commands from the whole denial, not only the suffix", () => {
    const whole =
      "Directive denied Write: stale. Run `deft session:start --rearm` to re-arm " +
      "(or `deft session:start` for a full cold ceremony). " +
      "Recovery: run `deft session:ready` (one-shot).";
    const rewritten = applyOccupancyEligibilityToDenial(whole, refused(), "rearm");
    expect(rewritten).not.toMatch(/session:ready/);
    expect(rewritten).not.toMatch(/session:start --rearm/);
    expect(rewritten).toContain("primary-claim-exception=operator-default-branch");
    expect(rewritten).toContain(SHELL_COVERAGE_HONESTY);
  });

  it("keeps the trusted exception command and the cache-fresh defer form", () => {
    const text =
      "Use `deft session:start --primary-claim-exception=operator-default-branch`. " +
      "Soft path (audited): `deft session:start -- --defer cache_fresh=<reason>`.";
    const rewritten = applyOccupancyEligibilityToDenial(text, refused(), "cold");
    expect(rewritten).toContain("primary-claim-exception=operator-default-branch");
    expect(rewritten).toContain("session:start -- --defer cache_fresh=<reason>");
  });

  it("does not duplicate session:ready when the one-shot recovery is already present", () => {
    const message =
      "step failed. Recovery: run `deft session:ready` (one-shot: session:start + gated ritual).";
    const rewritten = applyOccupancyEligibilityToDenial(message, admitted(), "cold");
    expect(rewritten.match(/session:ready/g)?.length).toBe(1);
    expect(rewritten).toContain(SHELL_COVERAGE_HONESTY);
  });

  it("formats refuse-mint with empty denial as shell honesty only", () => {
    const text = formatOccupancyAwareRitualRecovery(
      refused({ denialMessage: null, occupancyCase: "refuse-mint" }),
      "cold",
    );
    expect(text).toBe(SHELL_COVERAGE_HONESTY);
  });

  it("preserves minted-identity session:start --session-id recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-rec-mint-"));
    temps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    const now = new Date("2026-09-23T12:00:00Z");
    applyWorktreeOccupancy(root, {
      env: {},
      newSessionId: () => "minted-uuid",
      now,
      intent: "mutation",
    });
    const record = readOccupancy(root);
    expect(record?.identityProvenance).toBe("minted");
    const claudeRaw = "01a0a66a-9b86-7423-82f9-98d97cf5b099";
    const claudeOwner = canonicalHostSessionId("claude", claudeRaw);
    const env = {
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: claudeRaw,
    };
    const remediation = formatOccupancyRemediation(
      record as NonNullable<typeof record>,
      now,
      "stranger",
      env,
    );
    expect(remediation).toContain(`session:start --session-id=${claudeOwner}`);
    const eligibility = evaluateOccupancyCeremonyEligibility(root, {
      sessionId: "stranger",
      now,
      env,
    });
    const whole =
      "Directive denied Write: stale. Run `deft session:start --rearm` to re-arm " +
      "(or `deft session:start` for a full cold ceremony). " +
      "Recovery: run `deft session:ready` (one-shot). " +
      remediation.replaceAll(
        `session:start --session-id=${claudeOwner}`,
        `deft session:start --session-id=${claudeOwner}`,
      );
    const rewritten = applyOccupancyEligibilityToDenial(whole, eligibility, "rearm");
    expect(rewritten).toContain(`session:start --session-id=${claudeOwner}`);
    expect(rewritten).not.toMatch(/host-published owner \(\)/);
    expect(rewritten).not.toMatch(/session:ready/);
    expect(rewritten).not.toMatch(/session:start --rearm/);
  });

  it("occupancyAwareDenialMessage admits a vacant uncontended tree", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-rec-"));
    temps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    const text = occupancyAwareDenialMessage(
      root,
      "session ritual state is stale (older than 4h).",
      { sessionId: "solo" },
      "rearm",
    );
    expect(text).toContain("session:ready");
    expect(text).toContain(SHELL_COVERAGE_HONESTY);
  });

  it("names target root, presenter, lease op, and ceremony after minted+host steal (#5544 P3)", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-rec-5544-"));
    temps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    const now = new Date("2026-10-16T12:00:00Z");
    applyWorktreeOccupancy(root, {
      env: {},
      newSessionId: () => "minted-uuid",
      now,
      intent: "mutation",
    });
    const hostId = canonicalHostSessionId("claude", "ceremony-after-steal");
    const stolen = stealOccupancy(root, {
      sessionId: hostId,
      occupant: "minted-uuid",
      confirm: true,
      now: new Date("2026-10-16T12:01:00Z"),
    });
    expect(stolen.action).toBe("stolen");
    expect(stolen.message).toContain("Required ceremony:");
    expect(stolen.message).toContain("Target root:");
    const ceremony = formatCeremonyRecoveryAfterOccupancySteal({
      projectRoot: root,
      presenterSessionId: hostId,
      tier: "cold",
    });
    expect(ceremony).toContain(`target root=${resolveOccupancyLeaseRoot(root)}`);
    expect(ceremony).toContain(`presenter=${hostId}`);
    expect(ceremony).toContain("permitted lease operation=occupancy:steal");
    expect(ceremony).toContain("required ceremony=");
    expect(ceremony).toContain(`occupancyFile=${occupancyPath(resolveOccupancyLeaseRoot(root))}`);
    expect(ceremony).toContain(SHELL_COVERAGE_HONESTY);
    const rewritten = applyOccupancyEligibilityToDenial(
      `Directive denied Write: ritual ownership mismatch. ${ceremony}`,
      {
        admitCeremony: false,
        occupancyCase: "live-foreign-owner",
        sessionId: hostId,
        occupantId: hostId,
        restrictedPrimary: false,
        denialMessage: ceremony,
      },
      "cold",
    );
    expect(rewritten).toContain("Ceremony recovery after occupancy:steal");
    expect(rewritten).not.toMatch(/session:ready/);
  });
});
