/**
 * `kill-switch:on` / `kill-switch:off` (#6740): on takes the kept terminal mint
 * and refuses under UAT; off removes the record with --confirm and no mint.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUatLease } from "@deftai/directive-core/authz";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeArgv } from "./cli-router/route-argv.js";
import { KILL_SWITCH_ALIAS_SUBCOMMANDS, resolveCanonicalVerb } from "./dispatch.js";
import { type KillSwitchSeams, parseArgs, run } from "./kill-switch.js";

const RECORD = join(".deft", "authz", "kill-switch.disable");

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "w6740c1-ks-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  return root;
}

function gitDir(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], {
    encoding: "utf8",
  }).replace(/\n+$/, "");
}

interface Captured {
  readonly out: string[];
  readonly err: string[];
}

/** Seams for a person at a terminal: no markers, TTY, controlling terminal, typed phrase. */
function operator(captured: Captured, extra: Partial<KillSwitchSeams> = {}): KillSwitchSeams {
  return {
    environ: {},
    isTty: () => true,
    hasControllingTerminal: () => true,
    readInteractiveConfirm: () => "mint",
    recordOperatorStop: () => undefined,
    now: () => new Date("2026-11-22T10:00:00.000Z"),
    writeOut: (t) => captured.out.push(t),
    writeErr: (t) => captured.err.push(t),
    ...extra,
  };
}

function capture(): Captured {
  // refuseNonInteractiveMint / refuseMintWhileUatActive write to process.stderr.
  const captured: Captured = { out: [], err: [] };
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    captured.err.push(String(c));
    return true;
  });
  return captured;
}

describe("kill-switch:on (#6740)", () => {
  it("writes the plain-line record bound to git rev-parse --absolute-git-dir after the mint", () => {
    const root = repo();
    const c = capture();
    expect(run(["on", "--confirm", "--project-root", root], operator(c))).toBe(0);
    const text = readFileSync(join(root, RECORD), "utf8");
    expect(text).toBe(
      `schema=deft.kill-switch.v1\ngitDir=${gitDir(root)}\nmintedAt=2026-11-22T10:00:00Z\nmintedVia=kill-switch:on\n`,
    );
    expect(c.out.join("")).toContain("kill-switch:off --confirm");
  });

  it("refuses an agent-marked shell and writes nothing", () => {
    const root = repo();
    const c = capture();
    const code = run(
      ["on", "--confirm", "--project-root", root],
      operator(c, { environ: { CLAUDECODE: "1" } }),
    );
    expect(code).toBe(2);
    expect(existsSync(join(root, RECORD))).toBe(false);
    expect(c.err.join("")).toMatch(/agent-shell env markers: CLAUDECODE/);
  });

  it("refuses a CI shell and writes nothing", () => {
    const root = repo();
    const c = capture();
    expect(
      run(["on", "--confirm", "--project-root", root], operator(c, { environ: { CI: "true" } })),
    ).toBe(2);
    expect(existsSync(join(root, RECORD))).toBe(false);
  });

  it("refuses a non-interactive caller and writes nothing", () => {
    const root = repo();
    const c = capture();
    expect(
      run(["on", "--confirm", "--project-root", root], operator(c, { isTty: () => false })),
    ).toBe(2);
    expect(existsSync(join(root, RECORD))).toBe(false);
  });

  it("refuses without --confirm or the typed phrase", () => {
    const root = repo();
    const c = capture();
    expect(run(["on", "--project-root", root], operator(c))).toBe(2);
    expect(
      run(
        ["on", "--confirm", "--project-root", root],
        operator(c, { readInteractiveConfirm: () => "yes" }),
      ),
    ).toBe(2);
    expect(existsSync(join(root, RECORD))).toBe(false);
  });

  it("refuses under an active UAT lease, even with every mint factor", () => {
    const root = repo();
    mkdirSync(join(root, ".deft"), { recursive: true });
    startUatLease({ projectRoot: root, campaignId: "uat-6740", actor: "op" });
    const c = capture();
    expect(run(["on", "--confirm", "--project-root", root], operator(c))).toBe(2);
    expect(existsSync(join(root, RECORD))).toBe(false);
    expect(c.err.join("")).toMatch(/UAT lease is ACTIVE/);
  });

  it("writes nothing when git cannot report the git dir", () => {
    const root = repo();
    const c = capture();
    expect(
      run(["on", "--confirm", "--project-root", root], operator(c, { absoluteGitDir: () => null })),
    ).toBe(2);
    expect(existsSync(join(root, RECORD))).toBe(false);
  });
});

describe("kill-switch:off (#6740)", () => {
  it("removes the record with --confirm and no mint, even from an agent shell", () => {
    const root = repo();
    const c = capture();
    expect(run(["on", "--confirm", "--project-root", root], operator(c))).toBe(0);
    const readConfirm = vi.fn(() => "mint");
    const code = run(
      ["off", "--confirm", "--project-root", root],
      operator(c, {
        environ: { CLAUDECODE: "1" },
        isTty: () => false,
        readInteractiveConfirm: readConfirm,
      }),
    );
    expect(code).toBe(0);
    expect(readConfirm).not.toHaveBeenCalled();
    expect(existsSync(join(root, RECORD))).toBe(false);
    expect(c.out.join("")).toContain("NEW agent session");
  });

  it("needs --confirm and leaves the record without it", () => {
    const root = repo();
    const c = capture();
    run(["on", "--confirm", "--project-root", root], operator(c));
    expect(run(["off", "--project-root", root], operator(c))).toBe(2);
    expect(existsSync(join(root, RECORD))).toBe(true);
  });

  it("on and off from a subfolder act on the checkout root's record", () => {
    const root = repo();
    const sub = join(root, "packages", "app");
    mkdirSync(sub, { recursive: true });
    const c = capture();
    expect(run(["on", "--confirm", "--project-root", sub], operator(c))).toBe(0);
    expect(existsSync(join(root, RECORD))).toBe(true);
    expect(existsSync(join(sub, RECORD))).toBe(false);
    expect(run(["off", "--confirm", "--project-root", sub], operator(c))).toBe(0);
    expect(existsSync(join(root, RECORD))).toBe(false);
  });

  it("is a no-op when there is no record", () => {
    const root = repo();
    const c = capture();
    expect(run(["off", "--confirm", "--project-root", root], operator(c))).toBe(0);
    expect(c.out.join("")).toContain("nothing to remove");
  });
});

describe("kill-switch wiring (#6740)", () => {
  it("parses the action and flags", () => {
    expect(parseArgs(["on", "--confirm"])).toMatchObject({ action: "on", confirm: true });
    expect(parseArgs(["off"]).action).toBe("off");
    expect(parseArgs([]).error).toMatch(/missing action/);
    expect(parseArgs(["on", "--bogus"]).error).toMatch(/unrecognized/);
  });

  it("routes kill-switch:on and kill-switch:off to the kill-switch module", () => {
    expect(resolveCanonicalVerb("kill-switch:on")).toBe("kill-switch");
    expect(resolveCanonicalVerb("kill-switch:off")).toBe("kill-switch");
    expect(KILL_SWITCH_ALIAS_SUBCOMMANDS).toEqual({
      "kill-switch:on": "on",
      "kill-switch:off": "off",
    });
    // Registered colon aliases stay on the flat path; dispatch maps them to the action.
    expect(routeArgv(["kill-switch:off", "--confirm"]).argv).toEqual([
      "kill-switch:off",
      "--confirm",
    ]);
    expect(routeArgv(["kill-switch", "off", "--confirm"]).argv).toEqual([
      "kill-switch",
      "off",
      "--confirm",
    ]);
  });
});
