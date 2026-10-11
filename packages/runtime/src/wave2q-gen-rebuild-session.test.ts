/**
 * Wave 2q RED — GEN-REBUILD + AC8.7-TEST + AC8.9-SS
 * (AC14.20, AC8.7/AC14.52, AC8.9).
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_PIN_PACKAGE } from "@deftai/directive-core/dist/install-health/constants.js";
import { GENERATION_REL } from "@deftai/directive-core/dist/install-health/ownership.js";
import { CURRENT_DATA_SCHEMA_VERSION, DATA_SCHEMA_MARKER_REL } from "./migrate.js";
import { run as runHookDispatch } from "./hook-dispatch.js";
import { maybeSelfCompleteSetup } from "./self-complete.js";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];
const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = join(HERE, "..", "..", "..", "node_modules", ".bin", "tsx");
const SELF_COMPLETE_TS = join(HERE, "self-complete.ts");

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wave2q-"));
  TEMPS.push(root);
  return root;
}

function pinRuntime(root: string, version: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "t",
        version: "0.0.0",
        private: true,
        devDependencies: { [RUNTIME_PIN_PACKAGE]: version },
      },
      null,
      2,
    )}\n`,
  );
  const runtimePkg = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(runtimePkg, { recursive: true });
  writeFileSync(
    join(runtimePkg, "package.json"),
    `${JSON.stringify({ name: RUNTIME_PIN_PACKAGE, version }, null, 2)}\n`,
  );
}

function writeDataSchema(root: string, schemaVersion: number): void {
  mkdirSync(join(root, ".deft", "directive"), { recursive: true });
  writeFileSync(
    join(root, DATA_SCHEMA_MARKER_REL),
    `${JSON.stringify({ schemaVersion }, null, 2)}\n`,
  );
}

function readinessPath(root: string, version: string): string {
  return join(root, ".deft", "directive", `wiring-ready.${version}.json`);
}

/** Spawn a child that runs maybeSelfCompleteSetup(fromHook) against root. */
function spawnSelfComplete(root: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const script = `
      import { maybeSelfCompleteSetup } from ${JSON.stringify(SELF_COMPLETE_TS)};
      const r = maybeSelfCompleteSetup(${JSON.stringify(root)}, { fromHook: true });
      if (!r.ran && r.skipReason !== "fast-path") {
        console.error(JSON.stringify(r));
        process.exit(2);
      }
      process.exit(0);
    `;
    const child = spawn(TSX, ["--eval", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("AC14.20 GENERATION deleted rebuilds (GEN-REBUILD)", () => {
  it("rebuilds GENERATION + readiness when pin+wiring present but GENERATION deleted", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    expect(existsSync(join(root, GENERATION_REL))).toBe(true);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);

    rmSync(join(root, GENERATION_REL), { force: true });
    rmSync(readinessPath(root, installed.runtimeVersion), { force: true });
    expect(existsSync(join(root, GENERATION_REL))).toBe(false);

    const result = maybeSelfCompleteSetup(root, { fromHook: true });
    expect(result.ran).toBe(true);
    expect(result.skipReason).toBeNull();
    expect(result.setup?.conflicts ?? []).toEqual([]);
    expect(existsSync(join(root, GENERATION_REL))).toBe(true);
    expect(existsSync(readinessPath(root, installed.runtimeVersion))).toBe(true);
    const gen = JSON.parse(readFileSync(join(root, GENERATION_REL), "utf8")) as {
      runtimeVersion?: string;
    };
    expect(gen.runtimeVersion).toBe(installed.runtimeVersion);
  });

  it("still skips never-configured pin-only projects (AC14.50)", () => {
    const root = tempRoot();
    pinRuntime(root, "1.2.3");
    const result = maybeSelfCompleteSetup(root, { argv: ["verify:branch"] });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("not-configured");
    expect(existsSync(join(root, GENERATION_REL))).toBe(false);
  });
});

describe("AC8.7 two-hook same-pin convergence", () => {
  it("two concurrent self-completes leave one valid readiness + intact JSON", async () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    rmSync(readinessPath(root, installed.runtimeVersion), { force: true });

    const [a, b] = await Promise.all([spawnSelfComplete(root), spawnSelfComplete(root)]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);

    const ready = readinessPath(root, installed.runtimeVersion);
    expect(existsSync(ready)).toBe(true);
    const readyBody = JSON.parse(readFileSync(ready, "utf8")) as { runtimeVersion?: string };
    expect(readyBody.runtimeVersion).toBe(installed.runtimeVersion);

    const gen = JSON.parse(readFileSync(join(root, GENERATION_REL), "utf8")) as {
      runtimeVersion?: string;
    };
    expect(gen.runtimeVersion).toBe(installed.runtimeVersion);

    // Shared host-hook JSON must remain parseable (no torn write).
    const cursorHooks = join(root, ".cursor", "hooks.json");
    if (existsSync(cursorHooks)) {
      expect(() => JSON.parse(readFileSync(cursorHooks, "utf8"))).not.toThrow();
    }
  });
});

describe("AC8.9 session-start data-behind message", () => {
  it("session.start reports data behind and names directive upgrade", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeDataSchema(root, 0); // behind CURRENT_DATA_SCHEMA_VERSION

    const out: string[] = [];
    const err: string[] = [];
    const code = runHookDispatch(["--host", "cursor", "--event", "session.start"], {
      readStdin: () =>
        JSON.stringify({ cwd: root, workspace_roots: [root] }),
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      cwd: () => root,
      launchingCheckoutRoot: () => root,
      stdinEmptyRetryMs: 0,
    });
    expect(code).toBe(0);
    const combined = `${out.join("")}\n${err.join("")}`;
    expect(combined).toMatch(/behind/i);
    expect(combined).toContain("directive upgrade");
    // Schema must not have been mutated by the hook.
    const marker = JSON.parse(readFileSync(join(root, DATA_SCHEMA_MARKER_REL), "utf8")) as {
      schemaVersion: number;
    };
    expect(marker.schemaVersion).toBe(0);
    expect(CURRENT_DATA_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it("other hooks stay silent about schema behind", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeDataSchema(root, 0);

    const out: string[] = [];
    const err: string[] = [];
    const code = runHookDispatch(["--host", "cursor", "--event", "tool.before"], {
      readStdin: () =>
        JSON.stringify({
          tool_name: "Read",
          cwd: root,
          workspace_roots: [root],
        }),
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      cwd: () => root,
      launchingCheckoutRoot: () => root,
      stdinEmptyRetryMs: 0,
    });
    expect(code).toBe(0);
    const combined = `${out.join("")}\n${err.join("")}`;
    expect(combined).not.toMatch(/directive upgrade/);
    expect(combined).not.toMatch(/schema behind/i);
  });
});
