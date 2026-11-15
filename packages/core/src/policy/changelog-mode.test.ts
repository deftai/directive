import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHANGELOG_MODES,
  DEFAULT_CHANGELOG_MODE,
  FIELD_CHANGELOG_MODE,
  formatChangelogModeStatusLine,
  inspectChangelogMode,
  isChangelogModeFieldName,
  resolveChangelogMode,
  resolveChangelogModeFromPlan,
  setChangelogMode,
} from "./changelog-mode.js";
import { inspectAllPolicies, inspectOnePolicy, registeredPolicyNames } from "./index.js";

const PD_REL = join("xbrief", "PROJECT-DEFINITION.xbrief.json");

function writeProjectDef(root: string, plan: Record<string, unknown> | null, raw?: string): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  const path = join(root, PD_REL);
  if (raw !== undefined) {
    writeFileSync(path, raw);
    return;
  }
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], ...(plan ?? {}) },
    }),
  );
}

function readPolicy(root: string): Record<string, unknown> {
  const data = JSON.parse(readFileSync(join(root, PD_REL), "utf8")) as {
    plan: Record<string, unknown>;
  };
  return data.plan["x-directive/policy"] as Record<string, unknown>;
}

describe("changelog.mode policy (#6314)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  function root(): string {
    const r = mkdtempSync(join(tmpdir(), "deft-changelog-mode-"));
    roots.push(r);
    return r;
  }

  it("defaults to inline with no project definition or no policy value", () => {
    expect(DEFAULT_CHANGELOG_MODE).toBe("inline");
    expect(resolveChangelogMode(root())).toEqual({
      mode: "inline",
      source: "default",
      error: null,
    });
    const r = root();
    writeProjectDef(r, { "x-directive/policy": {} });
    expect(resolveChangelogMode(r)).toMatchObject({ mode: "inline", source: "default" });
    expect(resolveChangelogModeFromPlan({})).toMatchObject({ mode: "inline", source: "default" });
    expect(
      resolveChangelogModeFromPlan({ "x-directive/policy": { changelog: { mode: null } } }),
    ).toMatchObject({ mode: "inline", source: "default" });
  });

  it("policy:show --field=plan.policy.changelog.mode reports inline by default", () => {
    const r = root();
    writeProjectDef(r, null);
    expect(inspectOnePolicy(FIELD_CHANGELOG_MODE, r)).toEqual({
      name: FIELD_CHANGELOG_MODE,
      current: "inline",
      default: "inline",
      source: "default",
    });
    expect(inspectOnePolicy("changelog.mode", r)?.current).toBe("inline");
    expect(inspectOnePolicy("changelogMode", r)?.current).toBe("inline");
  });

  it("is field-only: the all-fields listing is unchanged", () => {
    const r = root();
    writeProjectDef(r, null);
    expect(registeredPolicyNames()).not.toContain(FIELD_CHANGELOG_MODE);
    expect(inspectAllPolicies(r).some((f) => f.name === FIELD_CHANGELOG_MODE)).toBe(false);
    expect(isChangelogModeFieldName("plan.policy.changelog.mode")).toBe(true);
    expect(isChangelogModeFieldName("changelog")).toBe(false);
  });

  it("reads typed values and reports malformed ones as inline default-on-error", () => {
    for (const mode of CHANGELOG_MODES) {
      expect(
        resolveChangelogModeFromPlan({ "x-directive/policy": { changelog: { mode } } }),
      ).toEqual({ mode, source: "typed", error: null });
    }
    expect(
      resolveChangelogModeFromPlan({ "x-directive/policy": { changelog: { mode: "both" } } }),
    ).toMatchObject({ mode: "inline", source: "default-on-error", error: /got "both"/ });
    expect(
      resolveChangelogModeFromPlan({ "x-directive/policy": { changelog: { mode: 3 } } }),
    ).toMatchObject({ source: "default-on-error", error: /got number/ });
    expect(
      resolveChangelogModeFromPlan({ "x-directive/policy": { changelog: "fragments" } }),
    ).toMatchObject({ source: "default-on-error", error: /changelog must be an object/ });
    expect(resolveChangelogModeFromPlan({ "x-directive/policy": [] })).toMatchObject({
      source: "default-on-error",
    });
    const r = root();
    writeProjectDef(r, null, "{not-json");
    expect(resolveChangelogMode(r)).toMatchObject({ mode: "inline", source: "default-on-error" });
    expect(inspectChangelogMode(null, r).source).toBe("default-on-error");
    expect(inspectChangelogMode(null).source).toBe("default");
  });

  it("setter requires --confirm and accepts only inline, either and fragments", () => {
    const r = root();
    writeProjectDef(r, null);
    const unconfirmed = setChangelogMode(r, { mode: "either" });
    expect(unconfirmed.exitCode).toBe(1);
    expect(unconfirmed.stdout).toMatch(/--confirm/);
    expect(resolveChangelogMode(r).mode).toBe("inline");

    const bad = setChangelogMode(r, { mode: "both", confirm: true });
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toMatch(/inline\|either\|fragments/);

    for (const mode of ["either", "fragments", "inline"] as const) {
      const ok = setChangelogMode(r, { mode, confirm: true, note: "cut\nover" });
      expect(ok.exitCode).toBe(0);
      expect(ok.changed).toBe(true);
      expect(ok.stdout).toContain(`changelog.mode=${mode} (source=typed)`);
      expect(resolveChangelogMode(r)).toMatchObject({ mode, source: "typed" });
    }
    const again = setChangelogMode(r, { mode: "inline", confirm: true });
    expect(again).toMatchObject({ exitCode: 0, changed: false });
    expect(again.stdout).toMatch(/no-op/);
  });

  it("setter keeps sibling keys and refuses a non-object changelog block", () => {
    const r = root();
    writeProjectDef(r, { "x-directive/policy": { wipCap: 7, changelog: { other: true } } });
    expect(setChangelogMode(r, { mode: "fragments", confirm: true }).exitCode).toBe(0);
    expect(readPolicy(r)).toEqual({ wipCap: 7, changelog: { other: true, mode: "fragments" } });

    const r2 = root();
    writeProjectDef(r2, { "x-directive/policy": { changelog: "inline" } });
    const refused = setChangelogMode(r2, { mode: "either", confirm: true });
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toMatch(/plan.policy.changelog is not an object/);
  });

  it("setter reports a missing project definition", () => {
    const r = root();
    const missing = setChangelogMode(r, { mode: "either", confirm: true });
    expect(missing.exitCode).toBe(2);
    expect(existsSync(join(r, PD_REL))).toBe(false);
  });

  it("formats a status line", () => {
    expect(formatChangelogModeStatusLine({ mode: "either", source: "typed", error: null })).toBe(
      "[deft policy] changelog.mode=either (source=typed).",
    );
  });
});
