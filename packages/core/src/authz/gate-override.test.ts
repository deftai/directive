import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitGateOverrideForAttempt,
  GATE_OVERRIDE_DEFAULT_EXPIRY_HOURS,
  GATE_OVERRIDE_DEFERRED_PEER_GATES,
  GATE_OVERRIDE_ELIGIBLE_REFUSE_CODES,
  GATE_OVERRIDE_GATE_ID,
  GATE_OVERRIDE_NON_OVERRIDABLE_REFUSE_CODES,
  GATE_OVERRIDE_REVIEW_OBLIGATION,
  GATE_OVERRIDE_TEMPLATE_NAME,
  GATE_OVERRIDE_V1_CONSUMERS,
  inspectGateOverrideGrant,
  isGateOverrideEligibleRefuseCode,
  isGateOverrideNonOverridableRefuseCode,
  isGateOverrideTemplateName,
  mintGateOverrideTemplateGrant,
  parseGateOverrideBinding,
} from "./gate-override.js";
import { revokeGrant } from "./actions.js";

describe("gate-override (#5542 Prefer-A Bound)", () => {
  let root = "";

  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("exposes closed template constants and empty deferred peers", () => {
    expect(GATE_OVERRIDE_TEMPLATE_NAME).toBe("gate-override");
    expect(GATE_OVERRIDE_GATE_ID).toBe("coverage-applicability");
    expect(GATE_OVERRIDE_DEFAULT_EXPIRY_HOURS).toBe(Number("8"));
    expect(GATE_OVERRIDE_DEFERRED_PEER_GATES).toEqual([]);
    expect(GATE_OVERRIDE_V1_CONSUMERS).toContain("coverage:hotspots");
    expect(GATE_OVERRIDE_V1_CONSUMERS).toContain("pre-pr:coverage_headroom");
    expect(GATE_OVERRIDE_REVIEW_OBLIGATION).toBe("pre-merge-human-review-required");
    expect(isGateOverrideTemplateName("gate-override")).toBe(true);
    expect(isGateOverrideTemplateName("spec-drift-override")).toBe(false);
    expect(isGateOverrideEligibleRefuseCode("unknown-path")).toBe(true);
    expect(isGateOverrideNonOverridableRefuseCode("tree-mismatch")).toBe(true);
    expect(GATE_OVERRIDE_ELIGIBLE_REFUSE_CODES).not.toContain("tree-mismatch");
    expect(GATE_OVERRIDE_NON_OVERRIDABLE_REFUSE_CODES).toContain("invalid-base");
  });

  it("returns failure for missing binds and non-overridable codes without throwing", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const missingTarget = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "  ",
      planRef: "attempt-1",
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
      treeHash: "t".repeat(40),
    });
    expect(missingTarget.ok).toBe(false);
    if (missingTarget.ok) return;
    expect(missingTarget.reason).toMatch(/--target/);

    const nonOverridable = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "tree-mismatch",
      planRef: "attempt-1",
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
      treeHash: "t".repeat(40),
    });
    expect(nonOverridable.ok).toBe(false);
    if (nonOverridable.ok) return;
    expect(nonOverridable.reason).toMatch(/non-overridable/);

    const ineligible = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "made-up-code",
      planRef: "attempt-1",
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
      treeHash: "t".repeat(40),
    });
    expect(ineligible.ok).toBe(false);
  });

  it("mints operator-cli single-use settings grant with classifier binding surfaces", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const treeHash = "c".repeat(40);
    const minted = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: "attempt-42",
      baseSha,
      headSha,
      treeHash,
      worktree: "wt-1",
      evaluatorId: "coverage-applicability@1",
      actor: "scott",
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.grant.origin.kind).toBe("operator-cli");
    expect(minted.grant.scope.operations).toEqual(["settings"]);
    expect(minted.grant.semantics.singleUse).toBe(true);
    const binding = parseGateOverrideBinding(minted.grant);
    expect(binding).not.toBeNull();
    expect(binding?.refuseCode).toBe("unknown-path");
    expect(binding?.attemptId).toBe("attempt-42");
    expect(binding?.baseSha).toBe(baseSha);
    expect(binding?.treeHash).toBe(treeHash);
    expect(binding?.worktree).toBe("wt-1");
    expect(binding?.evaluatorId).toBe("coverage-applicability@1");
  });

  it("inspect does not consume; admit is one-use and reusable for same attempt", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const baseSha = "d".repeat(40);
    const headSha = "e".repeat(40);
    const treeHash = "f".repeat(40);
    const minted = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "dirty-tree",
      planRef: "attempt-reuse",
      baseSha,
      headSha,
      treeHash,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const binding = {
      refuseCode: "dirty-tree",
      baseSha,
      headSha,
      treeHash,
      attemptId: "attempt-reuse",
    };
    const inspected = inspectGateOverrideGrant(root, binding);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.admission).toBeNull();
    expect(inspected.grant.semantics.usedAt).toBeNull();

    const first = admitGateOverrideForAttempt(root, {
      ...binding,
      observedRefuseReason: "coverage-applicability: dirty working tree",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.reused).toBe(false);
    expect(first.receipt.reviewObligation).toBe(GATE_OVERRIDE_REVIEW_OBLIGATION);
    expect(first.grant.semantics.usedAt).not.toBeNull();

    const inspectAfter = inspectGateOverrideGrant(root, binding);
    expect(inspectAfter.ok).toBe(true);
    if (!inspectAfter.ok) return;
    expect(inspectAfter.admission?.grantId).toBe(first.receipt.grantId);

    const second = admitGateOverrideForAttempt(root, {
      ...binding,
      observedRefuseReason: "coverage-applicability: dirty working tree",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reused).toBe(true);

    const otherAttempt = admitGateOverrideForAttempt(root, {
      ...binding,
      attemptId: "attempt-other",
      observedRefuseReason: "coverage-applicability: dirty working tree",
    });
    expect(otherAttempt.ok).toBe(false);
  });

  it("revocation dominates a prior admission on recheck", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const baseSha = "1".repeat(40);
    const headSha = "2".repeat(40);
    const treeHash = "3".repeat(40);
    const minted = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: "attempt-rev",
      baseSha,
      headSha,
      treeHash,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const admitted = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId: "attempt-rev",
      observedRefuseReason: "unknown path",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    const revoked = revokeGrant({ projectRoot: root, grantId: minted.grant.id });
    expect(revoked.ok).toBe(true);

    const recheck = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId: "attempt-rev",
      observedRefuseReason: "unknown path",
    });
    expect(recheck.ok).toBe(false);
    if (recheck.ok) return;
    expect(recheck.code).toBe("revoked");
  });
});
