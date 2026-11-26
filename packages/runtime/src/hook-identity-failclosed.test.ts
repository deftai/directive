/**
 * Wave 2k RED — SEC-WT / HOOK-ID owner-boundary (AC9.4, AC9.5, AC9.7,
 * AC14.8, AC14.26, AC14.65). Foreign payload root and pin≠installed must
 * fail closed before policy; matching roots + in-sync still reach decideHook.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE,
  INSTALLATION_RECOVERY_GUIDANCE,
} from "@deftai/directive-core/dist/install-health/constants.js";
import type { CheapInSyncResult } from "@deftai/directive-core/dist/install-health/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { PIN_MISMATCH_PROJECT_PM_RECOVERY_GUIDANCE } from "../../core/src/install-health/constants.js";
import {
  PIN_MISMATCH_RETRY_LINE,
  PIN_MISMATCH_ROOT_LABEL,
} from "../../core/src/install-health/pin-mismatch-guidance.js";
import { resolveLaunchingCheckoutRootFromPath, run } from "./hook-dispatch.js";

const OVERLAY_RECOVERY =
  "Overlay present at .deft-scratch/materialize-runtime-overlay.json. Outside the blocked hook, run `pnpm install --frozen-lockfile` (or equivalent exact restore) to restore the published pin, then retire that overlay before identity may pass.";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const t = temps.pop();
    if (t) rmSync(t, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  temps.push(root);
  return root;
}

function cheapOk(): CheapInSyncResult {
  return {
    ok: true,
    pinVersion: "1.2.3",
    installedVersion: "1.2.3",
    identityMatch: true,
    readinessValid: true,
    failClosed: false,
    allowSetup: true,
    recoveryGuidance: null,
  };
}

function cheapFailClosed(): CheapInSyncResult {
  return {
    ok: false,
    pinVersion: "9.9.9",
    installedVersion: "1.2.3",
    identityMatch: false,
    readinessValid: false,
    failClosed: true,
    allowSetup: false,
    recoveryGuidance: PIN_MISMATCH_PROJECT_PM_RECOVERY_GUIDANCE,
  };
}

function cheapOverlaySpoof(): CheapInSyncResult {
  return {
    ok: false,
    pinVersion: "0.129.0",
    installedVersion: "0.129.0",
    identityMatch: true,
    readinessValid: true,
    failClosed: true,
    allowSetup: false,
    recoveryGuidance: OVERLAY_RECOVERY,
  };
}

function dispatchWrite(opts: {
  projectRoot: string;
  target: string;
  launchingCheckoutRoot?: string | null;
  cheapInSync?: (root: string) => CheapInSyncResult;
  host?: "cursor" | "grok";
}): { code: number; body: Record<string, unknown>; raw: string } {
  const out: string[] = [];
  const host = opts.host ?? "cursor";
  const exit = run(
    [`--host=${host}`, "--event=tool.before", `--project-root=${opts.projectRoot}`],
    {
      readStdin: () =>
        JSON.stringify({
          tool_name: "Write",
          tool_input: { file_path: opts.target, contents: "x" },
          workspace_roots: [opts.projectRoot],
        }),
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => opts.projectRoot,
      stdinEmptyRetryMs: 0,
      ...(opts.launchingCheckoutRoot !== undefined
        ? { launchingCheckoutRoot: () => opts.launchingCheckoutRoot ?? null }
        : {}),
      ...(opts.cheapInSync !== undefined ? { cheapInSync: opts.cheapInSync } : {}),
    },
  );
  const raw = out.join("").trim();
  const body = raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
  return { code: exit, body, raw };
}

function denyMessage(body: Record<string, unknown>): string {
  return String(body.user_message ?? body.agent_message ?? body.reason ?? "");
}

describe("resolveLaunchingCheckoutRootFromPath", () => {
  it("returns the consumer root above node_modules/@deftai/directive-runtime", () => {
    expect(
      resolveLaunchingCheckoutRootFromPath(
        "/proj/node_modules/@deftai/directive-runtime/dist/hook-dispatch.js",
      ),
    ).toBe("/proj");
  });

  it("collapses pnpm nested node_modules to the consumer root", () => {
    expect(
      resolveLaunchingCheckoutRootFromPath(
        "/proj/node_modules/.pnpm/@deftai+directive-runtime@1.2.3/node_modules/@deftai/directive-runtime/dist/hook-bin.js",
      ),
    ).toBe("/proj");
  });

  it("returns null for monorepo source paths (no node_modules install)", () => {
    expect(
      resolveLaunchingCheckoutRootFromPath(
        "/Users/dev/directive/packages/runtime/src/hook-dispatch.ts",
      ),
    ).toBeNull();
  });
});

describe("SEC-WT foreign worktree payload fail-closed (AC9.5 / AC14.26)", () => {
  it("denies with AC9.7 and skips policy when payload root ≠ launching checkout", () => {
    const base = tempDir("sec-wt");
    const main = join(base, "main");
    const foreign = join(base, "foreign");
    mkdirSync(main);
    mkdirSync(foreign);
    writeFileSync(join(foreign, "note.txt"), "keep\n");

    const result = dispatchWrite({
      projectRoot: foreign,
      target: join(foreign, "note.txt"),
      launchingCheckoutRoot: main,
      cheapInSync: () => cheapOk(),
    });

    expect(result.code).toBe(0);
    expect(result.body.permission ?? result.body.decision).toBe("deny");
    const msg = denyMessage(result.body);
    expect(msg).toContain(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE);
    expect(msg).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(msg.toLowerCase()).not.toContain("ritual");
    expect(String(result.body.code ?? "")).not.toBe("ritual-not-ready");
    // No policy side-effects into the foreign tree.
    expect(existsSync(join(foreign, ".deft-cache"))).toBe(false);
  });

  it("still reaches decideHook when launching checkout matches payload root", () => {
    const root = tempDir("sec-wt-match");
    writeFileSync(join(root, "a.txt"), "x\n");

    const result = dispatchWrite({
      projectRoot: root,
      target: join(root, "a.txt"),
      launchingCheckoutRoot: root,
      cheapInSync: () => cheapOk(),
    });

    expect(result.code).toBe(0);
    const msg = denyMessage(result.body);
    // In-sync matching roots may still deny for ritual/occupancy — that is policy.
    expect(msg).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(String(result.body.code ?? "")).not.toBe("installation-identity-deny");
  });
});

describe("HOOK-ID pin≠installed fail-closed (AC14.8 / AC14.65)", () => {
  it("denies with project PM guidance and skips policy when cheap identity failClosed", () => {
    const root = tempDir("hook-id");
    writeFileSync(join(root, "a.txt"), "x\n");

    const result = dispatchWrite({
      projectRoot: root,
      target: join(root, "a.txt"),
      launchingCheckoutRoot: root,
      cheapInSync: () => cheapFailClosed(),
    });

    expect(result.code).toBe(0);
    expect(result.body.permission ?? result.body.decision).toBe("deny");
    const msg = denyMessage(result.body);
    expect(msg).toContain(PIN_MISMATCH_PROJECT_PM_RECOVERY_GUIDANCE);
    expect(msg).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(msg.toLowerCase()).not.toContain("ritual");
    expect(String(result.body.code ?? "")).not.toBe("ritual-not-ready");
    expect(existsSync(join(root, ".deft-cache"))).toBe(false);
  });

  it("real pin≠installed fixture: no ritual policy, project PM guidance on the wire", () => {
    const root = tempDir("hook-id-real");
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "hook-id-real",
          private: true,
          devDependencies: { "@deftai/directive-runtime": "9.9.9-mismatch" },
        },
        null,
        2,
      )}\n`,
    );
    const runtimePkg = join(root, "node_modules", "@deftai", "directive-runtime");
    mkdirSync(runtimePkg, { recursive: true });
    writeFileSync(
      join(runtimePkg, "package.json"),
      `${JSON.stringify({ name: "@deftai/directive-runtime", version: "1.2.3" }, null, 2)}\n`,
    );
    writeFileSync(join(root, "a.txt"), "x\n");

    const result = dispatchWrite({
      projectRoot: root,
      target: join(root, "a.txt"),
      launchingCheckoutRoot: root,
      // Real checkCheapInSync — no cheapInSync seam.
    });

    expect(result.code).toBe(0);
    expect(result.body.permission ?? result.body.decision).toBe("deny");
    const msg = denyMessage(result.body);
    // #6375: a real pin-only mismatch shows the root-specific recovery text.
    expect(msg).toContain(`${PIN_MISMATCH_ROOT_LABEL} ${resolve(root)}`);
    expect(msg).toContain(PIN_MISMATCH_RETRY_LINE);
    expect(msg).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(msg.toLowerCase()).not.toContain("ritual");
    expect(String(result.body.code ?? "")).not.toBe("ritual-not-ready");
  });

  it("overlay-present version-spoof denies with overlay + frozen-lockfile recovery (#5910)", () => {
    const root = tempDir("hook-id-overlay");
    writeFileSync(join(root, "a.txt"), "x\n");

    const result = dispatchWrite({
      projectRoot: root,
      target: join(root, "a.txt"),
      launchingCheckoutRoot: root,
      cheapInSync: () => cheapOverlaySpoof(),
    });

    expect(result.code).toBe(0);
    expect(result.body.permission ?? result.body.decision).toBe("deny");
    const msg = denyMessage(result.body);
    expect(msg).toContain("overlay");
    expect(msg).toContain("pnpm install --frozen-lockfile");
    expect(msg).toMatch(/retire/i);
    expect(msg).toContain("materialize-runtime-overlay.json");
    expect(msg.toLowerCase()).not.toContain("ritual");
  });
});

describe("SEC-WT real linked worktree payload (AC9.5)", () => {
  it("main launching checkout + same-repo worktree payload admits past root mismatch then ritual-denies (#7351)", () => {
    const base = tempDir("sec-wt-git");
    const primary = join(base, "primary");
    mkdirSync(primary);
    execFileSync("git", ["init", "-q"], { cwd: primary });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: primary });
    execFileSync("git", ["config", "user.name", "t"], { cwd: primary });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "base"], { cwd: primary });
    const wt = join(base, "wt-a");
    execFileSync("git", ["worktree", "add", "--detach", "-q", wt], { cwd: primary });

    const result = dispatchWrite({
      projectRoot: wt,
      target: join(wt, "src", "app.ts"),
      launchingCheckoutRoot: primary,
      cheapInSync: () => cheapOk(),
      host: "grok",
    });

    expect(result.code).toBe(0);
    expect(result.body.decision).toBe("deny");
    const msg = String(result.body.reason ?? "");
    // #7351: same-repo linked worktree passes root-mismatch; fail-closed shifts to ritual
    expect(msg).not.toContain(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE);
    expect(msg).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(msg.toLowerCase()).toContain("ritual");
    expect(existsSync(join(wt, ".deft-cache"))).toBe(true);
  });
});

describe("packaged-consumer deposited outer (#6100 P4)", () => {
  it("materialized .pnpm layout resolves launchRoot to consumer root; primary session still mismatches dest", () => {
    const base = tempDir("pkg-consumer-6100");
    const primary = join(base, "primary");
    const dest = join(base, "dest");
    mkdirSync(primary, { recursive: true });
    mkdirSync(dest, { recursive: true });
    // Materialized pnpm store layout under dest
    const storePkg = join(
      dest,
      "node_modules",
      ".pnpm",
      "@deftai+directive-runtime@1.2.3",
      "node_modules",
      "@deftai",
      "directive-runtime",
      "dist",
    );
    mkdirSync(storePkg, { recursive: true });
    writeFileSync(join(storePkg, "hook-bin.js"), "export {};\n");
    const linked = join(dest, "node_modules", "@deftai", "directive-runtime", "dist");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, "hook-bin.js"), "export {};\n");

    const resolved = resolveLaunchingCheckoutRootFromPath(
      join(
        dest,
        "node_modules",
        ".pnpm",
        "@deftai+directive-runtime@1.2.3",
        "node_modules",
        "@deftai",
        "directive-runtime",
        "dist",
        "hook-bin.js",
      ),
    );
    expect(resolved?.replace(/\\/g, "/")).toBe(dest.replace(/\\/g, "/"));

    // Primary-session negative after dest install alone: launchRoot=primary vs payload=dest
    const result = dispatchWrite({
      projectRoot: dest,
      target: join(dest, "note.txt"),
      launchingCheckoutRoot: primary,
      cheapInSync: () => cheapOk(),
    });
    expect(result.code).toBe(0);
    expect(result.body.permission ?? result.body.decision).toBe("deny");
    const msg = denyMessage(result.body);
    expect(msg).toContain(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE);
    expect(msg).toMatch(/prep|swarm-worktrees prep|open that worktree/i);
  });
});

describe("pin-mismatch recovery admit (#6313)", () => {
  const PIN_LINE = "Directive can't run: the installed @deftai/directive-runtime";

  function cheapPinMismatchOnly(): CheapInSyncResult {
    return { ...cheapFailClosed(), pinMismatchOnly: true };
  }

  function writePinFixture(root: string, pin: string, installed: string): void {
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        { name: "pin-6313", private: true, devDependencies: { "@deftai/directive-runtime": pin } },
        null,
        2,
      )}\n`,
    );
    const runtimePkg = join(root, "node_modules", "@deftai", "directive-runtime");
    mkdirSync(runtimePkg, { recursive: true });
    writeFileSync(
      join(runtimePkg, "package.json"),
      `${JSON.stringify({ name: "@deftai/directive-runtime", version: installed }, null, 2)}\n`,
    );
  }

  function dispatchTool(opts: {
    projectRoot: string;
    toolName?: string;
    toolInput: Record<string, unknown>;
    cwd?: string;
    host?: "claude" | "cursor" | "codex";
    event?: "tool.before" | "session.start";
    launchingCheckoutRoot?: string;
    cheapInSync?: (root: string) => CheapInSyncResult;
  }): { body: Record<string, unknown>; raw: string } {
    const out: string[] = [];
    const host = opts.host ?? "claude";
    run([`--host=${host}`, `--event=${opts.event ?? "tool.before"}`], {
      readStdin: () =>
        JSON.stringify({
          tool_name: opts.toolName ?? "Bash",
          tool_input: opts.toolInput,
          workspace_roots: [opts.projectRoot],
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        }),
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => opts.projectRoot,
      stdinEmptyRetryMs: 0,
      launchingCheckoutRoot: () => opts.launchingCheckoutRoot ?? opts.projectRoot,
      ...(opts.cheapInSync !== undefined ? { cheapInSync: opts.cheapInSync } : {}),
    });
    const raw = out.join("").trim();
    const body = raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
    return { body, raw };
  }

  function isDeny(body: Record<string, unknown>): boolean {
    const hso = body.hookSpecificOutput as Record<string, unknown> | undefined;
    return (
      hso?.permissionDecision === "deny" || body.permission === "deny" || body.decision === "deny"
    );
  }

  function wireMessage(body: Record<string, unknown>): string {
    const hso = body.hookSpecificOutput as Record<string, unknown> | undefined;
    return String(hso?.permissionDecisionReason ?? denyMessage(body));
  }

  function expectPinRefusal(body: Record<string, unknown>): void {
    expect(isDeny(body)).toBe(true);
    const msg = wireMessage(body);
    expect(msg).toContain(PIN_LINE);
    // #6375: pin mismatch as the only fault shows the root-specific text.
    expect(msg).toContain(`\n${PIN_MISMATCH_ROOT_LABEL} `);
    expect(msg).toContain(PIN_MISMATCH_RETRY_LINE);
  }

  it("admits pnpm install --frozen-lockfile at the root, then the next command once installed", () => {
    const root = tempDir("pin-6313-real");
    writePinFixture(root, "0.129.9", "0.129.8");

    // Real checkCheapInSync: pin newer than installed, no overlay.
    const admitted = dispatchTool({
      projectRoot: root,
      toolInput: { command: "pnpm install --frozen-lockfile" },
      cwd: root,
    });
    expect(isDeny(admitted.body)).toBe(false);
    expect(admitted.raw).not.toContain(PIN_LINE);

    // An unrelated command before the install still hits the same refusal.
    expectPinRefusal(
      dispatchTool({ projectRoot: root, toolInput: { command: "git status" }, cwd: root }).body,
    );

    // The install finishes: installed now matches the pin.
    writePinFixture(root, "0.129.9", "0.129.9");
    const next = dispatchTool({
      projectRoot: root,
      toolInput: { command: "git status" },
      cwd: root,
    });
    expect(next.raw).not.toContain(PIN_LINE);
    expect(next.raw).not.toContain("installation-identity-deny");
  });

  it.each(["npm install", "npm ci"])("admits the named recovery %j", (command) => {
    const root = tempDir("pin-6313-named");
    const result = dispatchTool({
      projectRoot: root,
      toolInput: { command },
      cwd: root,
      cheapInSync: () => cheapPinMismatchOnly(),
    });
    expect(isDeny(result.body)).toBe(false);
  });

  it("renders a cursor allow with an existing allow code", () => {
    const root = tempDir("pin-6313-cursor");
    const result = dispatchTool({
      projectRoot: root,
      toolName: "Shell",
      toolInput: { command: "pnpm install --frozen-lockfile" },
      cwd: root,
      host: "cursor",
      cheapInSync: () => cheapPinMismatchOnly(),
    });
    expect(result.body.permission).toBe("allow");
    expect(result.body.code).toBe("shell-op-ready");
  });

  it.each([
    ["an unrelated command", "git status"],
    ["install chained with another command", "pnpm install --frozen-lockfile && git status"],
    ["install after a directory change", "cd sub && pnpm install --frozen-lockfile"],
    ["install with a directory flag", "pnpm --dir sub install --frozen-lockfile"],
    ["the global install", "npm i -g @deftai/directive"],
    ["the repair", "directive install --repair"],
  ])("refuses %s with the same recovery text", (_label, command) => {
    const root = tempDir("pin-6313-refuse");
    const result = dispatchTool({
      projectRoot: root,
      toolInput: { command },
      cwd: root,
      cheapInSync: () => cheapPinMismatchOnly(),
    });
    expectPinRefusal(result.body);
  });

  it("refuses the install when the shell runs in a different directory", () => {
    const root = tempDir("pin-6313-cwd");
    const sub = join(root, "sub");
    mkdirSync(sub);
    expectPinRefusal(
      dispatchTool({
        projectRoot: root,
        toolInput: { command: "pnpm install --frozen-lockfile" },
        cwd: sub,
        cheapInSync: () => cheapPinMismatchOnly(),
      }).body,
    );
  });

  it("refuses the install when the tool input names a different workdir (codex)", () => {
    const root = tempDir("pin-6313-workdir");
    const sub = join(root, "sub");
    mkdirSync(sub);
    expectPinRefusal(
      dispatchTool({
        projectRoot: root,
        host: "codex",
        toolInput: { command: "pnpm install --frozen-lockfile", workdir: sub },
        cwd: root,
        cheapInSync: () => cheapPinMismatchOnly(),
      }).body,
    );
  });

  it("refuses the install when no run directory is sent", () => {
    const root = tempDir("pin-6313-nodir");
    expectPinRefusal(
      dispatchTool({
        projectRoot: root,
        toolInput: { command: "pnpm install --frozen-lockfile" },
        cheapInSync: () => cheapPinMismatchOnly(),
      }).body,
    );
  });

  it("refuses the install on codex when only the session cwd is sent (#4998)", () => {
    const root = tempDir("pin-6313-codex-outer");
    expectPinRefusal(
      dispatchTool({
        projectRoot: root,
        host: "codex",
        toolInput: { command: "pnpm install --frozen-lockfile" },
        cwd: root,
        cheapInSync: () => cheapPinMismatchOnly(),
      }).body,
    );
  });

  it("admits the install on codex when the tool input workdir is the project root", () => {
    const root = tempDir("pin-6313-codex-nested");
    const result = dispatchTool({
      projectRoot: root,
      host: "codex",
      toolInput: { command: "pnpm install --frozen-lockfile", workdir: root },
      cwd: root,
      cheapInSync: () => cheapPinMismatchOnly(),
    });
    expect(isDeny(result.body)).toBe(false);
  });

  it.each([
    ["an empty tool input workdir", { workdir: "" }],
    ["tool input directories that disagree", { workdir: "ROOT", cwd: "SUB" }],
  ])("refuses the install with %s, even when the outer cwd is the root", (_label, dirs) => {
    const root = tempDir("pin-6313-nested-bad");
    const sub = join(root, "sub");
    mkdirSync(sub);
    const toolDirs = Object.fromEntries(
      Object.entries(dirs).map(([key, value]) => [
        key,
        value === "ROOT" ? root : value === "SUB" ? sub : value,
      ]),
    );
    expectPinRefusal(
      dispatchTool({
        projectRoot: root,
        toolInput: { command: "pnpm install --frozen-lockfile", ...toolDirs },
        cwd: root,
        cheapInSync: () => cheapPinMismatchOnly(),
      }).body,
    );
  });

  it("refuses the recovery command through a non-shell tool", () => {
    const root = tempDir("pin-6313-write");
    expectPinRefusal(
      dispatchTool({
        projectRoot: root,
        toolName: "Write",
        toolInput: { file_path: join(root, "a.txt"), command: "npm install" },
        cwd: root,
        cheapInSync: () => cheapPinMismatchOnly(),
      }).body,
    );
  });

  it("does not admit outside tool.before", () => {
    const root = tempDir("pin-6313-event");
    const result = dispatchTool({
      projectRoot: root,
      event: "session.start",
      toolInput: { command: "pnpm install --frozen-lockfile" },
      cwd: root,
      cheapInSync: () => cheapPinMismatchOnly(),
    });
    expect(result.raw).toContain(PIN_LINE);
  });

  it("does not admit when pinMismatchOnly is absent (fail closed)", () => {
    const root = tempDir("pin-6313-absent");
    const body = dispatchTool({
      projectRoot: root,
      toolInput: { command: "pnpm install --frozen-lockfile" },
      cwd: root,
      cheapInSync: () => cheapFailClosed(),
    }).body;
    expect(isDeny(body)).toBe(true);
    const msg = wireMessage(body);
    expect(msg).toContain(PIN_LINE);
    // Not marked pin-only: the cheap check's own guidance, not the #6375 text.
    expect(msg).toContain(PIN_MISMATCH_PROJECT_PM_RECOVERY_GUIDANCE);
    expect(msg).not.toContain(PIN_MISMATCH_ROOT_LABEL);
  });

  it("overlay-present fault: install is not admitted; #5910 recovery stays", () => {
    const root = tempDir("pin-6313-overlay");
    writePinFixture(root, "0.129.9", "0.129.8");
    mkdirSync(join(root, ".deft-scratch"), { recursive: true });
    writeFileSync(join(root, ".deft-scratch", "materialize-runtime-overlay.json"), "{}\n");
    const result = dispatchTool({
      projectRoot: root,
      toolInput: { command: "pnpm install --frozen-lockfile" },
      cwd: root,
    });
    expect(isDeny(result.body)).toBe(true);
    expect(wireMessage(result.body)).toContain(OVERLAY_RECOVERY);
  });

  it("overlay version-spoof fault: install is not admitted", () => {
    const root = tempDir("pin-6313-spoof");
    const result = dispatchTool({
      projectRoot: root,
      toolInput: { command: "pnpm install --frozen-lockfile" },
      cwd: root,
      cheapInSync: () => cheapOverlaySpoof(),
    });
    expect(isDeny(result.body)).toBe(true);
    expect(wireMessage(result.body)).toContain(OVERLAY_RECOVERY);
  });

  it("identity (root) mismatch fault: install is not admitted", () => {
    const base = tempDir("pin-6313-root");
    const main = join(base, "main");
    const foreign = join(base, "foreign");
    mkdirSync(main);
    mkdirSync(foreign);
    const result = dispatchTool({
      projectRoot: foreign,
      toolInput: { command: "pnpm install --frozen-lockfile" },
      cwd: foreign,
      launchingCheckoutRoot: main,
      cheapInSync: () => cheapPinMismatchOnly(),
    });
    expect(isDeny(result.body)).toBe(true);
    expect(wireMessage(result.body)).toContain(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE);
  });
});
