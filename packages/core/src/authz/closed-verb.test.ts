import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closedVerbEnvBypassKey,
  evaluateClosedVerb,
  normaliseClosedVerbTarget,
  targetSurfaceCandidates,
} from "./closed-verb.js";
import {
  assertNoIndependentSessionAuthMint,
  isAfkTemplateName,
  isClosedVerbTemplateName,
  isFinishLoopTemplateName,
  mintAfkTemplateGrant,
  mintClosedVerbTemplateGrant,
  mintFinishLoopTemplateGrant,
  resolveClosedVerbTemplate,
  resolveFinishLoopTemplate,
} from "./templates.js";
import type { HumanOriginGrant } from "./types.js";
import {
  builtinReleaseVerbClassification,
  getVerbRow,
  loadVerbClassification,
  parseVerbClassification,
  resolveVerbClassificationPath,
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

  it("rejects unparseable expiresAt fail-closed", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.30.0",
      grants: [
        grant({
          operations: ["release-publish"],
          surfaces: [],
          expiresAt: "not-a-date",
        }),
      ],
      env: {},
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
    expect(normaliseClosedVerbTarget("")).toBeNull();
    expect(normaliseClosedVerbTarget(null)).toBeNull();
    expect(targetSurfaceCandidates("0.30.0")).toEqual(
      expect.arrayContaining(["0.30.0", "v0.30.0"]),
    );
    expect(targetSurfaceCandidates(null)).toEqual([]);
  });

  it("rejects revoked and single-use spent grants", () => {
    const revoked = evaluateClosedVerb({
      verb: "release-rollback",
      target: "0.1.0",
      grants: [
        grant({
          operations: ["release-rollback"],
          surfaces: [],
          revokedAt: "2026-07-01T00:00:00Z",
        }),
      ],
      env: {},
    });
    expect(revoked.code).toBe("closed-verb-deny-revoked");

    const spent = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.1.0",
      grants: [
        grant({
          operations: ["release-publish"],
          surfaces: [],
          singleUse: true,
          usedAt: "2026-07-01T00:00:00Z",
        }),
      ],
      env: {},
    });
    expect(spent.code).toBe("closed-verb-deny-spent");
  });

  it("rejects grant with mismatched repo binding", () => {
    const g = grant({ operations: ["release-publish"], surfaces: [] });
    const bound: HumanOriginGrant = {
      ...g,
      scope: { ...g.scope, repo: "other/repo" },
    };
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.30.0",
      grants: [bound],
      env: {},
      repo: "deftai/directive",
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("closed-verb-deny-scope");
    expect(d.reason).toMatch(/repo\/branch/);
  });

  it("allows grant when repo binding matches", () => {
    const g = grant({ operations: ["release-publish"], surfaces: [] });
    const bound: HumanOriginGrant = {
      ...g,
      scope: { ...g.scope, repo: "deftai/directive" },
    };
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.30.0",
      grants: [bound],
      env: {},
      repo: "deftai/directive",
    });
    expect(d.allowed).toBe(true);
  });

  it("env true/yes bypass and closedVerbEnvBypassKey", () => {
    expect(
      evaluateClosedVerb({
        verb: "release-cut",
        target: "1.0.0",
        grants: [],
        env: { DEFT_ALLOW_RELEASE_CUT: "true" },
      }).code,
    ).toBe("closed-verb-env-bypass");
    expect(
      evaluateClosedVerb({
        verb: "release-rollback",
        target: "1.0.0",
        grants: [],
        env: { DEFT_ALLOW_RELEASE_ROLLBACK: "yes" },
      }).code,
    ).toBe("closed-verb-env-bypass");
    expect(closedVerbEnvBypassKey("release-publish")).toBe("DEFT_ALLOW_RELEASE_PUBLISH");
    expect(closedVerbEnvBypassKey("nope")).toBeNull();
  });

  it("loads classification from projectRoot when present", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.30.0",
      grants: [],
      env: {},
      projectRoot: process.cwd(),
    });
    expect(d.allowed).toBe(false);
    expect(d.envBypassKey).toBe("DEFT_ALLOW_RELEASE_PUBLISH");
  });

  it("sanitises newlines in verb key", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish\n",
      target: "0.1.0",
      grants: [],
      env: {},
    });
    expect(d.verb).not.toMatch(/\n/);
  });

  it("rejects missing target when surfaces pinned", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: null,
      grants: [grant({ operations: ["release-publish"], surfaces: ["0.1.0"] })],
      env: {},
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("closed-verb-deny-scope");
  });

  it("rejects non-human origin kinds without rejected set", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "0.1.0",
      grants: [grant({ kind: "mystery", actor: "someone", operations: ["release-publish"] })],
      env: {},
    });
    expect(d.code).toBe("closed-verb-deny-origin");
  });

  it("honors branch binding and wildcard surfaces when allowed by table", () => {
    const g = grant({ operations: ["release-publish"], surfaces: ["*"] });
    const bound: HumanOriginGrant = {
      ...g,
      scope: { ...g.scope, branch: "master", surfaces: ["*"] },
    };
    expect(
      evaluateClosedVerb({
        verb: "release-publish",
        target: "9.9.9",
        grants: [bound],
        env: {},
        branch: "develop",
      }).code,
    ).toBe("closed-verb-deny-scope");

    const table = builtinReleaseVerbClassification();
    const publishRow = table.verbs["release-publish"];
    expect(publishRow).toBeDefined();
    const wildTable = {
      ...table,
      verbs: {
        ...table.verbs,
        "release-publish": { ...publishRow, wildcard_allowed: true },
      },
    };
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: "9.9.9",
      grants: [bound],
      env: {},
      branch: "master",
      classification: wildTable,
    });
    expect(d.allowed).toBe(true);
  });

  it("closedVerbEnvBypassKey loads from projectRoot", () => {
    expect(closedVerbEnvBypassKey("release-cut", process.cwd())).toBe("DEFT_ALLOW_RELEASE_CUT");
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

  it("resolveClosedVerbTemplate rejects non-release templates and empty target", () => {
    // finish-loop is an AFK template (#871) but not a closed-verb release template
    expect(() => resolveClosedVerbTemplate({ template: "finish-loop", target: "x" })).toThrow(
      /unknown closed-verb template|finish-loop/,
    );
    expect(() => resolveClosedVerbTemplate({ template: "not-a-template", target: "x" })).toThrow(
      /unknown closed-verb template/,
    );
    expect(() => resolveClosedVerbTemplate({ template: "release-cut", target: "  " })).toThrow(
      /non-empty --target/,
    );
  });

  it("mintClosedVerbTemplateGrant uses operator-cli origin only", () => {
    const root = mkdtempSync(join(tmpdir(), "authz-tpl-"));
    try {
      const g = mintClosedVerbTemplateGrant({
        projectRoot: root,
        template: "release-publish",
        target: "0.31.0",
        actor: "msadams",
        singleUse: true,
        expiresAt: "2026-12-01T00:00:00Z",
      });
      expect(g.origin.kind).toBe("operator-cli");
      expect(g.scope.operations).toEqual(["release-publish"]);
      expect(g.scope.surfaces).toEqual(expect.arrayContaining(["0.31.0", "v0.31.0"]));
      expect(g.semantics.singleUse).toBe(true);
      expect(g.semantics.expiresAt).toBe("2026-12-01T00:00:00Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dual-mint guard: session-auth is not authorization SoT", () => {
    const guard = assertNoIndependentSessionAuthMint();
    expect(guard.mintPath).toBe("mintHumanOriginGrant");
    expect(guard.sessionAuthIsAuthority).toBe(false);
  });

  it("template name guards and finish-loop resolve edges (#2986)", () => {
    expect(isClosedVerbTemplateName("release-cut")).toBe(true);
    expect(isClosedVerbTemplateName("finish-loop")).toBe(false);
    expect(isFinishLoopTemplateName(" Finish-Loop ")).toBe(true);
    expect(isAfkTemplateName("release-publish")).toBe(true);
    expect(isAfkTemplateName("nope")).toBe(false);

    const fl = resolveFinishLoopTemplate({
      now: new Date("2026-07-30T00:00:00Z"),
      durationHours: 0.4,
      surfaces: ["src/**"],
    });
    expect(fl.operations).toEqual(["edit", "push", "pr", "merge"]);
    expect(fl.surfaces).toEqual(["src/**"]);
    // durationHours < 1 floors to 1h via Math.max(1, floor(...)).
    expect(fl.expiresAt).toMatch(/2026-07-30T01:00:00Z/);

    const flExplicit = resolveFinishLoopTemplate({
      expiresAt: "2099-01-01T00:00:00Z",
    });
    expect(flExplicit.expiresAt).toBe("2099-01-01T00:00:00Z");
    expect(flExplicit.surfaces).toEqual([]);
  });

  it("mintAfkTemplateGrant dispatches finish-loop vs closed-verb vs rejects (#2986)", () => {
    const root = mkdtempSync(join(tmpdir(), "authz-afk-"));
    try {
      const fl = mintAfkTemplateGrant({
        projectRoot: root,
        template: "finish-loop",
        actor: "op",
        durationHours: 2,
        storyIds: ["s1"],
        issueIds: [1],
        cohortId: "c1",
      });
      expect(fl.origin.kind).toBe("operator-cli");
      expect(fl.scope.operations).toEqual(["edit", "push", "pr", "merge"]);
      expect(fl.scope.storyIds).toEqual(["s1"]);

      const cut = mintAfkTemplateGrant({
        projectRoot: root,
        template: "release-cut",
        target: "0.40.0",
        actor: "op",
      });
      expect(cut.scope.operations).toEqual(["release-cut"]);
      expect(cut.scope.surfaces).toEqual(expect.arrayContaining(["0.40.0", "v0.40.0"]));

      expect(() => mintAfkTemplateGrant({ projectRoot: root, template: "not-a-template" })).toThrow(
        /unknown AFK template/,
      );
      expect(() =>
        mintAfkTemplateGrant({ projectRoot: root, template: "release-publish", target: "  " }),
      ).toThrow(/non-empty --target/);
      expect(() =>
        mintAfkTemplateGrant({ projectRoot: root, template: "release-publish", target: null }),
      ).toThrow(/non-empty --target/);

      // Custom classification missing the template row fails closed.
      expect(() =>
        resolveClosedVerbTemplate({
          template: "release-publish",
          target: "1.0.0",
          classification: parseVerbClassification({
            schemaVersion: 1,
            verbs: {
              "release-cut": {
                closure_set: [],
                explicit_required: [],
                irreversibility: "destructive",
                wildcard_allowed: false,
                recurring_allowed: false,
                default_expiry: "not-hours",
                skill: "s",
                phase: "p",
                authz_operations: ["release-cut"],
                env_bypass: "DEFT_ALLOW_RELEASE_CUT",
              },
            },
          }),
        }),
      ).toThrow(/missing row/);

      // Non-Xh default_expiry falls through parseExpiryHours to 1h.
      const odd = resolveClosedVerbTemplate({
        template: "release-cut",
        target: "1.0.0",
        now: new Date("2026-07-30T00:00:00Z"),
        classification: parseVerbClassification({
          schemaVersion: 1,
          verbs: {
            "release-cut": {
              closure_set: [],
              explicit_required: [],
              irreversibility: "destructive",
              wildcard_allowed: false,
              recurring_allowed: false,
              default_expiry: "not-hours",
              skill: "s",
              phase: "p",
              authz_operations: ["release-cut"],
              env_bypass: "DEFT_ALLOW_RELEASE_CUT",
            },
          },
        }),
      });
      expect(odd.expiresAt).toMatch(/2026-07-30T01:00:00Z/);

      const flDirect = mintFinishLoopTemplateGrant({
        projectRoot: root,
        actor: "op",
        expiresAt: "2099-06-01T00:00:00Z",
        singleUse: true,
      });
      expect(flDirect.semantics.singleUse).toBe(true);
      expect(flDirect.semantics.expiresAt).toBe("2099-06-01T00:00:00Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verb-classification parse branches", () => {
  it("rejects invalid schema shapes", () => {
    expect(() => parseVerbClassification(null)).toThrow(/root must be an object/);
    expect(() => parseVerbClassification({ schemaVersion: 0, verbs: {} })).toThrow(/schemaVersion/);
    expect(() => parseVerbClassification({ schemaVersion: 1, verbs: "nope" })).toThrow(/verbs/);
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: {
          x: {
            closure_set: "bad",
            explicit_required: [],
            irreversibility: "destructive",
            wildcard_allowed: false,
            recurring_allowed: false,
            default_expiry: "1h",
            skill: "s",
            phase: "p",
            authz_operations: ["deployment"],
            env_bypass: "DEFT_ALLOW_X",
          },
        },
      }),
    ).toThrow(/array of strings/);
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: {
          x: {
            closure_set: [],
            explicit_required: [],
            irreversibility: "destructive",
            wildcard_allowed: false,
            recurring_allowed: false,
            default_expiry: "1h",
            skill: "s",
            phase: "p",
            authz_operations: [],
            env_bypass: "DEFT_ALLOW_X",
          },
        },
      }),
    ).toThrow(/authz_operations must be non-empty/);
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: {
          x: {
            closure_set: [],
            explicit_required: [],
            irreversibility: "destructive",
            wildcard_allowed: false,
            recurring_allowed: false,
            default_expiry: "1h",
            skill: "s",
            phase: "p",
            authz_operations: ["deployment"],
            env_bypass: "NOT_DEFT",
          },
        },
      }),
    ).toThrow(/env_bypass/);
  });

  it("loadVerbClassification fails closed on corrupt JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "verb-class-"));
    try {
      const dir = join(root, "conventions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "verb-classification.json"), "{not-json", "utf8");
      expect(() => loadVerbClassification(root)).toThrow(/failed to parse|verb-class-parse/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loadVerbClassification falls back to builtin when no file", () => {
    const root = mkdtempSync(join(tmpdir(), "verb-class-empty-"));
    try {
      const table = loadVerbClassification(root);
      expect(table.verbs["release-publish"]).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("covers remaining schema field reject branches (#2986)", () => {
    const baseRow = {
      closure_set: [],
      explicit_required: [],
      irreversibility: "destructive",
      wildcard_allowed: false,
      recurring_allowed: false,
      default_expiry: "1h",
      skill: "s",
      phase: "p",
      authz_operations: ["deployment"],
      env_bypass: "DEFT_ALLOW_X",
    };
    // Non-object verb row.
    expect(() => parseVerbClassification({ schemaVersion: 1, verbs: { x: "nope" } })).toThrow(
      /must be an object/,
    );
    // Missing / empty scalar fields.
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: { x: { ...baseRow, irreversibility: "" } },
      }),
    ).toThrow(/irreversibility/);
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: { x: { ...baseRow, wildcard_allowed: "yes" } },
      }),
    ).toThrow(/wildcard_allowed/);
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: { x: { ...baseRow, recurring_allowed: "no" } },
      }),
    ).toThrow(/recurring_allowed/);
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: { x: { ...baseRow, default_expiry: "  " } },
      }),
    ).toThrow(/default_expiry/);
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: { x: { ...baseRow, skill: "" } },
      }),
    ).toThrow(/skill/);
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: { x: { ...baseRow, phase: "" } },
      }),
    ).toThrow(/phase/);
    // Empty-string array entries + empty verbs map + empty verb name.
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: { x: { ...baseRow, closure_set: ["ok", "  "] } },
      }),
    ).toThrow(/non-empty strings/);
    expect(() => parseVerbClassification({ schemaVersion: 1, verbs: {} })).toThrow(
      /at least one row/,
    );
    expect(() =>
      parseVerbClassification({
        schemaVersion: 1,
        verbs: { "  ": baseRow },
      }),
    ).toThrow(/verb name must be non-empty/);
    // description optional string + case-insensitive getVerbRow.
    const table = parseVerbClassification({
      schemaVersion: 1,
      description: "test table",
      verbs: {
        "Release-Publish": baseRow,
      },
    });
    expect(table.description).toBe("test table");
    expect(getVerbRow(table, "release-publish")?.env_bypass).toBe("DEFT_ALLOW_X");
    expect(getVerbRow(table, "missing")).toBeNull();
    // Non-Error JSON parse failure path is hard; empty projectRoot still resolves cwd candidates.
    expect(resolveVerbClassificationPath("")).not.toBeNull();
    expect(resolveVerbClassificationPath(null)).not.toBeNull();
  });
});
