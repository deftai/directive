import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LifecycleVisibleResult } from "../lifecycle-visible/evaluate.js";
import type { EnvironmentContext } from "../platform/shell-context.js";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
import { READ_ONLY_POSTURE, runSessionStart } from "./session-start.js";

const temps: string[] = [];
const environment: EnvironmentContext = {
  hostPlatform: "linux",
  shell: { name: "bash", path: "/bin/bash", kind: "default", source: "SHELL" },
};

afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-lv-"));
  temps.push(root);
  return root;
}

function userMd(): ResolveUserMdResult {
  return {
    path: "/home/x/.config/deft/USER.md",
    rung: "platform-config",
    found: true,
    diagnostic: "USER.md resolved from platform config dir",
    searched: [],
  };
}

const hidden: LifecycleVisibleResult = {
  code: 0,
  message: "hidden",
  stream: "stdout",
  findings: [
    {
      path: "xbrief/active/",
      kind: "ignored",
      source: ".git/info/exclude",
      line: 24,
      rule: "xbrief/active/",
      raw: ".git/info/exclude:24:xbrief/active/\txbrief/active/",
    },
  ],
  enforce: false,
  failOpen: true,
};

const gitOk = (root: string) => (_r: string, args: readonly string[]) => {
  if (args[0] === "rev-parse" && args.includes("HEAD")) {
    return { code: 0, stdout: "abc123", stderr: "" };
  }
  if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
    return { code: 0, stdout: root, stderr: "" };
  }
  if (args[0] === "check-ignore") return { code: 1, stdout: "", stderr: "" };
  if (args[0] === "ls-files") return { code: 0, stdout: "", stderr: "" };
  return { code: 1, stdout: "", stderr: "" };
};

describe("session:start lifecycle-visible advisory (#3505)", () => {
  it("read-only posture warns when a lifecycle root is hidden and stays exit 0", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      posture: READ_ONLY_POSTURE,
      resolveUserMd: () => userMd(),
      probeEnvironment: () => environment,
      probeLifecycleVisible: () => hidden,
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain(
      "[deft lifecycle-visible] hidden xbrief/active/  (.git/info/exclude:24:xbrief/active/)",
    );
    expect(result.lines.join("\n")).toContain("ADVISORY");
  });

  it("mutation cold path stays silent when lifecycle roots are visible", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      writeHistory: false,
      resolveUserMd: () => userMd(),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      probeEnvironment: () => environment,
      runGit: gitOk(root),
      probeLifecycleVisible: () => ({
        code: 0,
        message: "OK",
        stream: "stdout",
        findings: [],
        enforce: false,
        failOpen: true,
      }),
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).not.toContain("[deft lifecycle-visible]");
  });

  it("does not fail session:start when the probe throws", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      posture: READ_ONLY_POSTURE,
      resolveUserMd: () => userMd(),
      probeEnvironment: () => environment,
      probeLifecycleVisible: () => {
        throw new Error("boom");
      },
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).not.toContain("[deft lifecycle-visible]");
  });
});
