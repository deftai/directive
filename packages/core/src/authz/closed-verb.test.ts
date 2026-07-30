import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateClosedVerb,
  normaliseClosedVerbTarget,
  targetSurfaceCandidates,
} from "./closed-verb.js";
import {
  assertNoIndependentSessionAuthMint,
  mintClosedVerbTemplateGrant,
  resolveClosedVerbTemplate,
} from "./templates.js";
import type { HumanOriginGrant } from "./types.js";
import {
  builtinReleaseVerbClassification,
  loadVerbClassification,
  parseVerbClassification,
} from "./verb-classification.js";

function grant(partial: {
  id?: string;
  kind?: string;
  actor?: string;
  operations?: HumanOriginGrant["scope"]["operations"];
  surfaces?: readonly string[];
  expiresAt?: string | null;
  revokedAt?: string | null;
  usedAt?: string | null;
  singleUse?: boolean;
}): HumanOriginGrant {
  return {
    schemaVersion: 1,
    id: partial.id ?? "grant-test",
    origin: {
      kind: partial.kind ?? "operator-cli",
      actor: partial.actor ?? "operator",
      mintedAt: "2026-07-30T00:00:00Z",
      mintedVia: "deft authz:grant",
      eventRef: null,
    },
    scope: {
      planRef: null,
      repo: null,
      branch: null,
      worktree: null,
      surfaces: partial.surfaces ?? [],
      operations: partial.operations ?? ["release-publish"],
      storyIds: [],
      issueIds: [],
      cohortId: null,
    },
    semantics: {
      expiresAt: partial.expiresAt ?? null,
      singleUse: partial.singleUse === true,
      usedAt: partial.usedAt ?? null,
      revokedAt: partial.revokedAt ?? null,
    },
  };
}

describe("verb-classification schema (#1095)", () => {
  it("builtin table has release-class rows with wildcard_allowed=false", () => {
    const table = builtinReleaseVerbClassification();
    for (const name of ["release-cut", "release-publish", "release-rollback"]) {
      const row = table.verbs[name];
      expect(row).toBeDefined();
      expect(row?.wildcard_allowed).toBe(false);
      expect(row?.env_bypass.startsWith("DEFT_ALLOW_")).toBe(true);
      expect(row?.authz_operations.length).toBeGreaterThan(0);
      expect(row?.skill.length).toBeGreaterThan(0);
      expect(row?.phase.length).toBeGreaterThan(0);
    }
  });

  it("loads conventions file when present at project root", () => {
    // This worktree ships conventions/verb-classification.json
    const table = loadVerbClassification(process.cwd());
    expect(table.verbs["release-publish"]).toBeDefined();
    expect(table.verbs["release-publish"]?.env_bypass).toBe("DEFT_ALLOW_RELEASE_PUBLISH");
  });

  it("rejects wildcard_allowed true for release-class policy", () => {
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: {
          "release-publish": {
            closure_set: [],
            explicit_required: [],
            irreversibility: "destructive",
            wildcard_allowed: true,
            recurring_allowed: false,
            default_expiry: "1h",
            skill: "x",
            phase: "Phase 5",
            authz_operations: ["release-publish"],
            env_bypass: "DEFT_ALLOW_RELEASE_PUBLISH",
          },
        },
      }),
    ).toThrow(/wildcard_allowed/);
  });
});

describe("evaluateClosedVerb (#1095)", () => {
  it("denies when no grant and no env bypass", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.30.0",
      grants: [],
      env: {},
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("closed-verb-deny-missing");
    expect(d.envBypassKey).toBe("DEFT_ALLOW_RELEASE_PUBLISH");
    expect(d.reason).toMatch(/authz:grant|DEFT_ALLOW_RELEASE_PUBLISH/);
  });

  it("allows via DEFT_ALLOW_RELEASE_PUBLISH=1", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.30.0",
      grants: [],
      env: { DEFT_ALLOW_RELEASE_PUBLISH: "1" },
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("closed-verb-env-bypass");
  });

  it("allows matching operator-cli release-publish grant", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.30.0",
      grants: [grant({ operations: ["release-publish"], surfaces: ["0.30.0", "v0.30.0"] })],
      env: {},
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("closed-verb-allow");
    expect(d.humanApprovalRef).toBe("grant-test");
  });

  it("allows deployment op as broad cover for release-publish", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "1.0.0",
      grants: [grant({ operations: ["deployment"], surfaces: [] })],
      env: {},
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("closed-verb-allow");
  });

  it("rejects agent-authored grant", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.30.0",
      grants: [
        grant({
          kind: "agent-authored",
          actor: "agent",
          operations: ["release-publish"],
          surfaces: [],
        }),
      ],
      env: {},
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("closed-verb-deny-origin");
  });

  it("rejects wrong-target surface binding", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.30.0",
      grants: [grant({ operations: ["release-publish"], surfaces: ["0.29.0"] })],
      env: {},
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("closed-verb-deny-scope");
  });

  it("rejects edit-only grant for release-publish", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.30.0",
      grants: [grant({ operations: ["edit"], surfaces: [] })],
      env: {},
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("closed-verb-deny-scope");
  });

  it("rejects expired grant", () => {
    const d = evaluateClosedVerb({
      verb: "release-cut",
      target: "0.30.0",
      grants: [
        grant({
          operations: ["release-cut"],
          surfaces: [],
          expiresAt: "2020-01-01T00:00:00Z",
        }),
      ],
      env: {},
      now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("closed-verb-deny-expired");
  });

  it("unknown verb fails closed", () => {
    const d = evaluateClosedVerb({
      verb: "repo-delete",
      target: null,
      grants: [],
      env: {},
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("closed-verb-unknown");
  });

  it("target helpers normalise v-prefix", () => {
    expect(normaliseClosedVerbTarget("v0.30.0")).toBe("0.30.0");
    expect(targetSurfaceCandidates("0.30.0")).toEqual(
      expect.arrayContaining(["0.30.0", "v0.30.0"]),
    );
  });
});

describe("AFK templates (#1095)", () => {
  it("resolveClosedVerbTemplate mints precise op + target surfaces", () => {
    const r = resolveClosedVerbTemplate({
      template: "release-publish",
      target: "0.30.0",
      now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(r.operations).toEqual(["release-publish"]);
    expect(r.surfaces).toEqual(expect.arrayContaining(["0.30.0", "v0.30.0"]));
    expect(r.expiresAt).toMatch(/2026-07-30T01:00:00Z/);
  });

  it("mintClosedVerbTemplateGrant uses operator-cli origin only", () => {
    const root = mkdtempSync(join(tmpdir(), "authz-tpl-"));
    try {
      const g = mintClosedVerbTemplateGrant({
        projectRoot: root,
        template: "release-publish",
        target: "0.31.0",
        actor: "msadams",
      });
      expect(g.origin.kind).toBe("operator-cli");
      expect(g.scope.operations).toEqual(["release-publish"]);
      expect(g.scope.surfaces).toEqual(expect.arrayContaining(["0.31.0", "v0.31.0"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dual-mint guard: session-auth is not authorization SoT", () => {
    const guard = assertNoIndependentSessionAuthMint();
    expect(guard.mintPath).toBe("mintHumanOriginGrant");
    expect(guard.sessionAuthIsAuthority).toBe(false);
  });
});
