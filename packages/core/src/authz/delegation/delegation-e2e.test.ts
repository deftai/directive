/**
 * End to end for TOTP delegation (#7420 clauses 12-14 / 17-18): arm, complete,
 * mint, admit at the one named consumer, refuse everywhere else, stop admitting
 * after disarm.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildApprovedScopeRecord,
  buildDelegatedApprovalStamp,
  DELEGATED_APPROVAL_STAMP_KIND,
  DELEGATED_APPROVAL_STAMP_MINTED_VIA,
  isDelegatedApprovalStamp,
  isHumanApprovalStamp,
} from "../../scope-provenance/digest.js";
import {
  evaluateScopeProvenance,
  fenceAdmitsApprovalStamp,
} from "../../scope-provenance/evaluate.js";
import { isRecordStamp } from "../../scope-provenance/record-stamp.js";
import { mintDelegatedReleaseGrant } from "../actions.js";
import { evaluateClosedVerb } from "../closed-verb.js";
import { evaluateAuthzMutation } from "../evaluate.js";
import { isDelegatedOrigin, isHumanOrigin, isHumanOriginGrant } from "../origin.js";
import { listActiveHumanGrants, listDelegatedGrants, loadAuthzState } from "../store.js";
import { resolveClosedVerbTemplate } from "../templates.js";
import {
  DELEGATED_GRANT_MINTED_VIA,
  DELEGATED_ORIGIN_KIND,
  type HumanOriginGrant,
} from "../types.js";
import { armDelegation } from "./arm.js";
import {
  delegationAuditPath,
  endDelegation,
  readLiveDelegation,
  resolveDelegatedCompletion,
  writeEnrolledSecret,
} from "./store.js";
import { totpCodeForStep, totpStepAt } from "./totp.js";
import {
  DELEGABLE_RELEASE_TEMPLATES,
  DELEGATED_TOTP_PROVENANCE,
  type DelegableReleaseTemplate,
} from "./types.js";

describe("delegated origin format is one format (#7420 B4)", () => {
  it("pins the scope-provenance stamp constants to the authz delegated origin", () => {
    expect(DELEGATED_APPROVAL_STAMP_KIND).toBe(DELEGATED_ORIGIN_KIND);
    expect(DELEGATED_APPROVAL_STAMP_MINTED_VIA).toBe(DELEGATED_TOTP_PROVENANCE);
    expect(DELEGATED_GRANT_MINTED_VIA).toBe(DELEGATED_TOTP_PROVENANCE);
  });
});

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const T0 = new Date("2026-11-27T12:00:00Z");
const T1 = new Date(T0.getTime() + 5 * 60_000);
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function armedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deleg-e2e-"));
  roots.push(root);
  const secretPath = join(root, "cfg", "totp-secret.json");
  writeEnrolledSecret(secretPath, { secretBase32: SECRET, enrolledAt: "x", account: "op" }, false);
  const out = armDelegation({
    projectRoot: root,
    storeRoot: root,
    secretPath,
    promptText: `deft delegate on 12h ${totpCodeForStep(SECRET, totpStepAt(T0))}`,
    hostSessionId: "session-A",
    host: "claude",
    now: T0,
  });
  if (out.kind !== "armed") throw new Error(`arm failed: ${out.kind}`);
  return root;
}

function mintRelease(root: string, template: DelegableReleaseTemplate): HumanOriginGrant {
  const completion = resolveDelegatedCompletion({
    projectRoot: root,
    storeRoot: root,
    verb: "authz:grant",
    template,
    requestId: `req-${template}`,
    now: T1,
  });
  if (!completion.ok) throw new Error(completion.reason);
  const resolved = resolveClosedVerbTemplate({ template, target: "0.133.0", now: T1 });
  const minted = mintDelegatedReleaseGrant({
    projectRoot: root,
    completion: completion.completion,
    template,
    surfaces: resolved.surfaces,
    expiresAt: resolved.expiresAt,
    actor: "scott",
    now: T1,
    delegationStoreRoot: root,
  });
  if (!minted.ok) throw new Error(minted.reason);
  return minted.grant;
}

describe("release templates end to end (#7420 clause 13)", () => {
  for (const template of DELEGABLE_RELEASE_TEMPLATES) {
    it(`${template}: admits only its verb while live, refuses after disarm`, () => {
      const root = armedRoot();
      const grant = mintRelease(root, template);
      expect(isDelegatedOrigin(grant.origin)).toBe(true);
      expect(grant.origin.mintedVia).toBe("delegated-totp");
      expect(grant.scope.operations).toEqual([template]);
      const live = readLiveDelegation(root, { now: T1, storeRoot: root });
      expect(Date.parse(grant.semantics.expiresAt as string)).toBeLessThanOrEqual(
        Date.parse(live?.expiresAt as string),
      );

      const at = (verb: string, delegation = live) =>
        evaluateClosedVerb({
          verb,
          target: "0.133.0",
          grants: [grant],
          env: {},
          now: T1,
          delegation,
        });
      expect(at(template).allowed).toBe(true);
      expect(at(template).reason).toMatch(/delegated grant/);
      for (const other of DELEGABLE_RELEASE_TEMPLATES.filter((t) => t !== template)) {
        expect(at(other).allowed).toBe(false);
      }
      // Default resolution reads the store under projectRoot.
      expect(
        evaluateClosedVerb({
          verb: template,
          target: "0.133.0",
          grants: [grant],
          env: {},
          now: T1,
          projectRoot: root,
        }).allowed,
      ).toBe(true);

      endDelegation(root, "operator-off", { now: T1, storeRoot: root });
      const after = readLiveDelegation(root, { now: T1, storeRoot: root });
      expect(after).toBeNull();
      const denied = at(template, after);
      expect(denied.allowed).toBe(false);
      expect(denied.code).toBe("closed-verb-deny-delegation-ended");
      expect(
        evaluateClosedVerb({
          verb: template,
          target: "0.133.0",
          grants: [grant],
          env: {},
          now: T1,
          projectRoot: root,
        }).allowed,
      ).toBe(false);
    });
  }

  it("a delegated grant from an older delegation does not admit under a new one", () => {
    const root = armedRoot();
    const grant = mintRelease(root, "release-cut");
    const forged = {
      delegationId: "delegation-other",
      hostSessionId: "s",
      expiresAt: "2026-11-28T00:00:00Z",
      allowlist: { verbs: [], templates: [] },
    };
    expect(
      evaluateClosedVerb({
        verb: "release-cut",
        target: "0.133.0",
        grants: [grant],
        env: {},
        now: T1,
        delegation: forged,
      }).allowed,
    ).toBe(false);
  });

  it("refuses to mint a template outside the four or after disarm", () => {
    const root = armedRoot();
    const completion = resolveDelegatedCompletion({
      projectRoot: root,
      storeRoot: root,
      verb: "authz:grant",
      template: "release-cut",
      requestId: "r",
      now: T1,
    });
    if (!completion.ok) throw new Error(completion.reason);
    const wrongTemplate = mintDelegatedReleaseGrant({
      projectRoot: root,
      completion: completion.completion,
      template: "finish-loop",
      surfaces: ["x"],
      expiresAt: null,
      now: T1,
      delegationStoreRoot: root,
    });
    expect(wrongTemplate.ok).toBe(false);
    endDelegation(root, "operator-off", { now: T1, storeRoot: root });
    const afterOff = mintDelegatedReleaseGrant({
      projectRoot: root,
      completion: completion.completion,
      template: "release-cut",
      surfaces: ["0.133.0"],
      expiresAt: null,
      now: T1,
      delegationStoreRoot: root,
    });
    expect(afterOff.ok).toBe(false);
  });
});

describe("delegated grant is refused by every other consumer (#7420 clause 14)", () => {
  it("isHumanOrigin, the active-grant list and the general grant check refuse it", () => {
    const root = armedRoot();
    const grant = mintRelease(root, "release-publish");
    expect(isHumanOrigin(grant.origin)).toBe(false);
    expect(isHumanOriginGrant(grant)).toBe(false);
    expect(listActiveHumanGrants(root, loadAuthzState(root), T1).map((g) => g.id)).not.toContain(
      grant.id,
    );
    expect(listDelegatedGrants(root, T1).map((g) => g.id)).toContain(grant.id);
    const decision = evaluateAuthzMutation({
      state: {
        schemaVersion: 1,
        activeGrantIds: [],
        uat: {
          active: true,
          campaignId: "c",
          startedAt: "2026-11-27T00:00:00Z",
          startedBy: {
            kind: "operator-cli",
            actor: "op",
            mintedAt: "2026-11-27T00:00:00Z",
            mintedVia: "x",
            eventRef: null,
          },
          suspendedAt: null,
          note: null,
        },
      },
      grants: [grant],
      op: "release-publish",
      path: null,
      now: T1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-origin-reject");
  });
});

describe("approved-scope end to end (#7420 clause 12)", () => {
  const rel = "xbrief/active/story.xbrief.json";
  const brief = (scope: string[]) =>
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { id: "story-1", status: "running", metadata: { swarm: { file_scope: scope } } },
    });

  function delegatedRecord(root: string) {
    const completion = resolveDelegatedCompletion({
      projectRoot: root,
      storeRoot: root,
      verb: "scope:record-approved-scope",
      template: null,
      requestId: "req-scope",
      now: T1,
    });
    if (!completion.ok) throw new Error(completion.reason);
    const live = readLiveDelegation(root, { now: T1, storeRoot: root });
    const stamp = buildDelegatedApprovalStamp({
      actor: "scott",
      delegationId: completion.completion.delegationId,
      expiresAt: live?.expiresAt as string,
      mintedAt: T1.toISOString(),
    });
    return buildApprovedScopeRecord({
      xbriefRelPath: rel,
      payload: JSON.parse(brief(["packages/core/src/a.ts"])),
      humanApproval: stamp,
    });
  }

  function fence(
    root: string,
    record: ReturnType<typeof buildApprovedScopeRecord>,
    delegation: ReturnType<typeof readLiveDelegation>,
  ) {
    // The delegation is injected, so the fence runs on a seam-only root (no git).
    void root;
    return evaluateScopeProvenance("/tmp/proj-deleg-fence-7420", {
      changedFiles: [rel, "packages/core/src/a.ts", "CHANGELOG.md"],
      activeXbriefs: new Map([[rel, brief(["packages/core/src/a.ts"])]]),
      approvedRecords: [record],
      baseApprovedRecords: new Map([["story-1", record]]),
      baseXbriefs: new Map([[rel, brief(["packages/core/src/a.ts"])]]),
      delegation,
      now: T1,
    });
  }

  it("the fence admits the stamped path while live and stops after disarm", () => {
    const root = armedRoot();
    const record = delegatedRecord(root);
    expect(isDelegatedApprovalStamp(record.humanApproval)).toBe(true);
    const live = readLiveDelegation(root, { now: T1, storeRoot: root });
    expect(fence(root, record, live).exitCode).toBe(0);
    endDelegation(root, "operator-off", { now: T1, storeRoot: root });
    const after = readLiveDelegation(root, { now: T1, storeRoot: root });
    expect(after).toBeNull();
    const refused = fence(root, record, after);
    expect(refused.exitCode).toBe(1);
    expect(refused.findings[0]?.detail).toMatch(/lacks human stamp/);
  });

  it("an expired delegated stamp does not admit even with a live delegation", () => {
    const root = armedRoot();
    const record = delegatedRecord(root);
    const live = readLiveDelegation(root, { now: T1, storeRoot: root });
    const late = new Date(Date.parse(record.humanApproval?.expiresAt as string) + 1000);
    expect(fenceAdmitsApprovalStamp(record.humanApproval, live, late)).toBe(false);
  });

  it("every other approved-scope reader refuses a delegated stamp", () => {
    const root = armedRoot();
    const stamp = delegatedRecord(root).humanApproval;
    expect(isHumanApprovalStamp(stamp)).toBe(false);
    expect(isRecordStamp(stamp, "scope:record-observable-scope")).toBe(false);
    expect(isRecordStamp(stamp, "scope:record-intent-constraint")).toBe(false);
    // The other readers call isHumanApprovalStamp and never the delegated predicate.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, "..", "..");
    for (const reader of [
      "policy/write-fence-budget.ts",
      "policy/one-pr-scope-proof.ts",
      "durable-effect-acquisition/ceiling.ts",
      "presentation-ceiling/evaluate.ts",
      "presentation-coverage/artifact.ts",
    ]) {
      const text = readFileSync(join(src, ...reader.split("/")), "utf8");
      expect(text, reader).toMatch(/isHumanApprovalStamp\(/);
      expect(text, reader).not.toMatch(/isDelegatedApprovalStamp|fenceAdmitsApprovalStamp/);
    }
  });
});

describe("audit tells delegated actions apart (#7420 clause 18)", () => {
  it("the arm and end are audited with provenance delegated-totp", () => {
    const root = armedRoot();
    endDelegation(root, "operator-off", { now: T1, storeRoot: root });
    const lines = readFileSync(delegationAuditPath(root), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; provenance: string });
    expect(lines.map((l) => l.event)).toEqual(["arm", "end"]);
    expect(lines.every((l) => l.provenance === "delegated-totp")).toBe(true);
  });
});
