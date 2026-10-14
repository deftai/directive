import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { revokeGrant } from "./actions.js";
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

  it("renewed grant replaces a revoked prior admission for the same attempt", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const baseSha = "4".repeat(40);
    const headSha = "5".repeat(40);
    const treeHash = "6".repeat(40);
    const first = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: "attempt-renew",
      baseSha,
      headSha,
      treeHash,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const admitted = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId: "attempt-renew",
      observedRefuseReason: "unknown path",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(revokeGrant({ projectRoot: root, grantId: first.grant.id }).ok).toBe(true);

    const renewed = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: "attempt-renew",
      baseSha,
      headSha,
      treeHash,
    });
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    const readmit = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId: "attempt-renew",
      observedRefuseReason: "unknown path",
    });
    expect(readmit.ok).toBe(true);
    if (!readmit.ok) return;
    expect(readmit.reused).toBe(false);
    expect(readmit.receipt.grantId).toBe(renewed.grant.id);

    // Second admit after successful renew reuses the live receipt (no double-spend).
    const reuse = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId: "attempt-renew",
      observedRefuseReason: "unknown path",
    });
    expect(reuse.ok).toBe(true);
    if (!reuse.ok) return;
    expect(reuse.reused).toBe(true);
    expect(reuse.receipt.grantId).toBe(renewed.grant.id);
  });

  it("reclaims a dead attempt lock so admit can resume", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const baseSha = "7".repeat(40);
    const headSha = "8".repeat(40);
    const treeHash = "9".repeat(40);
    const attemptId = "attempt-dead-lock";
    const minted = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: attemptId,
      baseSha,
      headSha,
      treeHash,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const safe = createHash("sha256").update(attemptId, "utf8").digest("hex");
    const lockDir = join(root, ".deft", "authz", "locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, `gate-override-admit-${safe}.lock`),
      `${JSON.stringify({
        pid: 2_147_483_647,
        startedAt: new Date().toISOString(),
        token: "dead-holder",
      })}\n`,
      "utf8",
    );

    const admitted = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId,
      observedRefuseReason: "unknown path",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.reused).toBe(false);
    expect(admitted.receipt.grantId).toBe(minted.grant.id);
  });

  it("does not reclaim a recent empty attempt lock (in-flight owner publish)", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const baseSha = "1".repeat(40);
    const headSha = "2".repeat(40);
    const treeHash = "3".repeat(40);
    const attemptId = "attempt-empty-lock";
    const minted = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: attemptId,
      baseSha,
      headSha,
      treeHash,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const safe = createHash("sha256").update(attemptId, "utf8").digest("hex");
    const lockDir = join(root, ".deft", "authz", "locks");
    mkdirSync(lockDir, { recursive: true });
    // Empty final path mimics an in-flight exclusive publish before owner body lands.
    writeFileSync(join(lockDir, `gate-override-admit-${safe}.lock`), "", "utf8");

    const admitted = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId,
      observedRefuseReason: "unknown path",
    });
    expect(admitted.ok).toBe(false);
    if (admitted.ok) return;
    expect(admitted.code).toBe("claim-failed");
    expect(admitted.reason).toMatch(/reserved by a concurrent admit\/renew/i);
  });

  it("reclaims a stale empty attempt lock after the age gate", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const treeHash = "c".repeat(40);
    const attemptId = "attempt-stale-empty-lock";
    const minted = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: attemptId,
      baseSha,
      headSha,
      treeHash,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const safe = createHash("sha256").update(attemptId, "utf8").digest("hex");
    const lockDir = join(root, ".deft", "authz", "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, `gate-override-admit-${safe}.lock`);
    writeFileSync(lockPath, "", "utf8");
    const staleMs = Date.now() - Number("60000");
    utimesSync(lockPath, new Date(staleMs), new Date(staleMs));

    const admitted = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId,
      observedRefuseReason: "unknown path",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.reused).toBe(false);
    expect(admitted.receipt.grantId).toBe(minted.grant.id);
  });

  it("recovers an incomplete admission receipt under the attempt lock", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const baseSha = "4".repeat(40);
    const headSha = "5".repeat(40);
    const treeHash = "6".repeat(40);
    const attemptId = "attempt-incomplete-receipt";
    const minted = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: attemptId,
      baseSha,
      headSha,
      treeHash,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const safe = createHash("sha256").update(attemptId, "utf8").digest("hex");
    const admissionsDir = join(root, ".deft", "authz", "gate-override-admissions");
    mkdirSync(admissionsDir, { recursive: true });
    writeFileSync(join(admissionsDir, `${safe}.json`), "", "utf8");

    const admitted = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId,
      observedRefuseReason: "unknown path",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.reused).toBe(false);
    expect(admitted.receipt.grantId).toBe(minted.grant.id);
  });

  it("attempt ids a/b and a_b do not share an admission file", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const treeHash = "c".repeat(40);
    const minted = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: "a/b",
      baseSha,
      headSha,
      treeHash,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const first = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId: "a/b",
      observedRefuseReason: "unknown path",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.reused).toBe(false);

    const colliding = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: "a_b",
      baseSha,
      headSha,
      treeHash,
    });
    expect(colliding.ok).toBe(true);
    if (!colliding.ok) return;
    const second = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId: "a_b",
      observedRefuseReason: "unknown path",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reused).toBe(false);
    expect(second.receipt.attemptId).toBe("a_b");
    expect(second.receipt.grantId).not.toBe(first.receipt.grantId);
  });

  it("grant worktree limit binds even when caller omits worktree", () => {
    root = mkdtempSync(join(tmpdir(), "gate-override-"));
    const baseSha = "d".repeat(40);
    const headSha = "e".repeat(40);
    const treeHash = "f".repeat(40);
    const minted = mintGateOverrideTemplateGrant({
      projectRoot: root,
      target: "unknown-path",
      planRef: "attempt-wt",
      baseSha,
      headSha,
      treeHash,
      worktree: "wt-required",
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const without = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId: "attempt-wt",
      observedRefuseReason: "unknown path",
    });
    expect(without.ok).toBe(false);
    const withWt = admitGateOverrideForAttempt(root, {
      refuseCode: "unknown-path",
      baseSha,
      headSha,
      treeHash,
      attemptId: "attempt-wt",
      observedRefuseReason: "unknown path",
      worktree: "wt-required",
    });
    expect(withWt.ok).toBe(true);
  });
});
