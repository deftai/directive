/**
 * Store SoT UAT write-class refuse + sealed campaign-end (#4233).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mintHumanOriginGrant as mintHumanOriginGrantResult,
  startUatLease as startUatLeaseResult,
  suspendUatLease as suspendUatLeaseResult,
} from "./actions.js";

/** Test unwraps for #4233 Result-returning actions (throws free in *.test.ts). */
function mintHumanOriginGrant(
  ...args: Parameters<typeof mintHumanOriginGrantResult>
): import("./types.js").HumanOriginGrant {
  const r = mintHumanOriginGrantResult(...args);
  if (!r.ok) throw new Error(r.reason);
  return r.grant;
}
function startUatLease(...args: Parameters<typeof startUatLeaseResult>): {
  state: import("./types.js").AuthzState;
  lease: import("./types.js").UatLease;
} {
  const r = startUatLeaseResult(...args);
  if (!r.ok) throw new Error(r.reason);
  return { state: r.state, lease: r.lease };
}
function suspendUatLease(
  ...args: Parameters<typeof suspendUatLeaseResult>
): import("./types.js").AuthzState {
  const r = suspendUatLeaseResult(...args);
  if (!r.ok) throw new Error(r.reason);
  return r.state;
}

import { uatCampaignEndSeal } from "./campaign-end-seal.js";
import {
  listActiveHumanGrants,
  loadAuthzState,
  loadGrant,
  markGrantUsed,
  saveAuthzState,
  saveGrant,
} from "./store.js";
import type { HumanOriginGrant } from "./types.js";
import {
  classifyGrantWriteIntent,
  evaluateAuthzStateWriteUnderUat,
  evaluateGrantWriteUnderUat,
} from "./uat-write-guard.js";

const temps: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-4233-"));
  temps.push(root);
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const p = temps.pop();
    if (p !== undefined) rmSync(p, { recursive: true, force: true });
  }
});

function baseGrant(id: string): HumanOriginGrant {
  return {
    schemaVersion: 1,
    id,
    origin: {
      kind: "operator-cli",
      actor: "operator",
      mintedAt: "2026-10-01T00:00:00Z",
      mintedVia: "deft authz:grant",
      eventRef: null,
    },
    scope: {
      planRef: null,
      repo: null,
      branch: null,
      worktree: null,
      surfaces: ["src/**"],
      operations: ["edit"],
      storyIds: [],
      issueIds: [],
      cohortId: "c1",
    },
    semantics: { expiresAt: null, singleUse: true, usedAt: null, revokedAt: null },
  };
}

describe("classifyGrantWriteIntent (#4233)", () => {
  it("distinguishes create, usedAt-only, and authority mutate", () => {
    const g = baseGrant("g1");
    expect(classifyGrantWriteIntent(null, g)).toBe("grant-create");
    expect(
      classifyGrantWriteIntent(g, {
        ...g,
        semantics: { ...g.semantics, usedAt: "2026-10-01T01:00:00Z" },
      }),
    ).toBe("usedAt-only-consume");
    expect(
      classifyGrantWriteIntent(g, {
        ...g,
        scope: { ...g.scope, operations: ["edit", "push"] },
      }),
    ).toBe("authority-field-mutate");
    expect(
      classifyGrantWriteIntent(g, {
        ...g,
        semantics: { ...g.semantics, expiresAt: "2099-01-01T00:00:00Z" },
      }),
    ).toBe("authority-field-mutate");
    expect(
      classifyGrantWriteIntent(g, {
        ...g,
        semantics: { ...g.semantics, revokedAt: "2026-10-01T02:00:00Z" },
      }),
    ).toBe("authority-field-mutate");
    expect(classifyGrantWriteIntent(g, g)).toBe("noop");
  });
});

describe("store SoT hard-refuse under active UAT (#4233)", () => {
  it("refuses grant create and authority mutate; allows usedAt-only", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c1",
      grantId: "g-pre",
      singleUse: true,
      pinActive: true,
    });
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "op" });

    const create = saveGrant(root, baseGrant("g-new"));
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.code).toBe("uat-grant-create");

    const widen = saveGrant(root, {
      ...g,
      scope: { ...g.scope, operations: ["edit", "push"] },
    });
    expect(widen.ok).toBe(false);
    if (!widen.ok) expect(widen.code).toBe("uat-authority-field-mutate");

    const used = markGrantUsed(root, g.id);
    expect(used?.semantics.usedAt).toBeTruthy();
    expect(loadGrant(root, g.id)?.semantics.usedAt).toBeTruthy();
  });

  it("refuses pin mutate; sealed campaign-end only for uat.active true→false", () => {
    const root = tempRoot();
    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c1",
      grantId: "g-pin",
      pinActive: true,
    });
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "op" });
    const prev = loadAuthzState(root);
    expect(prev.uat?.active).toBe(true);

    const pinMutate = saveAuthzState(root, {
      ...prev,
      activeGrantIds: [...prev.activeGrantIds, "extra"],
    });
    expect(pinMutate.ok).toBe(false);
    if (!pinMutate.ok) expect(pinMutate.code).toBe("uat-pin-mutate");

    const unsealed = saveAuthzState(root, {
      ...prev,
      uat: prev.uat ? { ...prev.uat, active: false, suspendedAt: "2026-10-01T03:00:00Z" } : null,
    });
    expect(unsealed.ok).toBe(false);
    if (!unsealed.ok) expect(unsealed.code).toBe("uat-campaign-end-unsealed");

    // Stringly / foreign seal must not waive.
    const foreign = evaluateAuthzStateWriteUnderUat(
      prev,
      {
        ...prev,
        uat: prev.uat ? { ...prev.uat, active: false, suspendedAt: "2026-10-01T03:00:00Z" } : null,
      },
      { campaignEndSeal: Symbol("forged") as never },
    );
    expect(foreign.ok).toBe(false);

    const sealed = suspendUatLease({
      projectRoot: root,
      campaignEndSeal: uatCampaignEndSeal(),
    });
    expect(sealed.uat?.active).toBe(false);
  });

  it("suspend without seal fails; seal does not waive pin mutate", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1" });
    expect(() => suspendUatLease({ projectRoot: root })).toThrow(/campaign-end|sealed|UAT/i);

    const prev = loadAuthzState(root);
    const pinWithSeal = saveAuthzState(
      root,
      { ...prev, activeGrantIds: ["x"] },
      { campaignEndSeal: uatCampaignEndSeal() },
    );
    expect(pinWithSeal.ok).toBe(false);
    if (!pinWithSeal.ok) expect(pinWithSeal.code).toBe("uat-pin-mutate");
  });

  it("empty pin fail-closed only under UAT; start carries pin forward", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c1",
      grantId: "g-carry",
      pinActive: true,
    });
    const before = loadAuthzState(root);
    expect(before.activeGrantIds).toContain(g.id);

    startUatLease({ projectRoot: root, campaignId: "uat-1" });
    const afterStart = loadAuthzState(root);
    expect(afterStart.activeGrantIds).toEqual(before.activeGrantIds);
    expect(listActiveHumanGrants(root, afterStart).map((x) => x.id)).toContain(g.id);

    // Empty pin under UAT activates none.
    const emptyPin = listActiveHumanGrants(root, { ...afterStart, activeGrantIds: [] });
    expect(emptyPin).toEqual([]);

    // Outside UAT empty pin keeps prior default (all active human grants).
    suspendUatLease({ projectRoot: root, campaignEndSeal: uatCampaignEndSeal() });
    const inactive = loadAuthzState(root);
    expect(inactive.uat?.active).toBe(false);
    const allActive = listActiveHumanGrants(root, { ...inactive, activeGrantIds: [] });
    expect(allActive.some((x) => x.id === g.id)).toBe(true);
  });

  it("mintHumanOriginGrant under UAT fails at store SoT", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1" });
    expect(() =>
      mintHumanOriginGrant({
        projectRoot: root,
        operations: ["edit"],
        cohortId: "c1",
      }),
    ).toThrow(/uat-grant-create|active UAT/i);
  });

  it("refuses usedAt unspend under UAT", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c1",
      grantId: "g-spend",
      singleUse: true,
      pinActive: true,
    });
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "op" });
    const used = markGrantUsed(root, g.id);
    expect(used?.semantics.usedAt).toBeTruthy();
    if (used === null || used === undefined) {
      throw new Error("expected markGrantUsed to return grant");
    }
    const unspend = saveGrant(root, {
      ...used,
      semantics: { ...used.semantics, usedAt: null },
    });
    expect(unspend.ok).toBe(false);
    if (!unspend.ok) expect(unspend.code).toBe("uat-authority-field-mutate");
  });

  it("sealed campaign-end refuses wiping or rewriting campaign identity", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "op" });
    const prev = loadAuthzState(root);
    const wipe = evaluateAuthzStateWriteUnderUat(
      prev,
      { ...prev, uat: null },
      { campaignEndSeal: uatCampaignEndSeal() },
    );
    expect(wipe.ok).toBe(false);
    const rewrite = evaluateAuthzStateWriteUnderUat(
      prev,
      {
        ...prev,
        uat: prev.uat
          ? { ...prev.uat, active: false, campaignId: "other", suspendedAt: "2026-10-01T03:00:00Z" }
          : null,
      },
      { campaignEndSeal: uatCampaignEndSeal() },
    );
    expect(rewrite.ok).toBe(false);
  });

  it("public authz barrel does not export uatCampaignEndSeal", async () => {
    const mod = await import("./index.js");
    expect("uatCampaignEndSeal" in mod).toBe(false);
    expect(typeof mod.isUatCampaignEndSeal).toBe("function");
  });

  it("write-guard module does not export the campaign-end seal factory (#4233)", async () => {
    const mod = await import("./uat-write-guard.js");
    expect("uatCampaignEndSeal" in mod).toBe(false);
    expect(typeof mod.isUatCampaignEndSeal).toBe("function");
  });

  it("pure predicate stays free of CLI exit helper side effects", () => {
    const state = {
      schemaVersion: 1 as const,
      uat: {
        active: true,
        campaignId: "c",
        startedAt: "2026-10-01T00:00:00Z",
        startedBy: {
          kind: "operator-cli",
          actor: "op",
          mintedAt: "2026-10-01T00:00:00Z",
          mintedVia: "deft authz:uat-start",
          eventRef: null,
        },
        suspendedAt: null,
        note: null,
      },
      activeGrantIds: [] as string[],
    };
    const d = evaluateGrantWriteUnderUat(state, null, baseGrant("x"));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("uat-grant-create");
  });
});
