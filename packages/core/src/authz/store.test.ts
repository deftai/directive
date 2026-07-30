import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintHumanOriginGrant, startUatLease, suspendUatLease } from "./actions.js";
import { authzStatePath } from "./paths.js";
import {
  listActiveHumanGrants,
  loadAuthzState,
  loadAuthzStateResult,
  markGrantUsed,
  parseGrant,
  saveGrant,
} from "./store.js";
import type { HumanOriginGrant } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "authz-store-"));
  roots.push(root);
  return root;
}

describe("authz store (#2944)", () => {
  it("missing state is inactive ok", () => {
    const root = tempRoot();
    const loaded = loadAuthzStateResult(root);
    expect(loaded.ok).toBe(true);
    expect(loaded.corrupt).toBe(false);
    expect(loaded.state.uat).toBeNull();
  });

  it("corrupt state fails closed (active synthetic UAT)", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "authz"), { recursive: true });
    writeFileSync(authzStatePath(root), "{not-json", "utf8");
    const loaded = loadAuthzStateResult(root);
    expect(loaded.ok).toBe(false);
    expect(loaded.corrupt).toBe(true);
    expect(loaded.state.uat?.active).toBe(true);
  });

  it("uat start/suspend round-trip", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "c1", actor: "op" });
    expect(loadAuthzState(root).uat?.active).toBe(true);
    suspendUatLease({ projectRoot: root });
    expect(loadAuthzState(root).uat?.active).toBe(false);
  });

  it("markGrantUsed sets usedAt for single-use grants", () => {
    const root = tempRoot();
    const grant = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      surfaces: ["src/**"],
      cohortId: "c",
      singleUse: true,
    });
    expect(grant.semantics.usedAt).toBeNull();
    const used = markGrantUsed(root, grant.id);
    expect(used?.semantics.usedAt).toBeTruthy();
    expect(listActiveHumanGrants(root).find((g) => g.id === grant.id)).toBeUndefined();
  });

  it("listActiveHumanGrants filters rejected origins", () => {
    const root = tempRoot();
    const bad: HumanOriginGrant = {
      schemaVersion: 1,
      id: "bad",
      origin: {
        kind: "dispatch-envelope",
        actor: "agent",
        mintedAt: "2026-07-30T00:00:00Z",
        mintedVia: "self",
        eventRef: null,
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: null,
        surfaces: [],
        operations: ["edit"],
        storyIds: [],
        issueIds: [],
        cohortId: "x",
      },
      semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
    };
    saveGrant(root, bad);
    expect(listActiveHumanGrants(root)).toHaveLength(0);
  });

  it("parseGrant rejects incomplete records", () => {
    expect(parseGrant(null)).toBeNull();
    expect(parseGrant({})).toBeNull();
    expect(parseGrant({ id: "x" })).toBeNull();
  });

  it("markGrantUsed is no-op for multi-use", () => {
    const root = tempRoot();
    const grant = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c",
      singleUse: false,
    });
    const again = markGrantUsed(root, grant.id);
    expect(again?.semantics.usedAt).toBeNull();
  });
});
