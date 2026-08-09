import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ritualStatePath, runSessionStart } from "./session-start.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function seedConsumerProject(): string {
  const root = mkdtempSync(join(tmpdir(), "session-start-consumer-"));
  temps.push(root);
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "core", "VERSION"),
    "tag: 'v0.59.0'\nsha: abc\ninstall_root: '.deft/core'\n",
    "utf8",
  );
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Consumer", status: "running", items: [], policy: {} },
    }),
    "utf8",
  );
  writeFileSync(join(root, "README.md"), "consumer\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "c@c.local"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "consumer"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "consumer",
      GIT_AUTHOR_EMAIL: "c@c.local",
      GIT_COMMITTER_NAME: "consumer",
      GIT_COMMITTER_EMAIL: "c@c.local",
    },
  });
  return root;
}

describe("runSessionStart consumer project root (#2032)", () => {
  it("writes ritual-state.json under the consumer project root, not framework deposit", () => {
    const root = seedConsumerProject();
    const result = runSessionStart(root, {
      writeHistory: false,
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
      probeScm: () => ({
        ready: true,
        binary: "gh",
        binaryPath: "/usr/bin/gh",
        authState: "authenticated",
        githubAuthMode: "host-gh",
        runtimeMode: "local-unsandboxed",
        injectedTokenPresent: false,
        depth: "shallow",
        detail: "ok",
        remediation: null,
        skippedGates: [],
        login: null,
        failureKind: null,
      }),
    });
    expect(result.code).toBe(0);
    const statePath = ritualStatePath(root);
    expect(statePath).toBe(join(root, ".deft", "ritual-state.json"));
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      worktree_path: string;
    };
    expect(state.worktree_path).toBe(root);
  });

  it("emits a migrate nudge for unstamped canonical-vendored deposits (#2059)", () => {
    const root = seedConsumerProject();
    const result = runSessionStart(root, {
      writeHistory: false,
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
      probeScm: () => ({
        ready: true,
        binary: "gh",
        binaryPath: "/usr/bin/gh",
        authState: "authenticated",
        githubAuthMode: "host-gh",
        runtimeMode: "local-unsandboxed",
        injectedTokenPresent: false,
        depth: "shallow",
        detail: "ok",
        remediation: null,
        skippedGates: [],
        login: null,
        failureKind: null,
      }),
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("directive migrate");
  });

  it("skips migrate nudge when deposit is already npm-managed", () => {
    const root = seedConsumerProject();
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      "tag: 'v0.59.0'\nsha: abc\ninstall_root: '.deft/core'\nmanaged_by: 'npm'\n",
      "utf8",
    );
    const result = runSessionStart(root, {
      writeHistory: false,
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
      probeScm: () => ({
        ready: true,
        binary: "gh",
        binaryPath: "/usr/bin/gh",
        authState: "authenticated",
        githubAuthMode: "host-gh",
        runtimeMode: "local-unsandboxed",
        injectedTokenPresent: false,
        depth: "shallow",
        detail: "ok",
        remediation: null,
        skippedGates: [],
        login: null,
        failureKind: null,
      }),
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).not.toContain("directive migrate");
  });
});
