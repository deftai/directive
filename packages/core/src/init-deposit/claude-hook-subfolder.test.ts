/**
 * #5959 / #6594 (AC9.1 + AC9.4 v261119): Claude hooks run from the agent's
 * current folder. The registered no-shell locator finds the committed outer
 * at the top of the Git checkout it is in, and hook-bin judges the payload at
 * that checkout top.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitCheckoutTop, projectRootFromHookPayload } from "../hooks/dispatcher.js";
import { isDirectiveHookCommand } from "../install-health/owned-paths.js";
import { hasDirectiveWiringEvidence } from "../install-health/wiring.js";
import { writeAgentHookDeposit } from "./agent-hooks.js";
import {
  HOST_HOOK_LOCATOR_NO_OUTER_MESSAGE,
  HOST_HOOK_LOCATOR_SOURCE,
  hostHookConfigEntryLines,
  hostHookEntryFields,
  hostHookEntryPrefix,
  hostHookEntryText,
  hostHookOuterRelPath,
  hostHookOuterSha8,
  hostHookOuterSource,
} from "./host-hook-outer.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SHA8 = hostHookOuterSha8();
const OUTER_REL = hostHookOuterRelPath("claude", SHA8);

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, stdio: "ignore" });
}

/**
 * A Directive checkout: committed outer plus a stub pin hook-bin that prints
 * which checkout ran it (`cwd` is the checkout root the outer found).
 */
function seedDirective(top: string, label: string): void {
  mkdirSync(join(top, ".claude"), { recursive: true });
  writeFileSync(join(top, OUTER_REL), hostHookOuterSource());
  const bin = join(top, "node_modules/@deftai/directive-runtime/dist/hook-bin.js");
  mkdirSync(join(bin, ".."), { recursive: true });
  writeFileSync(
    bin,
    `process.stdout.write(JSON.stringify({ label: ${JSON.stringify(label)}, cwd: process.cwd(), args: process.argv.slice(2) }));\n`,
  );
}

/** A Git repository with a workspace package and Directive deposited. */
function repo(): string {
  const top = tempDir("deft-locator-repo-");
  git(top, "init", "-q");
  writeFileSync(join(top, "package.json"), '{"name":"fx","private":true}\n');
  mkdirSync(join(top, "packages/app"), { recursive: true });
  writeFileSync(join(top, "packages/app/package.json"), '{"name":"app"}\n');
  seedDirective(top, "main");
  git(top, "add", "-A");
  git(top, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return top;
}

/** Run the registered Claude entry exactly as the host does (no shell). */
function runEntry(cwd: string, event = "tool.before") {
  const fields = hostHookEntryFields(
    `${hostHookEntryPrefix("claude", SHA8)} --host claude --event ${event}`,
  );
  const result = spawnSync(
    fields.command === "node" ? process.execPath : fields.command,
    fields.args ?? [],
    {
      cwd,
      input: "{}",
      encoding: "utf8",
    },
  );
  let decision: { label: string; cwd: string; args: string[] } | null = null;
  try {
    decision = JSON.parse(result.stdout);
  } catch {
    decision = null;
  }
  return { status: result.status, stderr: result.stderr, decision };
}

describe("Claude hook entry form (AC9.1 v261119)", () => {
  it("registers Claude as a no-shell locator and other hosts as node <rel>", () => {
    expect(
      hostHookEntryFields(`${hostHookEntryPrefix("claude", SHA8)} --host claude --event x`),
    ).toEqual({
      command: "node",
      args: ["-e", HOST_HOOK_LOCATOR_SOURCE, "--", OUTER_REL, "--host", "claude", "--event", "x"],
    });
    for (const host of ["codex", "grok", "cursor"] as const) {
      expect(hostHookEntryPrefix(host, SHA8)).toBe(`node ${hostHookOuterRelPath(host, SHA8)}`);
    }
  });

  it("keeps the locator to Node built-ins and stops at the first checkout top", () => {
    const required = [...HOST_HOOK_LOCATOR_SOURCE.matchAll(/require\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(required).toEqual(["node:fs", "node:path", "node:url"]);
    expect(HOST_HOOK_LOCATOR_SOURCE).not.toMatch(/package\.json|child_process|execSync/);
  });

  it("reads entries back as text; another node -e script is never Directive's", () => {
    const fields = hostHookEntryFields(
      `${hostHookEntryPrefix("claude", SHA8)} --host claude --event e`,
    );
    expect(hostHookEntryText(fields)).toBe(
      `node -e <locator> -- ${OUTER_REL} --host claude --event e`,
    );
    expect(isDirectiveHookCommand(hostHookEntryText(fields) ?? "")).toBe(true);
    // A user's own `node -e` hook that passes the same arguments keeps its text.
    const custom = { ...fields, args: ["-e", "log()", ...(fields.args ?? []).slice(2)] };
    expect(hostHookEntryText(custom)).toBe(`node -e log() -- ${OUTER_REL} --host claude --event e`);
    expect(isDirectiveHookCommand(hostHookEntryText(custom) ?? "")).toBe(false);
    expect(hostHookEntryText({ command: "echo hi" })).toBe("echo hi");
    expect(hostHookEntryText({ command: "node", args: [1] })).toBeNull();
    expect(hostHookConfigEntryLines("not json")).toBe("not json");
  });
});

describe("Claude locator from any folder (#5959 / #6594)", () => {
  it("runs the checkout's own outer from the root", () => {
    const top = repo();
    const run = runEntry(top);
    expect(run.status).toBe(0);
    expect(run.decision).toMatchObject({ label: "main", cwd: top });
    // #6740: the outer appends the kill-switch reader flag for the runtime.
    expect(run.decision?.args).toEqual([
      "--host",
      "claude",
      "--event",
      "tool.before",
      "--kill-switch-reader",
      "v1",
    ]);
  });

  it("runs the same outer from a workspace subfolder (not the nearest package.json)", () => {
    const top = repo();
    const run = runEntry(join(top, "packages/app"));
    expect(run.status).toBe(0);
    expect(run.decision).toMatchObject({ label: "main", cwd: top });
  });

  it("runs a Claude worktree's own outer, also from its subfolder", () => {
    const top = repo();
    const wt = join(top, ".claude/worktrees/wt1");
    git(top, "worktree", "add", "-q", "--detach", wt);
    // The worktree's own runtime (node_modules is not committed).
    seedDirective(wt, "claude-worktree");
    for (const cwd of [wt, join(wt, "packages/app")]) {
      const run = runEntry(cwd);
      expect(run.status).toBe(0);
      expect(run.decision).toMatchObject({ label: "claude-worktree", cwd: wt });
    }
  });

  it("runs a linked worktree outside the repo with that worktree's outer", () => {
    const top = repo();
    const wt = join(tempDir("deft-locator-linked-"), "wt");
    git(top, "worktree", "add", "-q", "--detach", wt);
    seedDirective(wt, "linked");
    const run = runEntry(join(wt, "packages/app"));
    expect(run.status).toBe(0);
    expect(run.decision).toMatchObject({ label: "linked", cwd: wt });
  });

  it("exits 1 with no decision outside any Git checkout (O-08)", () => {
    const run = runEntry(tempDir("deft-locator-none-"));
    expect(run.status).toBe(1);
    expect(run.decision).toBeNull();
  });

  it("blocks with the install message when the checkout has no outer", () => {
    const top = tempDir("deft-locator-empty-");
    git(top, "init", "-q");
    mkdirSync(join(top, "sub"));
    const run = runEntry(join(top, "sub"));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(HOST_HOOK_LOCATOR_NO_OUTER_MESSAGE);
    expect(run.decision).toBeNull();
  });

  it("blocks inside a Git submodule instead of using the parent's outer", () => {
    const top = repo();
    const sub = join(top, "vendor/lib");
    mkdirSync(sub, { recursive: true });
    // A submodule checkout top holds a `.git` file pointing into the parent.
    writeFileSync(join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
    mkdirSync(join(sub, "src"));
    const run = runEntry(join(sub, "src"));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(HOST_HOOK_LOCATOR_NO_OUTER_MESSAGE);
  });
});

describe("payload project root is the Git checkout top (AC9.4 v261119)", () => {
  it("walks a subfolder cwd up to the checkout top, past a workspace package.json", () => {
    const top = repo();
    const payload = { cwd: join(top, "packages/app") };
    expect(projectRootFromHookPayload(payload, "/")).toBe(top);
  });

  it("stops at a linked worktree's own top", () => {
    const top = repo();
    const wt = join(top, ".claude/worktrees/wt2");
    git(top, "worktree", "add", "-q", "--detach", wt);
    expect(projectRootFromHookPayload({ cwd: join(wt, "packages/app") }, "/")).toBe(wt);
  });

  it("keeps the folder when no checkout contains it", () => {
    const dir = tempDir("deft-locator-plain-");
    expect(gitCheckoutTop(dir)).toBe(dir);
    expect(projectRootFromHookPayload({ cwd: dir }, "/")).toBe(dir);
  });
});

describe("Claude locator entries count as Directive wiring", () => {
  it("finds wiring evidence from a locator-only Claude config", () => {
    const top = repo();
    writeAgentHookDeposit(top);
    const only = tempDir("deft-locator-evidence-");
    mkdirSync(join(only, ".claude"), { recursive: true });
    writeFileSync(
      join(only, ".claude/settings.json"),
      readFileSync(join(top, ".claude/settings.json"), "utf8"),
    );
    expect(hasDirectiveWiringEvidence(only)).toBe(true);
  });
});

describe("automatic setup rewrites old Claude entries (AC9.2)", () => {
  it("replaces a relative node .claude/… entry with one locator entry", () => {
    const top = repo();
    const settings = join(top, ".claude/settings.json");
    const old = `node ${OUTER_REL} --host claude --event tool.before`;
    writeFileSync(
      settings,
      `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: old, timeout: 30 }] }] } }, null, 2)}\n`,
    );
    writeAgentHookDeposit(top);
    const lines = hostHookConfigEntryLines(readFileSync(settings, "utf8")).split("\n");
    expect(lines).not.toContain(old);
    expect(lines).toContain(`node -e <locator> -- ${OUTER_REL} --host claude --event tool.before`);
  });
});
