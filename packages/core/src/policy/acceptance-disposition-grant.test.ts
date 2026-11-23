import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { revokeGrant } from "../authz/actions.js";
import { loadGrant, saveGrant } from "../authz/store.js";
import {
  ACCEPTANCE_DISPOSITION_KEY,
  ACCEPTANCE_DISPOSITION_TEMPLATE_NAME as SCOPE_ACCEPTANCE_DISPOSITION_TEMPLATE_NAME,
  formatAcceptanceDispositionCommand as scopeFormatAcceptanceDispositionCommand,
} from "../scope/acceptance-evidence.js";
import {
  ACCEPTANCE_DISPOSITION_DEFAULT_EXPIRY_HOURS,
  ACCEPTANCE_DISPOSITION_TEMPLATE_NAME,
  acceptanceDispositionCoverText,
  acceptanceDispositionDigest,
  applyAcceptanceDispositionGrants,
  canonicalAcceptanceDispositionId,
  checkCitedAcceptanceDispositionGrants,
  formatAcceptanceDispositionCommand,
  isAcceptanceDispositionTemplateName,
  listAcceptanceDispositionGrants,
  mintAcceptanceDispositionTemplateGrant,
  parseAcceptanceDispositionDeferredTo,
  recordAcceptanceDispositionUse,
  resolveAcceptanceDispositionGrants,
  resolveAcceptanceDispositionStore,
} from "./acceptance-disposition-grant.js";

const PLAN_ID = "github.issue.6318";
const NOW = new Date("2026-11-15T10:00:00Z");
const LATER = new Date("2026-11-15T11:00:00Z");
const AFTER_EXPIRY = new Date("2026-11-16T11:00:00Z");

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
function cloneWithDest(): { main: string; dest: string } {
  const base = mkdtempSync(join(tmpdir(), "disposition-grant-"));
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
  return { main, dest };
}

/** Clause 1 has a plan item; clause 2 has none; task-x is a plain plan item. */
function plan(clause2 = "Clause two text."): Record<string, unknown> {
  return {
    id: PLAN_ID,
    title: "story",
    status: "running",
    acceptance: {
      clauses: [
        { id: 1, text: "Clause one text." },
        { id: 2, text: clause2 },
      ],
    },
    items: [
      { id: "clause.1", title: "Clause one text.", status: "pending" },
      { id: "task-x", title: "Task X", status: "pending" },
    ],
  };
}

function writeBrief(root: string, body: Record<string, unknown> = plan()): void {
  const dir = join(root, "xbrief", "active");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-11-15-6318-story.xbrief.json"),
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: body }, null, 2)}\n`,
    "utf8",
  );
}

function mint(
  projectRoot: string,
  overrides: Partial<{
    storyIds: string[];
    deferredTo: string;
    reason: string;
    expiresAt: string | null;
    planRef: string;
    now: Date;
  }> = {},
) {
  return mintAcceptanceDispositionTemplateGrant({
    projectRoot,
    planRef: overrides.planRef ?? PLAN_ID,
    storyIds: overrides.storyIds ?? ["clause.2"],
    deferredTo: overrides.deferredTo ?? "#6400",
    reason: overrides.reason ?? "operator correction",
    expiresAt: overrides.expiresAt ?? null,
    now: overrides.now ?? NOW,
  });
}

describe("acceptance-disposition template (#6318)", () => {
  it("names, ids, deferred-to targets and digests", () => {
    expect(isAcceptanceDispositionTemplateName(" Acceptance-Disposition ")).toBe(true);
    expect(isAcceptanceDispositionTemplateName("delivery-identity-attest")).toBe(false);
    expect(canonicalAcceptanceDispositionId(" clause:3 ")).toBe("clause.3");
    expect(canonicalAcceptanceDispositionId("task-x")).toBe("task-x");
    expect(parseAcceptanceDispositionDeferredTo("6400")).toEqual({
      ok: true,
      target: "#6400",
      issueNumber: 6400,
    });
    expect(parseAcceptanceDispositionDeferredTo("DeftAI/Directive#7")).toEqual({
      ok: true,
      target: "deftai/directive#7",
      issueNumber: 7,
    });
    for (const bad of ["", "#0", "abc", "#12x", "owner#3"]) {
      expect(parseAcceptanceDispositionDeferredTo(bad).ok).toBe(false);
    }
    expect(acceptanceDispositionDigest("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(acceptanceDispositionCoverText(plan(), "clause:2")).toBe("Clause two text.");
    expect(acceptanceDispositionCoverText(plan(), "task-x")).toBe("Task X");
    expect(acceptanceDispositionCoverText(plan(), "clause.9")).toBeNull();
    expect(formatAcceptanceDispositionCommand(null, [], null)).toBe(
      `deft authz:grant -- --template ${ACCEPTANCE_DISPOSITION_TEMPLATE_NAME} --plan-ref <scopeId> ` +
        "--story-ids <itemIds> --disposition deferred --deferred-to <issue> --reason <text> --confirm",
    );
    // #7099: the formatter and its template name live in the scope module; this module re-exports them.
    expect(formatAcceptanceDispositionCommand).toBe(scopeFormatAcceptanceDispositionCommand);
    expect(ACCEPTANCE_DISPOSITION_TEMPLATE_NAME).toBe(SCOPE_ACCEPTANCE_DISPOSITION_TEMPLATE_NAME);
    expect(formatAcceptanceDispositionCommand(PLAN_ID, ["clause.2"], null, "not_applicable")).toBe(
      `deft authz:grant -- --template acceptance-disposition --plan-ref ${PLAN_ID} ` +
        "--story-ids clause.2 --disposition not_applicable --reason <text> --confirm",
    );
  });

  it("mints from a linked dest into the main clone store with per-id digests and a 24-hour expiry", () => {
    const { main, dest } = cloneWithDest();
    writeBrief(dest);
    const minted = mint(dest, { storyIds: ["clause:2", "task-x", "clause.2"] });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.storeRoot.toLowerCase()).toBe(main.toLowerCase());
    expect(minted.itemIds).toEqual(["clause.2", "task-x"]);
    expect(ACCEPTANCE_DISPOSITION_DEFAULT_EXPIRY_HOURS).toBe(24);
    expect(minted.grant.semantics).toMatchObject({
      singleUse: true,
      expiresAt: "2026-11-16T10:00:00Z",
      usedAt: null,
    });
    expect(minted.grant.origin.kind).toBe("operator-cli");
    expect(minted.grant.scope.issueIds).toEqual([6400]);
    expect(minted.grant.scope.surfaces).toContain(
      `acceptance-disposition:item:clause.2@sha256:${acceptanceDispositionDigest("Clause two text.")}`,
    );
    expect(minted.grant.scope.surfaces).toContain(
      `acceptance-disposition:item:task-x@sha256:${acceptanceDispositionDigest("Task X")}`,
    );
    expect(existsSync(join(main, ".deft", "authz", "grants", `${minted.grant.id}.json`))).toBe(
      true,
    );
    expect(existsSync(join(dest, ".deft", "authz", "grants"))).toBe(false);
    const listed = listAcceptanceDispositionGrants(dest);
    expect(listed.ok && listed.grants.map((g) => g.id)).toEqual([minted.grant.id]);
  });

  it("finds the brief in the main clone when the dest has none", () => {
    const { main, dest } = cloneWithDest();
    writeBrief(main);
    expect(mint(dest).ok).toBe(true);
  });

  it("validates every operator input at mint", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const refusals: [Parameters<typeof mint>[1], RegExp][] = [
      [{ planRef: " " }, /--plan-ref/],
      [{ storyIds: [" "] }, /--story-ids/],
      [{ deferredTo: "soon" }, /--deferred-to/],
      [{ reason: " " }, /--reason/],
      [{ reason: "two\nlines" }, /--reason/],
      [{ expiresAt: "not-a-date" }, /not a readable date/],
      [{ expiresAt: "2026-11-15T09:00:00Z" }, /not in the future/],
      [{ planRef: "github.issue.1" }, /no active, pending, proposed or completed brief/],
      [{ storyIds: ["clause.9"] }, /neither an acceptance clause/],
    ];
    for (const [overrides, reason] of refusals) {
      expect(mint(dest, overrides)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(reason),
      });
    }
    const notGit = mkdtempSync(join(tmpdir(), "disposition-nogit-"));
    bases.push(notGit);
    writeBrief(notGit);
    expect(mint(notGit)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/store cannot be resolved/),
    });
    expect(resolveAcceptanceDispositionStore(notGit).ok).toBe(false);
    expect(listAcceptanceDispositionGrants(notGit).ok).toBe(false);
    expect(recordAcceptanceDispositionUse({ projectRoot: notGit, grantIds: ["g"] }).ok).toBe(false);
  });

  it("resolves a live grant, then replays it once used", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const minted = mint(dest);
    if (!minted.ok) throw new Error(minted.reason);
    const live = resolveAcceptanceDispositionGrants({
      projectRoot: dest,
      plan: plan(),
      now: LATER,
    });
    expect(live).toMatchObject({
      ok: true,
      covers: [
        { itemId: "clause.2", grantId: minted.grant.id, replay: false, deferredTo: "#6400" },
      ],
    });
    expect(
      recordAcceptanceDispositionUse({
        projectRoot: dest,
        grantIds: [minted.grant.id],
        now: LATER,
      }),
    ).toEqual({ ok: true });
    // A used grant replays even after its expiry (finalize retry / restamp).
    const replay = resolveAcceptanceDispositionGrants({
      projectRoot: dest,
      plan: plan(),
      now: AFTER_EXPIRY,
    });
    expect(replay).toMatchObject({ ok: true, covers: [{ replay: true }] });
  });

  it("clause.6: a first use or a replay after the clause text changed refuses and names a re-mint", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const minted = mint(dest);
    if (!minted.ok) throw new Error(minted.reason);
    const changed = plan("Clause two text, reworded.");
    const firstUse = resolveAcceptanceDispositionGrants({
      projectRoot: dest,
      plan: changed,
      now: LATER,
    });
    expect(firstUse).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/text of clause\.2 changed.*re-mint with `deft authz:grant/),
    });
    recordAcceptanceDispositionUse({ projectRoot: dest, grantIds: [minted.grant.id], now: LATER });
    const replay = resolveAcceptanceDispositionGrants({
      projectRoot: dest,
      plan: changed,
      now: LATER,
    });
    expect(replay).toMatchObject({ ok: false, reason: expect.stringMatching(/re-mint/) });
    // A covered item that no longer resolves also refuses.
    const gone = { ...plan(), acceptance: { clauses: [{ id: 1, text: "Clause one text." }] } };
    expect(
      resolveAcceptanceDispositionGrants({ projectRoot: dest, plan: gone, now: LATER }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer resolves/) });
  });

  it("an expired unused grant refuses, naming a re-mint or authz:revoke; a later grant or a revoke clears it", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const old = mint(dest);
    if (!old.ok) throw new Error(old.reason);
    const expired = resolveAcceptanceDispositionGrants({
      projectRoot: dest,
      plan: plan(),
      now: AFTER_EXPIRY,
    });
    expect(expired).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        new RegExp(`${old.grant.id}.*expired.*re-mint with .*authz:revoke -- ${old.grant.id}`),
      ),
    });
    const fresh = mint(dest, { now: new Date("2026-11-16T10:30:00Z") });
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(
      resolveAcceptanceDispositionGrants({ projectRoot: dest, plan: plan(), now: AFTER_EXPIRY }),
    ).toMatchObject({ ok: true, covers: [{ grantId: fresh.grant.id }] });

    // A later grant that covers fewer ids does not clear an expired one.
    const { dest: other } = cloneWithDest();
    writeBrief(other);
    const wide = mint(other, { storyIds: ["clause.2", "task-x"] });
    if (!wide.ok) throw new Error(wide.reason);
    expect(mint(other, { now: new Date("2026-11-16T10:30:00Z") }).ok).toBe(true);
    expect(
      resolveAcceptanceDispositionGrants({ projectRoot: other, plan: plan(), now: AFTER_EXPIRY })
        .ok,
    ).toBe(false);
    expect(revokeGrant({ projectRoot: resolveRoot(other), grantId: wide.grant.id }).ok).toBe(true);
    expect(
      resolveAcceptanceDispositionGrants({ projectRoot: other, plan: plan(), now: AFTER_EXPIRY })
        .ok,
    ).toBe(true);
  });

  it("an unreadable or missing expiry never authorizes an unused grant", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const minted = mint(dest);
    if (!minted.ok) throw new Error(minted.reason);
    const root = resolveRoot(dest);
    for (const expiresAt of ["not-a-date", null]) {
      const grant = loadGrant(root, minted.grant.id);
      if (grant === null) throw new Error("grant missing");
      saveGrant(root, { ...grant, semantics: { ...grant.semantics, expiresAt } });
      expect(
        resolveAcceptanceDispositionGrants({ projectRoot: dest, plan: plan(), now: LATER }),
      ).toMatchObject({ ok: false, reason: expect.stringMatching(/expired \(or is not active\)/) });
    }
  });

  it("ignores grants for another plan, malformed records and plans with no id or store", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const minted = mint(dest);
    if (!minted.ok) throw new Error(minted.reason);
    const otherPlan = { ...plan(), id: "github.issue.7" };
    expect(
      resolveAcceptanceDispositionGrants({ projectRoot: dest, plan: otherPlan, now: LATER }),
    ).toEqual({ ok: true, covers: [] });
    expect(
      resolveAcceptanceDispositionGrants({
        projectRoot: dest,
        plan: { ...plan(), id: 7 },
        now: LATER,
      }),
    ).toEqual({ ok: true, covers: [] });
    const root = resolveRoot(dest);
    const grant = loadGrant(root, minted.grant.id);
    if (grant === null) throw new Error("grant missing");
    saveGrant(root, {
      ...grant,
      scope: {
        ...grant.scope,
        surfaces: grant.scope.surfaces.map((s) =>
          s.startsWith("acceptance-disposition:item:") ? `${s.split("@")[0]}@sha256:zz` : s,
        ),
      },
    });
    expect(
      resolveAcceptanceDispositionGrants({ projectRoot: dest, plan: plan(), now: LATER }),
    ).toEqual({ ok: true, covers: [] });
    const notGit = mkdtempSync(join(tmpdir(), "disposition-nogit-"));
    bases.push(notGit);
    expect(
      resolveAcceptanceDispositionGrants({ projectRoot: notGit, plan: plan(), now: LATER }),
    ).toEqual({ ok: true, covers: [] });
  });

  it("applies the deferred disposition with the grant id in provenance and returns the originals", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const minted = mint(dest, { storyIds: ["task-x"] });
    if (!minted.ok) throw new Error(minted.reason);
    const body = plan();
    const applied = applyAcceptanceDispositionGrants({
      projectRoot: dest,
      plan: body,
      now: LATER,
      recordedAt: "2026-11-15T11:00:00Z",
    });
    expect(applied).toMatchObject({
      ok: true,
      appliedIds: ["task-x"],
      grantIdsToRecord: [minted.grant.id],
    });
    const item = (body.items as Record<string, unknown>[])[1] as Record<string, unknown>;
    expect(item[ACCEPTANCE_DISPOSITION_KEY]).toMatchObject({
      disposition: "deferred",
      reason: "operator correction",
      deferred_to: "#6400",
      provenance: { kind: "operator-cli", grantId: minted.grant.id },
    });
    // A clause with no plan item needs persistClauseKeyedPendingItems first.
    expect(mint(dest, { storyIds: ["clause.2"], now: LATER }).ok).toBe(true);
    expect(
      applyAcceptanceDispositionGrants({
        projectRoot: dest,
        plan: plan(),
        now: LATER,
        recordedAt: "2026-11-15T11:00:00Z",
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/clause\.2 have no plan item/) });
  });
});

function resolveRoot(projectRoot: string): string {
  const store = resolveAcceptanceDispositionStore(projectRoot);
  if (!store.ok) throw new Error(store.reason);
  return store.root;
}

describe("acceptance-disposition review fixes (#6343)", () => {
  it("orders grants minted within one second by their millisecond mint time", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const first = mint(dest, { reason: "first", now: new Date("2026-11-15T10:00:00.100Z") });
    const second = mint(dest, { reason: "second", now: new Date("2026-11-15T10:00:00.600Z") });
    if (!first.ok || !second.ok) throw new Error("mint failed");
    expect(first.grant.origin.mintedAt).toBe(second.grant.origin.mintedAt);
    const resolved = resolveAcceptanceDispositionGrants({
      projectRoot: dest,
      plan: plan(),
      now: LATER,
    });
    expect(resolved).toMatchObject({
      ok: true,
      covers: [{ grantId: second.grant.id, reason: "second" }],
    });
    // A record with no millisecond surface falls back to origin.mintedAt.
    const root = resolveRoot(dest);
    const grant = loadGrant(root, second.grant.id);
    if (grant === null) throw new Error("grant missing");
    saveGrant(root, {
      ...grant,
      scope: {
        ...grant.scope,
        surfaces: grant.scope.surfaces.filter(
          (s) => !s.startsWith("acceptance-disposition:minted-at:"),
        ),
      },
    });
    expect(
      resolveAcceptanceDispositionGrants({ projectRoot: dest, plan: plan(), now: LATER }).ok,
    ).toBe(true);
  });

  function completedPlan(
    grantId: string,
    text = "Clause two text.",
    recordedAt = "2026-11-15T11:00:00Z",
  ): Record<string, unknown> {
    const body = plan(text);
    (body.items as Record<string, unknown>[]).push({
      id: "clause.2",
      title: "clause.2",
      status: "completed",
      [ACCEPTANCE_DISPOSITION_KEY]: {
        disposition: "deferred",
        reason: "operator correction",
        recorded_at: recordedAt,
        provenance: { kind: "operator-cli", actor: "operator", grantId },
      },
    });
    return body;
  }

  function clause2(body: Record<string, unknown>): Record<string, unknown> {
    return (body.items as Record<string, unknown>[]).find((i) => i.id === "clause.2") as Record<
      string,
      unknown
    >;
  }

  it("a restamp replays every cited grant and refuses a changed clause or an unknown grant", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const minted = mint(dest);
    if (!minted.ok) throw new Error(minted.reason);
    const id = minted.grant.id;
    const check = (body: Record<string, unknown>, now = LATER) =>
      checkCitedAcceptanceDispositionGrants({ projectRoot: dest, plan: body, now });
    expect(check(plan())).toEqual({
      ok: true,
      grantIdsToRecord: [],
      replacedIds: [],
      rewrittenIds: [],
    });
    expect(check(completedPlan(id))).toEqual({
      ok: true,
      grantIdsToRecord: [id],
      replacedIds: [],
      rewrittenIds: ["clause.2"],
    });
    expect(check(completedPlan(id, "Reworded."))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /restamp\): the text of clause\.2 changed.*mint a replacement for the completed brief/,
      ),
    });
    expect(check(completedPlan("grant-unknown", "Reworded."))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/grant-unknown is not in .* \(revoked or missing\)/),
    });
    // An unused grant past expiry is refused, even when recorded_at predates the expiry:
    // the brief's own date is never proof of use (#6343 review).
    expect(check(completedPlan(id), AFTER_EXPIRY)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/expired \(or is not active\) before first use/),
    });
    expect(check(completedPlan(id, undefined, "2026-11-16T10:30:00Z"), AFTER_EXPIRY)).toMatchObject(
      {
        ok: false,
        reason: expect.stringMatching(/expired \(or is not active\) before first use/),
      },
    );
    // A used grant replays after its expiry.
    recordAcceptanceDispositionUse({ projectRoot: dest, grantIds: [id], now: LATER });
    expect(check(completedPlan(id), AFTER_EXPIRY)).toEqual({
      ok: true,
      grantIdsToRecord: [],
      replacedIds: [],
      rewrittenIds: ["clause.2"],
    });
    const notGit = mkdtempSync(join(tmpdir(), "disposition-nogit-"));
    bases.push(notGit);
    expect(
      checkCitedAcceptanceDispositionGrants({ projectRoot: notGit, plan: completedPlan(id) }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/store cannot be resolved/) });
  });

  it("a restamp applies a replacement grant minted for the completed brief", () => {
    const { main, dest } = cloneWithDest();
    // The brief is only in completed/: mint still finds it.
    mkdirSync(join(dest, "xbrief", "completed"), { recursive: true });
    writeFileSync(
      join(dest, "xbrief", "completed", "2026-11-15-6318-story.xbrief.json"),
      `${JSON.stringify({ plan: completedPlan("grant-old") })}\n`,
      "utf8",
    );
    const old = mint(dest);
    if (!old.ok) throw new Error(old.reason);
    expect(revokeGrant({ projectRoot: main, grantId: old.grant.id }).ok).toBe(true);
    const body = completedPlan(old.grant.id);
    expect(
      checkCitedAcceptanceDispositionGrants({ projectRoot: dest, plan: body, now: LATER }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/revoked or missing/) });
    const fresh = mint(dest, { reason: "replacement", now: LATER });
    if (!fresh.ok) throw new Error(fresh.reason);
    const replaced = checkCitedAcceptanceDispositionGrants({
      projectRoot: dest,
      plan: body,
      now: LATER,
      recordedAt: "2026-11-15T11:30:00Z",
    });
    expect(replaced).toEqual({
      ok: true,
      grantIdsToRecord: [fresh.grant.id],
      replacedIds: ["clause.2"],
      rewrittenIds: [],
    });
    expect(clause2(body)[ACCEPTANCE_DISPOSITION_KEY]).toMatchObject({
      reason: "replacement",
      recorded_at: "2026-11-15T11:30:00Z",
      provenance: { grantId: fresh.grant.id },
    });
  });
  it("a restamp rewrites a hand-edited cited disposition from its grant", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const minted = mint(dest);
    if (!minted.ok) throw new Error(minted.reason);
    const body = completedPlan(minted.grant.id);
    const item = clause2(body);
    item[ACCEPTANCE_DISPOSITION_KEY] = {
      disposition: "waived",
      reason: "hand-edited reason",
      recorded_at: "2026-11-15T11:00:00Z",
      deferred_to: "#1",
      provenance: { kind: "operator-cli", actor: "someone-else", grantId: minted.grant.id },
    };
    const checked = checkCitedAcceptanceDispositionGrants({
      projectRoot: dest,
      plan: body,
      now: LATER,
    });
    expect(checked).toMatchObject({ ok: true, rewrittenIds: ["clause.2"] });
    expect(item[ACCEPTANCE_DISPOSITION_KEY]).toEqual({
      disposition: "deferred",
      reason: "operator correction",
      recorded_at: "2026-11-15T11:00:00Z",
      deferred_to: "#6400",
      provenance: {
        kind: "operator-cli",
        actor: minted.grant.origin.actor,
        mintedAt: minted.grant.origin.mintedAt,
        mintedVia: minted.grant.origin.mintedVia,
        eventRef: minted.grant.origin.eventRef,
        grantId: minted.grant.id,
      },
    });
  });
  it("a restamp keys bare clause ids (string and number) to clause.N, then replays and rewrites them", () => {
    const { dest } = cloneWithDest();
    writeBrief(dest);
    const minted = mint(dest);
    if (!minted.ok) throw new Error(minted.reason);
    for (const bareId of ["2", 2] as const) {
      const withBare = (text?: string): Record<string, unknown> => {
        const body = completedPlan(minted.grant.id, text);
        const item = clause2(body);
        item.id = bareId;
        (item[ACCEPTANCE_DISPOSITION_KEY] as Record<string, unknown>).disposition = "waived";
        return body;
      };
      const body = withBare();
      const checked = checkCitedAcceptanceDispositionGrants({
        projectRoot: dest,
        plan: body,
        now: LATER,
      });
      expect(checked, String(bareId)).toMatchObject({ ok: true, rewrittenIds: ["clause.2"] });
      const item = (body.items as Record<string, unknown>[]).find((i) => i.id === bareId);
      expect(item?.[ACCEPTANCE_DISPOSITION_KEY], String(bareId)).toMatchObject({
        disposition: "deferred",
        provenance: { grantId: minted.grant.id },
      });
      // The digest is checked for both forms.
      expect(
        checkCitedAcceptanceDispositionGrants({
          projectRoot: dest,
          plan: withBare("Reworded."),
          now: LATER,
        }),
        String(bareId),
      ).toMatchObject({ ok: false, reason: expect.stringMatching(/text of clause\.2 changed/) });
    }
  });
});
