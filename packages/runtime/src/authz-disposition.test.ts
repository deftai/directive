/**
 * #6644: authz:grant --template acceptance-disposition takes --disposition.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HumanOriginGrant } from "@deftai/directive-core/authz";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthzMainSeams, main } from "./authz.js";

const PLAN = "github.issue.6644";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seams(): AuthzMainSeams {
  return {
    isTty: () => true,
    environ: {},
    hasControllingTerminal: () => true,
    readInteractiveConfirm: () => "mint",
  };
}

function runAuthz(argv: string[]): number {
  const mutating = argv.includes("grant");
  return main(mutating ? [...argv, "--confirm"] : argv, seams());
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repo(): string {
  const base = mkdtempSync(join(tmpdir(), "cli-disposition-"));
  roots.push(base);
  const root = join(base, "main");
  mkdirSync(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  writeFileSync(join(root, "README.md"), "x\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "init"]);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "active", "2026-11-18-6644-story.xbrief.json"),
    JSON.stringify({
      plan: {
        id: PLAN,
        title: "story",
        status: "running",
        acceptance: { clauses: [{ id: 5, text: "Clause five." }] },
        items: [],
      },
    }),
    "utf8",
  );
  return root;
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  return { out, err };
}

const base = (root: string): string[] => [
  "grant",
  "--project-root",
  root,
  "--template",
  "acceptance-disposition",
  "--plan-ref",
  PLAN,
  "--story-ids",
  "clause.5",
];

describe("authz CLI acceptance-disposition --disposition (#6644)", () => {
  it("mints not_applicable and waived with no --deferred-to and shows the stored value", () => {
    const root = repo();
    for (const value of ["not_applicable", "waived"]) {
      const { out } = capture();
      expect(runAuthz([...base(root), "--disposition", value, "--reason", "R"])).toBe(0);
      const text = out.join("");
      expect(text).toContain(`writes these items as ${value}`);
      const id = /id=(\S+)/.exec(text)?.[1] ?? "";
      const stored = JSON.parse(
        readFileSync(join(root, ".deft", "authz", "grants", `${id}.json`), "utf8"),
      ) as HumanOriginGrant;
      expect(stored.scope.surfaces).toContain(`acceptance-disposition:disposition:${value}`);
      expect(stored.scope.surfaces.some((s) => s.includes(":deferred-to:"))).toBe(false);
      out.length = 0;
      expect(runAuthz(["show", "--project-root", root])).toBe(0);
      expect(out.join("")).toContain(`disposition=${value}`);
      vi.restoreAllMocks();
    }
  });

  it("keeps deferred as the default and requires --deferred-to for it only", () => {
    const root = repo();
    const { out, err } = capture();
    expect(runAuthz([...base(root), "--deferred-to", "#6400", "--reason", "R"])).toBe(0);
    expect(out.join("")).toContain("writes these items as deferred");
    err.length = 0;
    expect(runAuthz([...base(root), "--reason", "R"])).toBe(2);
    expect(err.join("")).toMatch(/requires --deferred-to <issue>/);
    err.length = 0;
    expect(runAuthz([...base(root), "--disposition", "deferred", "--reason", "R"])).toBe(2);
    expect(err.join("")).toMatch(/requires --deferred-to <issue>/);
  });

  it("refuses --deferred-to for a new value, a missing reason and an unknown value", () => {
    const root = repo();
    const { err } = capture();
    err.length = 0;
    expect(
      runAuthz([...base(root), "--disposition", "waived", "--deferred-to", "7", "--reason", "R"]),
    ).toBe(2);
    expect(err.join("")).toContain("--deferred-to");
    err.length = 0;
    expect(runAuthz([...base(root), "--disposition", "waived"])).toBe(2);
    expect(err.join("")).toMatch(/requires --reason <text>/);
    err.length = 0;
    expect(
      runAuthz([...base(root), "--disposition", "bogus", "--deferred-to", "7", "--reason", "R"]),
    ).toBe(2);
    expect(err.join("")).toContain("must be one of");
  });
});
