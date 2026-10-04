import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyKillHostStatus,
  DEFAULT_KILL_ATTESTATION_TTL_SECONDS,
  evaluateKillAttestation,
  parseKillAttestationFile,
  writeKillAttestation,
} from "./subagent-kill-attestation.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "kill-attest-"));
  temps.push(root);
  return root;
}

describe("subagent kill attestation (#5281)", () => {
  it("pins a numeric short TTL (S1)", () => {
    expect(DEFAULT_KILL_ATTESTATION_TTL_SECONDS).toBe(Number("600"));
  });

  it("classifies host status without treating heartbeat words as terminal", () => {
    expect(classifyKillHostStatus("running")).toBe("running");
    expect(classifyKillHostStatus("completed")).toBe("terminal");
    expect(classifyKillHostStatus("STALE")).toBe("unknown");
    expect(classifyKillHostStatus("REDISPATCH_OK")).toBe("unknown");
  });

  it("refuses bare kill without attestation", () => {
    const dir = join(tempDir(), "attest");
    const verdict = evaluateKillAttestation({
      agentId: "child-1",
      writerId: "parent-1",
      attestationDir: dir,
      hostStatus: "running",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.refuse_reason).toBe("missing-attestation");
  });

  it("allows green equivalent attestation (note) when writer matches", () => {
    const dir = join(tempDir(), "attest");
    writeKillAttestation(dir, {
      agentId: "child-1",
      writerId: "parent-1",
      kind: "note",
    });
    const verdict = evaluateKillAttestation({
      agentId: "child-1",
      writerId: "parent-1",
      attestationDir: dir,
      hostStatus: "running",
    });
    expect(verdict).toMatchObject({
      ok: true,
      clear_reason: "equivalent-attestation",
    });
  });

  it("peer writer uses the same attestation gate as parent", () => {
    const dir = join(tempDir(), "attest");
    writeKillAttestation(dir, {
      agentId: "child-1",
      writerId: "peer-2",
      kind: "correction",
    });
    expect(
      evaluateKillAttestation({
        agentId: "child-1",
        writerId: "peer-2",
        attestationDir: dir,
        hostStatus: "running",
      }).ok,
    ).toBe(true);
    expect(
      evaluateKillAttestation({
        agentId: "child-1",
        writerId: "other-peer",
        attestationDir: dir,
        hostStatus: "running",
      }).refuse_reason,
    ).toBe("writer-mismatch");
  });

  it("force requires non-empty reason", () => {
    const dir = join(tempDir(), "attest");
    expect(
      evaluateKillAttestation({
        agentId: "child-1",
        writerId: "parent-1",
        attestationDir: dir,
        hostStatus: "running",
        force: true,
        forceReason: "",
      }).refuse_reason,
    ).toBe("force-missing-reason");
    const ok = evaluateKillAttestation({
      agentId: "child-1",
      writerId: "parent-1",
      attestationDir: dir,
      hostStatus: "running",
      force: true,
      forceReason: "stuck after REDISPATCH_OK cancel",
    });
    expect(ok).toMatchObject({
      ok: true,
      clear_reason: "force",
      printed_force_reason: "stuck after REDISPATCH_OK cancel",
    });
  });

  it("force attestation kind requires reason, writer match, and prints it", () => {
    const dir = join(tempDir(), "attest");
    expect(
      writeKillAttestation(dir, {
        agentId: "child-1",
        writerId: "parent-1",
        kind: "force",
      }).ok,
    ).toBe(false);
    expect(
      writeKillAttestation(dir, {
        agentId: "child-1",
        writerId: "parent-1",
        kind: "force",
      }).error,
    ).toMatch(/reason/);
    expect(
      writeKillAttestation(dir, {
        agentId: "child-1",
        writerId: "parent-1",
        kind: "force",
        reason: "operator force after hung child",
      }).ok,
    ).toBe(true);
    expect(
      evaluateKillAttestation({
        agentId: "child-1",
        writerId: "different-killer",
        attestationDir: dir,
        hostStatus: "running",
      }).refuse_reason,
    ).toBe("writer-mismatch");
    const verdict = evaluateKillAttestation({
      agentId: "child-1",
      writerId: "parent-1",
      attestationDir: dir,
      hostStatus: "running",
    });
    expect(verdict).toMatchObject({
      ok: true,
      clear_reason: "force",
      printed_force_reason: "operator force after hung child",
    });
  });

  it("rejects hand-authored attestation with unbounded lifetime", () => {
    const dir = join(tempDir(), "attest-ttl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "child-1.json"),
      `${JSON.stringify(
        {
          schema: "deft.subagent.kill-attestation.v1",
          agent_id: "child-1",
          writer_id: "parent-1",
          kind: "note",
          created_at: "2026-01-01T00:00:00Z",
          expires_at: "2027-01-01T00:00:00Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const parsed = parseKillAttestationFile(join(dir, "child-1.json"));
    expect(parsed.record).toBeNull();
    expect(parsed.failures.join(" ")).toMatch(/lifetime/i);
  });

  it("terminal host status allows without attestation", () => {
    const dir = join(tempDir(), "attest");
    const verdict = evaluateKillAttestation({
      agentId: "child-1",
      writerId: "parent-1",
      attestationDir: dir,
      hostStatus: "terminal",
    });
    expect(verdict).toMatchObject({ ok: true, clear_reason: "host-terminal" });
  });

  it("prefers tip pre-cancel green seam when provided", () => {
    const dir = join(tempDir(), "attest");
    const verdict = evaluateKillAttestation({
      agentId: "child-1",
      writerId: "parent-1",
      attestationDir: dir,
      hostStatus: "running",
      evaluatePreCancelGreen: () => true,
    });
    expect(verdict).toMatchObject({ ok: true, clear_reason: "pre-cancel-green" });
  });

  it("expires attestation past TTL", () => {
    const dir = join(tempDir(), "attest");
    const createdAt = new Date("2026-01-01T00:00:00Z");
    writeKillAttestation(dir, {
      agentId: "child-1",
      writerId: "parent-1",
      kind: "note",
      createdAt,
      ttlSeconds: 60,
    });
    const verdict = evaluateKillAttestation({
      agentId: "child-1",
      writerId: "parent-1",
      attestationDir: dir,
      hostStatus: "running",
      now: new Date("2026-01-01T00:05:00Z"),
    });
    expect(verdict.refuse_reason).toBe("expired-attestation");
  });
});
