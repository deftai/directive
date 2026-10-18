import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LifecycleVisibleResult } from "../lifecycle-visible/evaluate.js";
import type { EnvironmentContext } from "../platform/shell-context.js";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
import {
  classifyLifecycleOccupancy,
  formatLifecycleOccupancySoftWarnLines,
  NEVER_INCEPTED_SOFT_WARN,
} from "../doctor/main.js";
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
      probe: "xbrief/active/",
      candidateRule: "xbrief/active/",
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
      "[deft lifecycle-visible] hidden xbrief/active/  (.git/info/exclude:24:xbrief/active/; probe xbrief/active/; candidate xbrief/active/)",
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

describe("lifecycle occupancy soft-warn helper (#4229)", () => {
  it("formats mutation-session soft-warn lines only for never-incepted", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    mkdirSync(join(root, "xbrief", "cancelled"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "id", status: "active", items: [] } }),
      "utf8",
    );
    const occ = classifyLifecycleOccupancy(root);
    expect(occ.kind).toBe("never_incepted");
    const lines = formatLifecycleOccupancySoftWarnLines(occ);
    expect(lines[0]).toBe(NEVER_INCEPTED_SOFT_WARN);
    expect(lines.join("\n")).toContain("Phase 3");
  });

  it("stays silent for cancelled-only history (lawful idle)", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "cancelled"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "cancelled", "old.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "c", status: "cancelled", items: [] } }),
      "utf8",
    );
    const occ = classifyLifecycleOccupancy(root);
    expect(occ.kind).toBe("has_history_no_current_scope");
    expect(formatLifecycleOccupancySoftWarnLines(occ)).toEqual([]);
  });
});
