import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killSwitchRecordPath } from "../../policy/kill-switch-record.js";
import { startUatLease } from "../actions.js";
import { armDelegation } from "./arm.js";
import {
  delegationAuditPath,
  delegationLockPath,
  delegationStatePath,
  endDelegation,
  evaluateDelegableMint,
  evaluateDelegatedHookAllow,
  evaluateDelegationLiveness,
  loadDelegationState,
  readDelegationLiveness,
  readLiveDelegation,
  resolveDelegatedCompletion,
  resolveDelegationSecretPath,
  withDelegationLock,
  writeEnrolledSecret,
} from "./store.js";
import { totpCodeForStep, totpStepAt } from "./totp.js";
import {
  DELEGABLE_RELEASE_TEMPLATES,
  DELEGATION_STORE_REL,
  NEVER_DELEGABLE_TEMPLATES,
  NEVER_DELEGABLE_VERBS,
} from "./types.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const T0 = new Date("2026-11-27T12:00:00Z");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function armed(): { root: string; delegationId: string } {
  const root = mkdtempSync(join(tmpdir(), "deleg-store-"));
  roots.push(root);
  const secretPath = join(root, "cfg", "totp-secret.json");
  writeEnrolledSecret(secretPath, { secretBase32: SECRET, enrolledAt: "x", account: "op" }, false);
  const out = armDelegation({
    projectRoot: root,
    storeRoot: root,
    secretPath,
    promptText: `deft delegate on ${totpCodeForStep(SECRET, totpStepAt(T0))}`,
    hostSessionId: "session-A",
    host: "claude",
    now: T0,
  });
  if (out.kind !== "armed") throw new Error(`arm failed: ${out.kind}`);
  return { root, delegationId: out.record.delegationId };
}

const later = new Date(T0.getTime() + 60_000);

describe("delegation store layout", () => {
  it("keeps the store under .deft/authz/delegation and the secret outside the repo", () => {
    expect(DELEGATION_STORE_REL).toBe(".deft/authz/delegation");
    expect(
      resolveDelegationSecretPath({ platform: "win32", environ: { APPDATA: "C:\\U\\AppData" } }),
    ).toBe(join("C:\\U\\AppData", "deft", "delegation", "totp-secret.json"));
    expect(resolveDelegationSecretPath({ platform: "linux", environ: {}, home: "/home/op" })).toBe(
      join("/home/op", ".config", "deft", "delegation", "totp-secret.json"),
    );
    expect(
      resolveDelegationSecretPath({ platform: "linux", environ: { XDG_CONFIG_HOME: "/x" } }),
    ).toBe(join("/x", "deft", "delegation", "totp-secret.json"));
  });

  it("refuses to replace an enrolled secret without replace", () => {
    const root = mkdtempSync(join(tmpdir(), "deleg-secret-"));
    roots.push(root);
    const p = join(root, "s.json");
    expect(
      writeEnrolledSecret(p, { secretBase32: SECRET, enrolledAt: "x", account: "a" }, false).ok,
    ).toBe(true);
    expect(
      writeEnrolledSecret(p, { secretBase32: SECRET, enrolledAt: "x", account: "a" }, false).ok,
    ).toBe(false);
    expect(
      writeEnrolledSecret(p, { secretBase32: SECRET, enrolledAt: "y", account: "a" }, true).ok,
    ).toBe(true);
  });
});

describe("each end condition ends the record (#7420 B2 / clause 11)", () => {
  it("is live right after arming", () => {
    const { root, delegationId } = armed();
    expect(readLiveDelegation(root, { now: later, storeRoot: root })?.delegationId).toBe(
      delegationId,
    );
  });

  it("delegate off", () => {
    const { root } = armed();
    const ended = endDelegation(root, "operator-off", { now: later, storeRoot: root });
    expect(ended.ok && ended.ended).toBe(true);
    const live = readDelegationLiveness(root, { now: later, storeRoot: root });
    expect(live).toEqual({ live: false, reason: "operator-off" });
    // Idempotent.
    const again = endDelegation(root, "operator-off", { now: later, storeRoot: root });
    expect(again.ok && again.ended).toBe(false);
  });

  it("TTL expiry", () => {
    const { root } = armed();
    const after = new Date(T0.getTime() + 13 * 3600 * 1000);
    expect(readDelegationLiveness(root, { now: after, storeRoot: root })).toEqual({
      live: false,
      reason: "ttl-expired",
    });
    // Persisted: the record stays ended.
    const st = loadDelegationState(root);
    expect(st.ok && st.state.record?.endedReason).toBe("ttl-expired");
  });

  it("an end bound to a delegation id leaves a freshly armed record alone", () => {
    const { root, delegationId } = armed();
    const stale = endDelegation(root, "ttl-expired", {
      now: later,
      storeRoot: root,
      expectDelegationId: `${delegationId}-old`,
    });
    expect(stale.ok && stale.ended).toBe(false);
    expect(readDelegationLiveness(root, { now: later, storeRoot: root }).live).toBe(true);
    const match = endDelegation(root, "operator-off", {
      now: later,
      storeRoot: root,
      expectDelegationId: delegationId,
    });
    expect(match.ok && match.ended).toBe(true);
  });

  it("session end (only the arming session)", () => {
    const { root } = armed();
    const other = endDelegation(root, "session-end", {
      now: later,
      storeRoot: root,
      hostSessionId: "session-B",
    });
    expect(other.ok && other.ended).toBe(false);
    expect(readLiveDelegation(root, { now: later, storeRoot: root })).not.toBeNull();
    const same = endDelegation(root, "session-end", {
      now: later,
      storeRoot: root,
      hostSessionId: "session-A",
    });
    expect(same.ok && same.ended).toBe(true);
    expect(readDelegationLiveness(root, { now: later, storeRoot: root })).toEqual({
      live: false,
      reason: "session-end",
    });
  });

  it("UAT start", () => {
    const { root } = armed();
    const started = startUatLease({ projectRoot: root, campaignId: "c-1", now: later });
    expect(started.ok).toBe(true);
    const st = loadDelegationState(root);
    expect(st.ok && st.state.record?.endedReason).toBe("uat-start");
    expect(readLiveDelegation(root, { now: later, storeRoot: root })).toBeNull();
  });

  it("the kill switch (stays ended after the kill record is removed)", () => {
    const { root } = armed();
    const kill = killSwitchRecordPath(root);
    mkdirSync(join(root, ".deft", "authz"), { recursive: true });
    writeFileSync(kill, "schema=deft.kill-switch.v1\n");
    expect(readDelegationLiveness(root, { now: later, storeRoot: root })).toEqual({
      live: false,
      reason: "kill-switch",
    });
    rmSync(kill);
    expect(readDelegationLiveness(root, { now: later, storeRoot: root })).toEqual({
      live: false,
      reason: "kill-switch",
    });
  });

  it("a terminal authz:revoke (the runtime calls endDelegation with authz-revoke)", () => {
    const { root } = armed();
    const ended = endDelegation(root, "authz-revoke", { now: later, storeRoot: root });
    expect(ended.ok && ended.ended).toBe(true);
    expect(readDelegationLiveness(root, { now: later, storeRoot: root })).toEqual({
      live: false,
      reason: "authz-revoke",
    });
  });

  it("refuses a record whose life exceeds the 72h cap even if expiresAt is in the future", () => {
    const rec = {
      schemaVersion: 1 as const,
      delegationId: "d",
      hostSessionId: "s",
      host: "claude",
      armedAt: "2026-11-27T00:00:00Z",
      expiresAt: "2026-12-30T00:00:00Z",
      armedStep: 1,
      allowlist: { verbs: [], templates: [] },
      provenance: "delegated-totp" as const,
      endedAt: null,
      endedReason: null,
    };
    expect(
      evaluateDelegationLiveness(rec, { now: T0, uatActive: false, killSwitch: false }),
    ).toEqual({ live: false, reason: "ttl-expired" });
  });

  it("fails closed on an unreadable store", () => {
    const { root } = armed();
    writeFileSync(delegationStatePath(root), "{not json");
    expect(readLiveDelegation(root, { now: later, storeRoot: root })).toBeNull();
  });
});

describe("store lock (one locked step)", () => {
  it("times out without writing while a live holder keeps the lock", () => {
    const root = mkdtempSync(join(tmpdir(), "deleg-lock-"));
    roots.push(root);
    mkdirSync(join(root, ...DELEGATION_STORE_REL.split("/")), { recursive: true });
    writeFileSync(
      delegationLockPath(root),
      JSON.stringify({ pid: process.pid, token: "someone-else", startedAt: "x" }),
    );
    let ran = false;
    const res = withDelegationLock(
      root,
      () => {
        ran = true;
      },
      { timeoutMs: 100 },
    );
    expect(res.ok).toBe(false);
    expect(ran).toBe(false);
    expect(existsSync(delegationLockPath(root))).toBe(true);
  });

  it("does not reclaim a fresh unreadable lock (a holder may be mid-write)", () => {
    const root = mkdtempSync(join(tmpdir(), "deleg-lock-fresh-"));
    roots.push(root);
    mkdirSync(join(root, ...DELEGATION_STORE_REL.split("/")), { recursive: true });
    writeFileSync(delegationLockPath(root), "");
    let ran = false;
    const res = withDelegationLock(
      root,
      () => {
        ran = true;
      },
      { timeoutMs: 100 },
    );
    expect(res.ok).toBe(false);
    expect(ran).toBe(false);
    expect(existsSync(delegationLockPath(root))).toBe(true);
  });

  it("reclaims a dead holder's lock", () => {
    const root = mkdtempSync(join(tmpdir(), "deleg-lock-dead-"));
    roots.push(root);
    mkdirSync(join(root, ...DELEGATION_STORE_REL.split("/")), { recursive: true });
    writeFileSync(
      delegationLockPath(root),
      JSON.stringify({ pid: 999_999_999, token: "dead", startedAt: "x" }),
    );
    const res = withDelegationLock(root, () => 42, { timeoutMs: 1000 });
    expect(res).toEqual({ ok: true, value: 42 });
    expect(existsSync(delegationLockPath(root))).toBe(false);
  });
});

describe("delegated hook allow, per condition (#7420 B5 / clause 15 core half)", () => {
  it("allows only the advisory-capable scope-cover condition, with audit", () => {
    const { root, delegationId } = armed();
    const ok = evaluateDelegatedHookAllow({
      projectRoot: root,
      storeRoot: root,
      condition: "prospective-scope-cover-deny:advisory-capable",
      detail: "staged paths outside file_scope",
      now: later,
    });
    expect(ok.ok && ok.delegationId).toBe(delegationId);
    expect(ok.ok && ok.chatLine).toMatch(/^\[delegated-totp\] allowed/);
    const audit = readFileSync(delegationAuditPath(root), "utf8");
    expect(audit).toMatch(/"event":"delegated-allow"/);
    for (const condition of [
      "prospective-scope-cover-deny",
      "prospective-scope-cover-deny:unresolved-target",
      "prospective-scope-cover-deny:staged-unreadable",
      "prospective-scope-cover-deny:index-changing",
      "install-health-deny",
    ]) {
      expect(
        evaluateDelegatedHookAllow({
          projectRoot: root,
          storeRoot: root,
          condition,
          detail: "",
          now: later,
        }).ok,
      ).toBe(false);
    }
  });

  it("refuses with no live record", () => {
    const { root } = armed();
    endDelegation(root, "operator-off", { now: later, storeRoot: root });
    expect(
      evaluateDelegatedHookAllow({
        projectRoot: root,
        storeRoot: root,
        condition: "prospective-scope-cover-deny:advisory-capable",
        detail: "",
        now: later,
      }).ok,
    ).toBe(false);
  });
});

describe("delegable-mint allowlist (#7420 B3 / B7 / clause 17)", () => {
  it("allows approved-scope and the four release templates only", () => {
    expect(evaluateDelegableMint({ verb: "scope:record-approved-scope", template: null }).ok).toBe(
      true,
    );
    for (const t of DELEGABLE_RELEASE_TEMPLATES) {
      expect(evaluateDelegableMint({ verb: "authz:grant", template: t })).toEqual({
        ok: true,
        verb: "authz:grant",
        template: t,
      });
    }
  });

  it("refuses finish-loop, the override templates and every other named template", () => {
    for (const t of NEVER_DELEGABLE_TEMPLATES) {
      expect(evaluateDelegableMint({ verb: "authz:grant", template: t }).ok).toBe(false);
    }
  });

  it("refuses raw-ops grants (no template)", () => {
    const d = evaluateDelegableMint({ verb: "authz:grant", template: null });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toMatch(/raw operations/);
  });

  it("refuses authz:uat-*, authz:revoke and the other never-delegable verbs", () => {
    for (const v of NEVER_DELEGABLE_VERBS) {
      expect(evaluateDelegableMint({ verb: v, template: null }).ok).toBe(false);
    }
  });

  it("refuses a template on approved-scope", () => {
    expect(
      evaluateDelegableMint({ verb: "scope:record-approved-scope", template: "release-cut" }).ok,
    ).toBe(false);
  });

  it("resolves a completion only with a live record", () => {
    const { root, delegationId } = armed();
    const ok = resolveDelegatedCompletion({
      projectRoot: root,
      storeRoot: root,
      verb: "authz:grant",
      template: "release-cut",
      requestId: "r1",
      now: later,
    });
    expect(ok.ok && ok.completion.delegationId).toBe(delegationId);
    expect(ok.ok && ok.completion.provenance).toBe("delegated-totp");
    const refused = resolveDelegatedCompletion({
      projectRoot: root,
      storeRoot: root,
      verb: "authz:grant",
      template: "finish-loop",
      requestId: "r1",
      now: later,
    });
    expect(refused.ok).toBe(false);
    endDelegation(root, "operator-off", { now: later, storeRoot: root });
    const after = resolveDelegatedCompletion({
      projectRoot: root,
      storeRoot: root,
      verb: "authz:grant",
      template: "release-cut",
      requestId: "r1",
      now: later,
    });
    expect(after.ok).toBe(false);
    expect(readFileSync(delegationStatePath(root), "utf8")).toMatch(/operator-off/);
  });
});
