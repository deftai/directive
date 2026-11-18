/**
 * #6644: the acceptance-disposition grant records `deferred`, `not_applicable`
 * and `waived`. Each test names the Acceptance Criteria clause it covers.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGrant, saveGrant } from "../authz/store.js";
import { ACCEPTANCE_DISPOSITION_KEY } from "../scope/acceptance-evidence.js";
import {
  applyAcceptanceDispositionGrants,
  checkCitedAcceptanceDispositionGrants,
  formatAcceptanceDispositionCommand,
  mintAcceptanceDispositionTemplateGrant,
  resolveAcceptanceDispositionGrants,
  resolveAcceptanceDispositionStore,
} from "./acceptance-disposition-grant.js";

const PLAN_ID = "github.issue.6644";
const NOW = new Date("2026-11-18T10:00:00Z");
const LATER = new Date("2026-11-18T11:00:00Z");

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repo(): string {
  const base = mkdtempSync(join(tmpdir(), "disposition-values-"));
  bases.push(base);
  const main = join(base, "main");
  mkdirSync(main);
  git(main, ["init", "-q"]);
  git(main, ["config", "user.email", "test@example.com"]);
  git(main, ["config", "user.name", "test"]);
  writeFileSync(join(main, "README.md"), "x\n", "utf8");
  git(main, ["add", "README.md"]);
  git(main, ["commit", "-q", "-m", "init"]);
  return main;
}

function plan(): Record<string, unknown> {
  return {
    id: PLAN_ID,
    title: "story",
    status: "running",
    acceptance: {
      clauses: [
        { id: 5, text: "Clause five text." },
        { id: 12, text: "Clause twelve text." },
      ],
    },
    items: [
      { id: "clause.5", title: "Clause five text.", status: "pending" },
      { id: "clause.12", title: "Clause twelve text.", status: "pending" },
    ],
  };
}

function writeBrief(root: string, body: Record<string, unknown> = plan()): void {
  const dir = join(root, "xbrief", "active");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-11-18-6644-story.xbrief.json"),
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: body }, null, 2)}\n`,
    "utf8",
  );
}

function item(body: Record<string, unknown>, id: string): Record<string, unknown> {
  return (body.items as Record<string, unknown>[]).find((i) => i.id === id) as Record<
    string,
    unknown
  >;
}

function mintFor(
  root: string,
  extra: {
    disposition?: string;
    deferredTo?: string;
    storyIds?: string[];
    reason?: string;
  },
) {
  return mintAcceptanceDispositionTemplateGrant({
    projectRoot: root,
    planRef: PLAN_ID,
    storyIds: extra.storyIds ?? ["clause.5"],
    reason: extra.reason ?? "R",
    now: NOW,
    ...(extra.disposition === undefined ? {} : { disposition: extra.disposition }),
    ...(extra.deferredTo === undefined ? {} : { deferredTo: extra.deferredTo }),
  });
}

describe("acceptance-disposition grant values (#6644)", () => {
  it("clause 8: a not_applicable grant stamps clause 5 with the value, reason R and the grant id, no merge evidence", () => {
    const root = repo();
    writeBrief(root);
    const minted = mintFor(root, { disposition: "not_applicable" });
    if (!minted.ok) throw new Error(minted.reason);
    const body = plan();
    const applied = applyAcceptanceDispositionGrants({
      projectRoot: root,
      plan: body,
      now: LATER,
      recordedAt: LATER.toISOString(),
    });
    expect(applied).toMatchObject({
      ok: true,
      appliedIds: ["clause.5"],
      grantedClauses: [{ id: 5, disposition: "not_applicable", reason: "R" }],
    });
    const stamped = item(body, "clause.5");
    expect(stamped[ACCEPTANCE_DISPOSITION_KEY]).toMatchObject({
      disposition: "not_applicable",
      reason: "R",
      provenance: { grantId: minted.grant.id },
    });
    expect(
      (stamped[ACCEPTANCE_DISPOSITION_KEY] as Record<string, unknown>).deferred_to,
    ).toBeUndefined();
    expect(stamped["x-directive/evidence"]).toBeUndefined();
  });

  it("clause 9: waived with --deferred-to 7 refuses and names the flag; deferred without it refuses", () => {
    const root = repo();
    writeBrief(root);
    expect(mintFor(root, { disposition: "waived", deferredTo: "7" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("--deferred-to"),
    });
    expect(mintFor(root, { disposition: "deferred" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("--deferred-to"),
    });
    // The default value is deferred, as before.
    expect(mintFor(root, {})).toMatchObject({ ok: false });
    expect(mintFor(root, { disposition: "bogus", deferredTo: "7" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not_applicable"),
    });
  });

  it("clause 10: a grant minted before this change applies as deferred with its deferred_to", () => {
    const root = repo();
    writeBrief(root);
    const minted = mintFor(root, { deferredTo: "#6400" });
    if (!minted.ok) throw new Error(minted.reason);
    // Strip the stored value: a pre-#6644 grant has no such surface.
    const store = resolveAcceptanceDispositionStore(root);
    if (!store.ok) throw new Error(store.reason);
    const grant = loadGrant(store.root, minted.grant.id);
    if (grant === null) throw new Error("grant missing");
    saveGrant(store.root, {
      ...grant,
      scope: {
        ...grant.scope,
        surfaces: grant.scope.surfaces.filter(
          (s) => !s.startsWith("acceptance-disposition:disposition:"),
        ),
      },
    });
    const body = plan();
    const applied = applyAcceptanceDispositionGrants({
      projectRoot: root,
      plan: body,
      now: LATER,
      recordedAt: LATER.toISOString(),
    });
    expect(applied).toMatchObject({
      ok: true,
      grantedClauses: [{ id: 5, disposition: "deferred" }],
    });
    expect(item(body, "clause.5")[ACCEPTANCE_DISPOSITION_KEY]).toMatchObject({
      disposition: "deferred",
      deferred_to: "#6400",
    });
  });

  it("clause 11: a waived grant on clause 12 restamps from the grant and keeps waived with the grant id", () => {
    const root = repo();
    writeBrief(root);
    const minted = mintFor(root, { disposition: "waived", storyIds: ["clause.12"] });
    if (!minted.ok) throw new Error(minted.reason);
    const completed = plan();
    const row = item(completed, "clause.12");
    row.status = "completed";
    row[ACCEPTANCE_DISPOSITION_KEY] = {
      disposition: "waived",
      reason: "hand edited",
      recorded_at: LATER.toISOString(),
      provenance: { kind: "operator-cli", actor: "operator", grantId: minted.grant.id },
    };
    const checked = checkCitedAcceptanceDispositionGrants({
      projectRoot: root,
      plan: completed,
      now: LATER,
    });
    expect(checked).toMatchObject({ ok: true, rewrittenIds: ["clause.12"] });
    expect(item(completed, "clause.12")[ACCEPTANCE_DISPOSITION_KEY]).toMatchObject({
      disposition: "waived",
      reason: "R",
      provenance: { grantId: minted.grant.id },
    });
  });

  it("clause 12: a not_applicable grant whose clause text changed refuses with a remint that names --disposition not_applicable and no --deferred-to", () => {
    const root = repo();
    writeBrief(root);
    const minted = mintFor(root, { disposition: "not_applicable" });
    if (!minted.ok) throw new Error(minted.reason);
    const changed = plan();
    (changed.acceptance as { clauses: { id: number; text: string }[] }).clauses[0] = {
      id: 5,
      text: "Clause five text, changed.",
    };
    const resolved = resolveAcceptanceDispositionGrants({
      projectRoot: root,
      plan: changed,
      now: LATER,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain("--disposition not_applicable");
    expect(resolved.reason).not.toContain("--deferred-to");
    expect(formatAcceptanceDispositionCommand(PLAN_ID, ["clause.5"], null, "waived")).toContain(
      "--disposition waived",
    );
    expect(formatAcceptanceDispositionCommand(PLAN_ID, ["clause.5"], "#7", "deferred")).toContain(
      "--deferred-to #7",
    );
  });

  it("clause 13: a stored deferred grant with no deferred-to value is malformed and ignored", () => {
    const root = repo();
    writeBrief(root);
    const minted = mintFor(root, { deferredTo: "#6400" });
    if (!minted.ok) throw new Error(minted.reason);
    const store = resolveAcceptanceDispositionStore(root);
    if (!store.ok) throw new Error(store.reason);
    const grant = loadGrant(store.root, minted.grant.id);
    if (grant === null) throw new Error("grant missing");
    saveGrant(store.root, {
      ...grant,
      scope: {
        ...grant.scope,
        surfaces: grant.scope.surfaces.filter(
          (s) => !s.startsWith("acceptance-disposition:deferred-to:"),
        ),
      },
    });
    expect(
      resolveAcceptanceDispositionGrants({ projectRoot: root, plan: plan(), now: LATER }),
    ).toEqual({ ok: true, covers: [] });
  });
});
