/**
 * Wave 2k RED — SEC-WT / HOOK-ID owner-boundary (AC9.4, AC9.5, AC9.7,
 * AC14.8, AC14.26, AC14.65). Foreign payload root and pin≠installed must
 * fail closed before policy; matching roots + in-sync still reach decideHook.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INSTALLATION_RECOVERY_GUIDANCE } from "@deftai/directive-core/dist/install-health/constants.js";
import type { CheapInSyncResult } from "@deftai/directive-core/dist/install-health/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLaunchingCheckoutRootFromPath, run } from "./hook-dispatch.js";

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
    recoveryGuidance: INSTALLATION_RECOVERY_GUIDANCE,
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
    expect(msg).toContain(INSTALLATION_RECOVERY_GUIDANCE);
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
  it("denies with AC9.7 and skips policy when cheap identity failClosed", () => {
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
    expect(msg).toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(msg.toLowerCase()).not.toContain("ritual");
    expect(String(result.body.code ?? "")).not.toBe("ritual-not-ready");
    expect(existsSync(join(root, ".deft-cache"))).toBe(false);
  });

  it("real pin≠installed fixture: no ritual policy, AC9.7 on the wire", () => {
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
    expect(msg).toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(msg.toLowerCase()).not.toContain("ritual");
    expect(String(result.body.code ?? "")).not.toBe("ritual-not-ready");
  });
});

describe("SEC-WT real linked worktree payload (AC9.5)", () => {
  it("main launching checkout + worktree payload root fails closed", () => {
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
    expect(msg).toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(msg.toLowerCase()).not.toContain("ritual");
    expect(msg.toLowerCase()).toContain(resolve(primary).toLowerCase());
    expect(existsSync(join(wt, ".deft-cache"))).toBe(false);
  });
});
