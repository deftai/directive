import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2182: fixture repo with a private-scope registry configuration. Read-only
 * / session / ritual flows MUST perform NO npm/pnpm registry access, even
 * when the target repo has a private scope pointed at an internal registry
 * (the exact shape the issue is concerned about: package scopes and registry
 * traffic can be sensitive in an arbitrary consumer repo).
 *
 * The package-manager seam is stubbed at the lowest level (`node:child_process`
 * spawnSync, which is what `payload-staleness.ts`'s `npm view` call and
 * `verify-tools.ts`'s tool probing both bottom out on) so the assertion holds
 * regardless of which higher-level function is exercised.
 */

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from "node:child_process";
import { defaultRitualRunner } from "./ritual-entrypoint.js";
import { runSessionStart } from "./session-start.js";
import { GATED_ENTRYPOINT_COMMANDS } from "./verify-session-ritual.js";

function packageManagerCalls(mock: ReturnType<typeof vi.mocked<typeof spawnSync>>): unknown[][] {
  return mock.mock.calls.filter((call) => {
    const command = String(call[0] ?? "");
    return command === "npm" || command === "pnpm";
  });
}

function initPrivateScopeRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-pkgnet-"));
  // Private-scope registry fixture (#2182 acceptance criteria): a private
  // npm scope routed at an internal, authenticated registry. Its mere
  // presence on disk must not be enough to make any read-only flow contact
  // it (or the public npm registry) as a side effect.
  writeFileSync(
    join(root, ".npmrc"),
    "@my-private-scope:registry=https://npm.internal.example.com/\n" +
      "//npm.internal.example.com/:_authToken=should-never-be-read\n",
    "utf8",
  );
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "core", "VERSION"),
    `sha: ${"f".repeat(40)}\nref: v0.1.0\ntag: v0.1.0\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
    "utf8",
  );
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], policy: {} },
    }),
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@t.local",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@t.local",
    },
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, head };
}

describe("package-manager network scope (#2182)", () => {
  const temps: string[] = [];
  const spawnSyncMock = vi.mocked(spawnSync);

  beforeEach(() => {
    spawnSyncMock.mockClear();
  });

  afterEach(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
    temps.length = 0;
  });

  it("session:start (quick tier) invokes no npm/pnpm even with a private-scope registry present", () => {
    const { root } = initPrivateScopeRepo();
    temps.push(root);

    const result = runSessionStart(root, { writeHistory: false });

    expect(result.code === 0 || result.code === 1).toBe(true);
    expect(packageManagerCalls(spawnSyncMock)).toEqual([]);
  });

  it("the gated session-ritual doctor step never requests --network", () => {
    // Regression lock: the gated tier issues a bare `doctor` command with no
    // extra args, so a bare `deft doctor` call stays on the offline tier
    // by default -- this is the load-bearing wiring that keeps the gated
    // session-ritual step network-free without the doctor implementation
    // needing to know it is being invoked from the ritual.
    expect(GATED_ENTRYPOINT_COMMANDS.doctor).toEqual(["doctor"]);
  });

  it("defaultRitualRunner's doctor step invokes no npm/pnpm on a private-scope-registry repo", () => {
    const { root } = initPrivateScopeRepo();
    temps.push(root);

    const result = defaultRitualRunner(GATED_ENTRYPOINT_COMMANDS.doctor.slice(), root);

    expect(typeof result.code).toBe("number");
    expect(packageManagerCalls(spawnSyncMock)).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).toMatch(/--network/);
  });
});
