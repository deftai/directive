import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { revokeGrant } from "../authz/actions.js";
import { loadGrant, saveGrant } from "../authz/store.js";
import type { MergeTimeForge, PrFileEntry } from "../scope/delivery-evidence.js";
import { runTransition } from "../scope/transition.js";
import type { GitRunner } from "../session/git.js";
import {
  DELIVERY_IDENTITY_ATTEST_DEFAULT_EXPIRY_HOURS,
  DELIVERY_IDENTITY_ATTEST_TEMPLATE_NAME,
  findDeliveryIdentityAttestation,
  formatDeliveryIdentityAttestCommand,
  isDeliveryIdentityAttestTemplateName,
  listDeliveryIdentityAttestGrants,
  mintDeliveryIdentityAttestTemplateGrant,
  parseDeliveryIdentityAttestTarget,
  recordDeliveryIdentityAttestUse,
  resolveDeliveryIdentityAttestStore,
} from "./delivery-identity-attest-grant.js";

const REPO = "deftai/directive";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const PLAN_ID = "github.issue.6269";
const TARGET = `${REPO}#6280@${SHA}`;
const NOW = new Date("2026-11-15T10:00:00Z");

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A main clone with one commit and one linked dest worktree. */
function cloneWithDest(): { base: string; main: string; dest: string } {
  const base = mkdtempSync(join(tmpdir(), "attest-grant-"));
  bases.push(base);
  const main = join(base, "main");
  mkdirSync(main);
  git(main, ["init", "-q"]);
  git(main, ["config", "user.email", "test@example.com"]);
  git(main, ["config", "user.name", "test"]);
  writeFileSync(join(main, "README.md"), "x\n", "utf8");
  git(main, ["add", "README.md"]);
  git(main, ["commit", "-q", "-m", "init"]);
  const dest = join(base, "dest");
  git(main, ["worktree", "add", "-q", "-b", "dest-branch", dest]);
  return { base, main, dest };
}

function mint(projectRoot: string, overrides: Partial<{ target: string; planRef: string }> = {}) {
  return mintDeliveryIdentityAttestTemplateGrant({
    projectRoot,
    target: overrides.target ?? TARGET,
    planRef: overrides.planRef ?? PLAN_ID,
    now: NOW,
  });
}

function find(
  projectRoot: string,
  overrides: Partial<{ pr: number; sha: string; plan: string; now: Date }> = {},
) {
  return findDeliveryIdentityAttestation({
    projectRoot,
    repository: REPO,
    prNumber: overrides.pr ?? 6280,
    mergeCommitSha: overrides.sha ?? SHA,
    planId: overrides.plan ?? PLAN_ID,
    now: overrides.now ?? NOW,
  });
}

describe("delivery-identity-attest template (#6317)", () => {
  it("parses and canonicalises the target; malformed targets return failures", () => {
    const parsed = parseDeliveryIdentityAttestTarget(
      ` DeftAI/Directive#6280@${SHA.toUpperCase()} `,
    );
    expect(parsed).toEqual({
      ok: true,
      target: { repository: "DeftAI/Directive", prNumber: 6280, mergeCommitSha: SHA },
    });
    for (const bad of ["", "deftai/directive#6280", `deftai#6280@${SHA}`, `${REPO}#0@${SHA}`]) {
      expect(parseDeliveryIdentityAttestTarget(bad).ok).toBe(false);
    }
    expect(parseDeliveryIdentityAttestTarget(`${REPO}#6280@abc1234`)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/full commit sha/),
    });
    expect(isDeliveryIdentityAttestTemplateName(" Delivery-Identity-Attest ")).toBe(true);
    expect(isDeliveryIdentityAttestTemplateName("spec-drift-override")).toBe(false);
    expect(formatDeliveryIdentityAttestCommand(null, null)).toBe(
      `deft authz:grant --template ${DELIVERY_IDENTITY_ATTEST_TEMPLATE_NAME} ` +
        "--target <owner>/<repo>#<pr>@<merge_commit_sha> --plan-ref <scopeId> --confirm",
    );
  });

  it("mints an operator-cli, single-use grant with a 24-hour default expiry in the main clone store", () => {
    const { main, dest } = cloneWithDest();
    const minted = mint(dest);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.storeRoot.toLowerCase()).toBe(main.toLowerCase());
    expect(minted.grant.origin.kind).toBe("operator-cli");
    expect(minted.grant.semantics.singleUse).toBe(true);
    expect(minted.grant.scope.planRef).toBe(PLAN_ID);
    expect(DELIVERY_IDENTITY_ATTEST_DEFAULT_EXPIRY_HOURS).toBe(24);
    expect(minted.grant.semantics.expiresAt).toBe("2026-11-16T10:00:00Z");
    // The grant file lives in the main clone, not the linked dest.
    expect(existsSync(join(main, ".deft", "authz", "grants", `${minted.grant.id}.json`))).toBe(
      true,
    );
    expect(existsSync(join(dest, ".deft", "authz", "grants"))).toBe(false);
    const listed = listDeliveryIdentityAttestGrants(dest);
    expect(listed.ok && listed.grants.map((g) => g.id)).toEqual([minted.grant.id]);
  });

  it("mint refuses a bad target, an empty plan ref, or an unresolvable store root", () => {
    const { dest } = cloneWithDest();
    expect(mint(dest, { target: "nope" })).toMatchObject({ ok: false });
    expect(mint(dest, { planRef: "  " })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/--plan-ref/),
    });
    const notGit = mkdtempSync(join(tmpdir(), "attest-nogit-"));
    bases.push(notGit);
    expect(mint(notGit)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/store cannot be resolved/),
    });
    expect(resolveDeliveryIdentityAttestStore(notGit).ok).toBe(false);
    expect(find(notGit)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/store cannot be resolved/),
    });
    expect(recordDeliveryIdentityAttestUse({ projectRoot: notGit, grantId: "x" }).ok).toBe(false);
    expect(listDeliveryIdentityAttestGrants(notGit).ok).toBe(false);
  });

  it("a grant minted from a linked dest is found from the primary, and use is recorded once", () => {
    const { main, dest } = cloneWithDest();
    const minted = mint(dest);
    if (!minted.ok) throw new Error(minted.reason);
    const found = find(main);
    expect(found).toEqual({ ok: true, grantId: minted.grant.id, replay: false });
    expect(
      recordDeliveryIdentityAttestUse({ projectRoot: main, grantId: minted.grant.id, now: NOW }),
    ).toEqual({
      ok: true,
    });
    // A later run for the same plan, PR and merge commit accepts the used grant, even after expiry.
    expect(find(dest, { now: new Date("2026-12-01T00:00:00Z") })).toEqual({
      ok: true,
      grantId: minted.grant.id,
      replay: true,
    });
    expect(recordDeliveryIdentityAttestUse({ projectRoot: dest, grantId: "missing" }).ok).toBe(
      false,
    );
  });

  it("clause.8: an expired unused grant and a grant for another PR, commit or plan refuse", () => {
    const { main, dest } = cloneWithDest();
    const minted = mint(dest);
    if (!minted.ok) throw new Error(minted.reason);
    const expired = find(main, { now: new Date("2026-11-17T00:00:00Z") });
    expect(expired).toMatchObject({ ok: false });
    if (!expired.ok) {
      expect(expired.reason).toMatch(/expired \(or is not active\) before first use/);
      expect(expired.reason).toMatch(
        /re-mint with `deft authz:grant --template delivery-identity-attest/,
      );
      expect(expired.reason).toMatch(/authz:revoke/);
    }
    for (const other of [{ pr: 6281 }, { sha: OTHER_SHA }, { plan: "github.issue.1" }]) {
      expect(find(main, other)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/no delivery-identity-attest grant/),
      });
    }
    expect(find(main, { plan: " " })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no plan id/),
    });
    // A revoked grant (from the dest) never attests.
    expect(revokeGrant({ projectRoot: main, grantId: minted.grant.id }).ok).toBe(true);
    expect(find(main)).toMatchObject({ ok: false });
  });

  it("an agent-origin or tampered grant record is not an attestation", () => {
    const { main } = cloneWithDest();
    const minted = mint(main);
    if (!minted.ok) throw new Error(minted.reason);
    const forged = {
      ...minted.grant,
      origin: { ...minted.grant.origin, kind: "agent-authored" },
    };
    expect(saveGrant(main, forged).ok).toBe(true);
    expect(loadGrant(main, minted.grant.id)?.origin.kind).toBe("agent-authored");
    expect(find(main)).toMatchObject({ ok: false });
  });
});

describe("attested completion lifecycle (#6317 clause.7 / clause.8)", () => {
  const ISSUE = 6269;
  const PR = 6280;

  const gitAncestry: GitRunner = (_cwd, args) => {
    const joined = args.join(" ");
    if (joined.includes("merge-base") && joined.includes("--is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("rev-parse") && joined.includes("origin/")) {
      return { code: 0, stdout: "deliverytip", stderr: "" };
    }
    if (joined.includes("symbolic-ref")) {
      return { code: 0, stdout: "origin/master", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };

  function forge(files?: readonly PrFileEntry[], revisionsFail = false): MergeTimeForge {
    const page = <T>(nodes: readonly T[]) => ({
      ok: true as const,
      nodes,
      hasNextPage: false,
      endCursor: null,
    });
    return {
      listMergedPrsPage: () => page([]),
      fetchBodyRevisionsPage: () =>
        revisionsFail ? { ok: false, error: "revision read failed" } : page([]),
      fetchConnectionEventsPage: () => page([]),
      fetchPrFilesPage: () =>
        page(files ?? [{ status: "modified", filename: "packages/core/src/x.ts" }]),
      probeRateLimit: () => ({ graphqlRemaining: 5000, coreRemaining: 5000 }),
      nowMs: () => 0,
    };
  }

  function writeBrief(root: string, items: unknown[] = []): string {
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    const path = join(root, "xbrief", "active", `2026-11-15-${ISSUE}-story.xbrief.json`);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            id: PLAN_ID,
            title: "stranded story",
            status: "running",
            references: [
              { uri: `https://github.com/${REPO}/issues/${ISSUE}`, type: "x-xbrief/github-issue" },
            ],
            metadata: { kind: "story", swarm: { file_scope: ["packages/core/src/x.ts"] } },
            items,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return path;
  }

  function complete(
    path: string,
    opts: { forge?: MergeTimeForge; finalize?: boolean; body?: string } = {},
  ) {
    return runTransition("complete", path, new Date("2026-11-15T12:00:00Z"), {
      runGit: gitAncestry,
      fetchPrPayload: (n, repo) =>
        n === PR && repo === REPO
          ? {
              merged_at: "2026-11-14T10:00:00Z",
              merge_commit_sha: SHA,
              base: { ref: "master" },
              head: { sha: "headsha" },
              body: opts.body ?? `Refs #${ISSUE}`,
            }
          : null,
      mergeTimeForge: opts.forge ?? forge(),
      deliveryEvidence: { prNumber: PR, mergeCommit: SHA, mergedAt: "2026-11-14T10:00:00Z" },
      ...(opts.finalize === true
        ? { assumeEvidenceValidated: true, verifier: "swarm:finalize-cohort" }
        : {}),
    });
  }

  it("clause.7: an acceptance refusal after the join leaves the grant unused; finalize retry and restamp pass", () => {
    const { main, dest } = cloneWithDest();
    const minted = mint(dest);
    if (!minted.ok) throw new Error(minted.reason);
    const uat = {
      id: "clause.1",
      title: "UAT sign-off",
      status: "pending",
      "x-directive/requires": "uat",
    };
    const path = writeBrief(main, [uat]);

    const refused = complete(path);
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/Acceptance evidence required/);
    expect(loadGrant(main, minted.grant.id)?.semantics.usedAt).toBeNull();

    // Operator records UAT evidence; the finalize retry for the same target passes.
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      plan: { items: Record<string, unknown>[] };
    };
    data.plan.items = [
      {
        ...uat,
        "x-directive/evidence": {
          kind: "uat",
          pointer: "uat-evidence/6269/sign-off.md",
          recorded_at: "2026-11-15T11:00:00Z",
          recorded_by: "operator@example.com",
        },
      },
    ];
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    const retry = complete(path, { finalize: true });
    expect(retry.ok).toBe(true);
    expect(retry.message).toMatch(/recorded as used/);
    const used = loadGrant(main, minted.grant.id);
    expect(used?.semantics.usedAt).not.toBeNull();
    const done = join(main, "xbrief", "completed", `2026-11-15-${ISSUE}-story.xbrief.json`);
    const stored = JSON.parse(readFileSync(done, "utf8")) as {
      plan: { metadata: { completionProvenance: Record<string, unknown> } };
    };
    expect(stored.plan.metadata.completionProvenance).toMatchObject({
      identityBasis: "operator-attested",
      attestationGrantId: minted.grant.id,
      verifier: "swarm:finalize-cohort",
    });

    // Restamp for the same target accepts the used grant, even after expiry.
    const restamp = complete(done);
    expect(restamp.ok).toBe(true);
    expect(restamp.message).toMatch(/Restamped/);
    expect(loadGrant(main, minted.grant.id)?.semantics.usedAt).toBe(used?.semantics.usedAt);
  });

  it("clause.8: completion refuses on an expired unused grant, another target, an unreadable body, or a lifecycle-only PR", () => {
    const { main } = cloneWithDest();
    const path = writeBrief(main);

    // No grant at all: the refusal names the attest command for this PR and plan.
    const none = complete(path);
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(
      new RegExp(`--target ${REPO}#${PR}@${SHA} --plan-ref ${PLAN_ID} --confirm`),
    );

    // Expired unused grant.
    const expired = mintDeliveryIdentityAttestTemplateGrant({
      projectRoot: main,
      target: TARGET,
      planRef: PLAN_ID,
      expiresAt: "2026-11-15T11:00:00Z",
    });
    expect(expired.ok).toBe(true);
    const expiredRun = complete(path);
    expect(expiredRun.ok).toBe(false);
    expect(expiredRun.message).toMatch(/expired \(or is not active\) before first use/);
    if (expired.ok) revokeGrant({ projectRoot: main, grantId: expired.grant.id });

    // Grants for another PR, commit or plan.
    for (const other of [
      { target: `${REPO}#6281@${SHA}` },
      { target: `${REPO}#${PR}@${OTHER_SHA}` },
      { planRef: "github.issue.1" },
    ]) {
      expect(mint(main, other).ok).toBe(true);
    }
    expect(complete(path).ok).toBe(false);

    // A matching grant still refuses on an unreadable body or a lifecycle-only PR.
    expect(mint(main).ok).toBe(true);
    const unreadable = complete(path, { forge: forge(undefined, true) });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.message).toMatch(/merge-time body unreadable/);
    const lifecycle = complete(path, {
      forge: forge([{ status: "modified", filename: "CHANGELOG.md" }]),
    });
    expect(lifecycle.ok).toBe(false);
    expect(lifecycle.message).toMatch(/\(d\) PR #6280 changes only briefs and CHANGELOG.md/);
    expect(existsSync(path)).toBe(true);
  });
});
