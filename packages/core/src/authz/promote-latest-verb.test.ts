import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPromoteLatest } from "../release-publish/pipeline.js";
import { closedVerbEnvBypassKey, evaluateClosedVerb } from "./closed-verb.js";
import type { HumanOriginGrant } from "./types.js";
import { builtinReleaseVerbClassification, loadVerbClassification } from "./verb-classification.js";

describe("release-promote-latest closed verb (#5852 P2)", () => {
  it("is its own row with its own env bypass key (builtin; file overlays builtin)", () => {
    const builtin = builtinReleaseVerbClassification().verbs["release-promote-latest"];
    const loaded = loadVerbClassification(process.cwd()).verbs["release-promote-latest"];
    expect(builtin?.env_bypass).toBe("DEFT_ALLOW_RELEASE_PROMOTE_LATEST");
    expect(loaded).toEqual(builtin);
    expect(builtin?.authz_operations).toEqual(["release-promote-latest"]);
    expect(builtin?.authz_operations).not.toContain("deployment");
    expect(closedVerbEnvBypassKey("release-promote-latest")).toBe(
      "DEFT_ALLOW_RELEASE_PROMOTE_LATEST",
    );
  });

  it("is not authorized by the release-publish bypass", () => {
    const d = evaluateClosedVerb({
      verb: "release-promote-latest",
      target: "0.129.0",
      grants: [],
      env: { DEFT_ALLOW_RELEASE_PUBLISH: "1" },
    });
    expect(d.allowed).toBe(false);
  });

  it("allows only via its own explicit bypass", () => {
    const d = evaluateClosedVerb({
      verb: "release-promote-latest",
      target: "0.129.0",
      grants: [],
      env: { DEFT_ALLOW_RELEASE_PROMOTE_LATEST: "1" },
    });
    expect(d.allowed).toBe(true);
  });
});

describe("runPromoteLatest exclusive claim before dispatch (#5852 Greptile P1)", () => {
  let root: string | null = null;
  afterEach(() => {
    vi.restoreAllMocks();
    if (root !== null) {
      rmSync(root, { recursive: true, force: true });
      root = null;
    }
  });

  it("claims and spends the single-use grant before workflow dispatch", () => {
    root = mkdtempSync(join(tmpdir(), "promote-claim-"));
    const grant: HumanOriginGrant = {
      schemaVersion: 1,
      id: "grant-promote-single",
      origin: {
        kind: "operator-cli",
        actor: "operator",
        mintedAt: "2026-11-01T00:00:00Z",
        mintedVia: "deft authz:grant",
        eventRef: "template:release-promote-latest",
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: null,
        surfaces: ["0.129.0", "v0.129.0"],
        operations: ["release-promote-latest"],
        storyIds: [],
        issueIds: [],
        cohortId: null,
      },
      semantics: { expiresAt: null, singleUse: true, usedAt: null, revokedAt: null },
    };
    const grantsDir = join(root, ".deft", "authz", "grants");
    mkdirSync(grantsDir, { recursive: true });
    writeFileSync(
      join(grantsDir, `${grant.id}.json`),
      `${JSON.stringify(grant, null, 2)}\n`,
      "utf8",
    );

    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let dispatched = false;
    let usedAtAtDispatch: string | null | undefined;
    const grantPath = join(grantsDir, `${grant.id}.json`);
    const rc = runPromoteLatest(
      { version: "0.129.0", repo: "deftai/directive", projectRoot: root, dryRun: false },
      {
        closedVerbGrants: [grant],
        closedVerbEnv: {},
        whichGh: () => "/usr/bin/gh",
        spawnText: () => {
          dispatched = true;
          const onDisk = JSON.parse(readFileSync(grantPath, "utf8")) as HumanOriginGrant;
          usedAtAtDispatch = onDisk.semantics.usedAt;
          return { status: 0, stdout: "", stderr: "" };
        },
      } as never,
    );
    expect(rc).toBe(0);
    expect(dispatched).toBe(true);
    expect(usedAtAtDispatch).toEqual(expect.any(String));
  });
});
