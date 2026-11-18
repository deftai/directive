/**
 * Dispatcher tests for the pin-mismatch-only refusal on a host that reports no
 * run directory (#6375). These drive `run` with host payloads; they are not
 * live-host evidence. The recovery admit itself is unchanged (#6313).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PIN_MISMATCH_RETRY_LINE,
  PIN_MISMATCH_ROOT_LABEL,
  PIN_MISMATCH_TERMINAL_LINE,
} from "@deftai/directive-core/dist/install-health/pin-mismatch-guidance.js";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./hook-dispatch.js";

const PIN_LINE = "Directive can't run: the installed @deftai/directive-runtime";
const OVERLAY_LINE = "Directive hook refuse: materialize-runtime overlay is present";
const OVERLAY_RECOVERY =
  "Overlay present at .deft-scratch/materialize-runtime-overlay.json. Outside the blocked hook, run `pnpm install --frozen-lockfile` (or equivalent exact restore) to restore the published pin, then retire that overlay before identity may pass.";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const t = temps.pop();
    if (t) rmSync(t, { recursive: true, force: true });
  }
});

/** A project whose pin and installed runtime differ (or match), with an optional lockfile. */
function project(opts: {
  pin?: string;
  installed?: string;
  lockfile?: "pnpm" | "npm" | "none";
}): string {
  const root = mkdtempSync(join(tmpdir(), "pin-6375-"));
  temps.push(root);
  const pin = opts.pin ?? "0.129.9";
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "pin-6375", private: true, devDependencies: { "@deftai/directive-runtime": pin } }, null, 2)}\n`,
  );
  const runtimePkg = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(runtimePkg, { recursive: true });
  writeFileSync(
    join(runtimePkg, "package.json"),
    `${JSON.stringify({ name: "@deftai/directive-runtime", version: opts.installed ?? "0.129.8" }, null, 2)}\n`,
  );
  if ((opts.lockfile ?? "pnpm") === "pnpm") {
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  } else if (opts.lockfile === "npm") {
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  }
  return root;
}

function dispatch(opts: {
  root: string;
  host?: "codex" | "claude";
  command: string;
  toolDirs?: Record<string, string>;
  outerCwd?: string;
}): { deny: boolean; message: string } {
  const out: string[] = [];
  run([`--host=${opts.host ?? "codex"}`, "--event=tool.before"], {
    readStdin: () =>
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: opts.command, ...(opts.toolDirs ?? {}) },
        workspace_roots: [opts.root],
        ...(opts.outerCwd !== undefined ? { cwd: opts.outerCwd } : {}),
      }),
    writeOut: (text) => out.push(text),
    writeErr: () => undefined,
    cwd: () => opts.root,
    stdinEmptyRetryMs: 0,
    launchingCheckoutRoot: () => opts.root,
  });
  const raw = out.join("").trim();
  const body = raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
  const hso = body.hookSpecificOutput as Record<string, unknown> | undefined;
  const deny =
    hso?.permissionDecision === "deny" || body.permission === "deny" || body.decision === "deny";
  const message = String(
    hso?.permissionDecisionReason ??
      body.user_message ??
      body.agent_message ??
      body.reason ??
      body.systemMessage ??
      "",
  );
  return { deny, message };
}

/** Codex session: only the outer session directory, no tool-input run directory. */
function codexSessionOnly(root: string, command: string) {
  return dispatch({ root, command, outerCwd: root });
}

describe("dispatcher: Codex pin-mismatch-only refusal text (#6375)", () => {
  it("refuses a shell command sent with only the session directory", () => {
    const root = project({});
    const result = codexSessionOnly(root, "echo hi");
    expect(result.deny).toBe(true);
    expect(result.message).toContain(PIN_LINE);
  });

  it("shows the checked root on its own labelled line, the outside terminal, the command and the retry note", () => {
    const root = project({ lockfile: "pnpm" });
    const lines = codexSessionOnly(root, "echo hi").message.split("\n");
    expect(lines).toContain(`${PIN_MISMATCH_ROOT_LABEL} ${resolve(root)}`);
    expect(lines).toContain(PIN_MISMATCH_TERMINAL_LINE);
    expect(lines).toContain("Run: `pnpm install --frozen-lockfile`");
    expect(lines).toContain(PIN_MISMATCH_RETRY_LINE);
    expect(lines.join("\n")).not.toMatch(/(^|[^\w-])npm\s+(install|ci|i)\b/);
  });

  it("names `npm install` from a root npm lockfile and no command when there is none", () => {
    const npmRoot = project({ lockfile: "npm" });
    expect(codexSessionOnly(npmRoot, "echo hi").message.split("\n")).toContain(
      "Run: `npm install`",
    );
    const bareRoot = project({ lockfile: "none" });
    expect(codexSessionOnly(bareRoot, "echo hi").message).not.toContain("Run: ");
  });

  it.each([
    ["pnpm --dir", (root: string) => `pnpm --dir ${root} install --frozen-lockfile`],
    ["npm --prefix", (root: string) => `npm --prefix ${root} ci`],
    ["pnpm -C", (root: string) => `pnpm -C ${root} install --frozen-lockfile`],
    ["plain pnpm install", () => "pnpm install"],
  ])("refuses %s with only the session directory", (_label, command) => {
    const root = project({});
    const result = codexSessionOnly(root, command(root));
    expect(result.deny).toBe(true);
    expect(result.message).toContain(PIN_LINE);
  });

  it.each([
    ["pnpm --dir", (root: string) => `pnpm --dir ${root} install --frozen-lockfile`],
    ["npm --prefix", (root: string) => `npm --prefix ${root} ci`],
    ["plain pnpm install", () => "pnpm install"],
  ])("refuses %s even when the tool input proves the run directory is the root", (_label, command) => {
    const root = project({});
    const result = dispatch({ root, command: command(root), toolDirs: { workdir: root } });
    expect(result.deny).toBe(true);
  });

  it("allows `pnpm install --frozen-lockfile` when the tool input names the project root", () => {
    const root = project({});
    const result = dispatch({
      root,
      command: "pnpm install --frozen-lockfile",
      toolDirs: { workdir: root },
      outerCwd: root,
    });
    expect(result.deny).toBe(false);
    expect(result.message).not.toContain(PIN_LINE);
  });

  it("refuses `pnpm install --frozen-lockfile` when the tool input names two run directories that differ", () => {
    const root = project({});
    const sub = join(root, "sub");
    mkdirSync(sub);
    const result = dispatch({
      root,
      command: "pnpm install --frozen-lockfile",
      toolDirs: { workdir: root, cwd: sub },
      outerCwd: root,
    });
    expect(result.deny).toBe(true);
    expect(result.message).toContain(PIN_LINE);
  });

  it("refuses `pnpm install --frozen-lockfile` with no run directory at all", () => {
    const root = project({});
    const result = dispatch({ root, command: "pnpm install --frozen-lockfile" });
    expect(result.deny).toBe(true);
    expect(result.message).toContain(PIN_LINE);
  });

  it("keeps the overlay refusal and its guidance when versions match", () => {
    const root = project({ pin: "0.129.9", installed: "0.129.9" });
    mkdirSync(join(root, ".deft-scratch"), { recursive: true });
    writeFileSync(join(root, ".deft-scratch", "materialize-runtime-overlay.json"), "{}\n");
    const result = codexSessionOnly(root, "echo hi");
    expect(result.deny).toBe(true);
    expect(result.message).toContain(OVERLAY_LINE);
    expect(result.message).toContain(`Recovery: ${OVERLAY_RECOVERY}`);
    expect(result.message).not.toContain(PIN_MISMATCH_ROOT_LABEL);
  });
});

describe("dispatcher: host that reports the run directory (#6375)", () => {
  it.each([
    "pnpm install --frozen-lockfile",
    "npm install",
    "npm ci",
  ])("admits %j at the root as today", (command) => {
    const root = project({});
    const result = dispatch({ root, host: "claude", command, outerCwd: root });
    expect(result.deny).toBe(false);
  });

  it("refuses the install from another directory and shows the root-specific text", () => {
    const root = project({});
    const sub = join(root, "sub");
    mkdirSync(sub);
    const result = dispatch({
      root,
      host: "claude",
      command: "pnpm install --frozen-lockfile",
      outerCwd: sub,
    });
    expect(result.deny).toBe(true);
    expect(result.message.split("\n")).toContain(`${PIN_MISMATCH_ROOT_LABEL} ${resolve(root)}`);
  });
});
