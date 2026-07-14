import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANONICAL_UPGRADE_COMMAND, VENDORED_NPM_DEPOSIT_UPGRADE_COMMAND } from "./constants.js";
import { createPlainSink } from "./output.js";
import { runPayloadStalenessCheck } from "./payload-staleness.js";
import type { Finding } from "./types.js";

function seedManifest(root: string, sha: string, ref = "v0.56.0"): void {
  const core = join(root, ".deft", "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "VERSION"), `sha: ${sha}\nref: ${ref}\ntag: ${ref}\n`, "utf8");
}

describe("payload-staleness (#2003 / #2004)", () => {
  it("stale via git ls-remote emits npm upgrade command", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      seedManifest(root, "1".repeat(40));
      const findings: Finding[] = [];
      const sink = createPlainSink();
      let npmCalls = 0;
      runPayloadStalenessCheck(root, sink, (f) => findings.push(f), {
        isFile: (p) => p.endsWith("VERSION") || p.endsWith("AGENTS.md"),
        readText: (p) => (p.endsWith("VERSION") ? `sha: ${"1".repeat(40)}\nref: v0.56.0\n` : null),
        runGitLsRemote: () => ({ ok: true, stdout: `${"2".repeat(40)}\trefs/tags/v0.56.0\n` }),
        runNpmViewVersion: () => {
          npmCalls += 1;
          return { ok: true, version: "9.9.9" };
        },
      });
      const stale = findings.find((f) => f.status === "stale");
      expect(stale?.suggestion).toBe(CANONICAL_UPGRADE_COMMAND);
      expect(stale?.staleness_kind).toBe("pinned-ref-moved");
      expect(npmCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits the pnpm upgrade command when packageManager is pnpm (#2197)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      seedManifest(root, "1".repeat(40));
      const findings: Finding[] = [];
      const sink = createPlainSink();
      runPayloadStalenessCheck(root, sink, (f) => findings.push(f), {
        isFile: (p) => p.endsWith("VERSION") || p.endsWith("AGENTS.md"),
        readText: (p) => (p.endsWith("VERSION") ? `sha: ${"1".repeat(40)}\nref: v0.56.0\n` : null),
        runGitLsRemote: () => ({ ok: true, stdout: `${"2".repeat(40)}\trefs/tags/v0.56.0\n` }),
        packageManager: "pnpm",
      });
      const stale = findings.find((f) => f.status === "stale");
      expect(stale?.suggestion).toBe("pnpm add -g @deftai/directive@latest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("compares published releases when ls-remote yields no sha", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      seedManifest(root, "a".repeat(40), "v0.56.0");
      const findings: Finding[] = [];
      const sink = createPlainSink();
      runPayloadStalenessCheck(root, sink, (f) => findings.push(f), {
        isFile: (p) => p.includes("VERSION"),
        readText: (p) =>
          p.includes("VERSION") ? `sha: ${"a".repeat(40)}\nref: v0.56.0\ntag: v0.56.0\n` : null,
        runGitLsRemote: () => ({ ok: true, stdout: "" }),
        runNpmViewVersion: () => ({ ok: true, version: "0.56.2" }),
      });
      const stale = findings.find((f) => f.status === "stale");
      expect(stale?.resolver).toBe("npm-view");
      expect(stale?.staleness_kind).toBe("newer-release");
      expect(stale?.latest_version).toBe("0.56.2");
      expect(stale?.suggestion).toBe(CANONICAL_UPGRADE_COMMAND);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not npm-compare branch-pinned refs like master", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      seedManifest(root, "c".repeat(40), "master");
      const findings: Finding[] = [];
      const sink = createPlainSink();
      runPayloadStalenessCheck(root, sink, (f) => findings.push(f), {
        isFile: (p) => p.includes("VERSION"),
        readText: (p) => (p.includes("VERSION") ? `sha: ${"c".repeat(40)}\nref: master\n` : null),
        runGitLsRemote: () => ({ ok: true, stdout: "" }),
        runNpmViewVersion: () => ({ ok: true, version: "0.56.2" }),
      });
      expect(findings.find((f) => f.status === "stale")).toBeUndefined();
      expect(findings.find((f) => f.status === "unverified")).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("vendored npm-managed deposit stale via npm view emits two-hop upgrade (#2115)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      seedManifest(root, "d".repeat(40), "v0.63.0");
      const findings: Finding[] = [];
      const sink = createPlainSink();
      runPayloadStalenessCheck(root, sink, (f) => findings.push(f), {
        isFile: (p) => p.includes("VERSION"),
        readText: (p) =>
          p.includes("VERSION")
            ? `sha: ${"d".repeat(40)}\nref: v0.63.0\ntag: v0.63.0\nmanaged_by: 'npm'\n`
            : null,
        runGitLsRemote: () => ({ ok: true, stdout: "" }),
        runNpmViewVersion: () => ({ ok: true, version: "0.65.0" }),
      });
      const stale = findings.find((f) => f.status === "stale");
      expect(stale?.suggestion).toBe(VENDORED_NPM_DEPOSIT_UPGRADE_COMMAND);
      expect(String(stale?.suggestion)).toContain("deft update");
      expect(String(stale?.message)).toContain("deft update");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces unverified advisory when both resolvers fail", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      seedManifest(root, "b".repeat(40));
      const findings: Finding[] = [];
      const sink = createPlainSink();
      runPayloadStalenessCheck(root, sink, (f) => findings.push(f), {
        isFile: (p) => p.includes("VERSION"),
        readText: (p) =>
          p.includes("VERSION") ? `sha: ${"b".repeat(40)}\nref: v0.56.0\ntag: v0.56.0\n` : null,
        runGitLsRemote: () => ({ ok: false, stdout: "" }),
        runNpmViewVersion: () => ({ ok: false, version: "" }),
      });
      const unverified = findings.find((f) => f.status === "unverified");
      expect(unverified?.severity).toBe("warning");
      expect(String(unverified?.message)).toContain("UNVERIFIED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps registry lookup exceptions nonfatal", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      const sha = "6".repeat(40);
      const findings: Finding[] = [];
      expect(() =>
        runPayloadStalenessCheck(root, createPlainSink(), (f) => findings.push(f), {
          isFile: (p) => p.includes("VERSION"),
          readText: (p) =>
            p.includes("VERSION") ? `sha: ${sha}\nref: v0.56.0\ntag: v0.56.0\n` : null,
          runGitLsRemote: () => ({
            ok: true,
            stdout: `${sha}\trefs/tags/v0.56.0\n`,
          }),
          runNpmViewVersion: () => {
            throw new Error("offline");
          },
        }),
      ).not.toThrow();
      expect(findings.find((f) => f.status === "unverified")).toMatchObject({
        check: "payload-staleness",
        severity: "warning",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks for a newer release even when the pinned tag sha still matches", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      const sha = "e".repeat(40);
      seedManifest(root, sha, "v0.56.0");
      const findings: Finding[] = [];
      const sink = createPlainSink();
      runPayloadStalenessCheck(root, sink, (f) => findings.push(f), {
        isFile: (p) => p.includes("VERSION"),
        readText: (p) =>
          p.includes("VERSION") ? `sha: ${sha}\nref: v0.56.0\ntag: v0.56.0\n` : null,
        runGitLsRemote: () => ({ ok: true, stdout: `${sha}\trefs/tags/v0.56.0\n` }),
        runNpmViewVersion: () => ({ ok: true, version: "0.57.0" }),
      });

      const stale = findings.find((f) => f.status === "stale");
      expect(stale).toMatchObject({
        check: "payload-staleness",
        status: "stale",
        staleness_kind: "newer-release",
        installed_version: "0.56.0",
        latest_version: "0.57.0",
        resolver: "npm-view",
        suggestion: CANONICAL_UPGRADE_COMMAND,
      });
      expect(String(stale?.message)).toContain("Newer framework release available");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "0.56.0",
    "0.55.9",
  ])("does not nudge when npm latest is not newer: %s", (latestVersion) => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      const sha = "f".repeat(40);
      seedManifest(root, sha, "v0.56.0");
      const findings: Finding[] = [];
      runPayloadStalenessCheck(root, createPlainSink(), (f) => findings.push(f), {
        isFile: (p) => p.includes("VERSION"),
        readText: (p) =>
          p.includes("VERSION") ? `sha: ${sha}\nref: v0.56.0\ntag: v0.56.0\n` : null,
        runGitLsRemote: () => ({ ok: true, stdout: `${sha}\trefs/tags/v0.56.0\n` }),
        runNpmViewVersion: () => ({ ok: true, version: latestVersion }),
      });
      expect(findings.find((f) => f.status === "stale")).toBeUndefined();
      expect(findings.find((f) => f.status === "unverified")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not nudge a stable install toward a prerelease", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      const sha = "7".repeat(40);
      const findings: Finding[] = [];
      runPayloadStalenessCheck(root, createPlainSink(), (f) => findings.push(f), {
        isFile: (p) => p.includes("VERSION"),
        readText: (p) =>
          p.includes("VERSION") ? `sha: ${sha}\nref: v0.56.0\ntag: v0.56.0\n` : null,
        runGitLsRemote: () => ({ ok: true, stdout: `${sha}\trefs/tags/v0.56.0\n` }),
        runNpmViewVersion: () => ({ ok: true, version: "0.57.0-rc.1" }),
      });
      expect(findings.find((f) => f.status === "stale")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nudges a prerelease install toward the corresponding stable release", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      const sha = "8".repeat(40);
      const findings: Finding[] = [];
      runPayloadStalenessCheck(root, createPlainSink(), (f) => findings.push(f), {
        isFile: (p) => p.includes("VERSION"),
        readText: (p) =>
          p.includes("VERSION") ? `sha: ${sha}\nref: v0.57.0-rc.1\ntag: v0.57.0-rc.1\n` : null,
        runGitLsRemote: () => ({
          ok: true,
          stdout: `${sha}\trefs/tags/v0.57.0-rc.1\n`,
        }),
        runNpmViewVersion: () => ({ ok: true, version: "0.57.0" }),
      });
      expect(findings.find((f) => f.status === "stale")).toMatchObject({
        staleness_kind: "newer-release",
        installed_version: "0.57.0-rc.1",
        latest_version: "0.57.0",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("labels a newer prerelease as the latest release without calling it stable", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      const sha = "a".repeat(40);
      const findings: Finding[] = [];
      runPayloadStalenessCheck(root, createPlainSink(), (f) => findings.push(f), {
        isFile: (p) => p.includes("VERSION"),
        readText: (p) =>
          p.includes("VERSION") ? `sha: ${sha}\nref: v0.57.0-rc.1\ntag: v0.57.0-rc.1\n` : null,
        runGitLsRemote: () => ({
          ok: true,
          stdout: `${sha}\trefs/tags/v0.57.0-rc.1\n`,
        }),
        runNpmViewVersion: () => ({ ok: true, version: "0.57.0-rc.2" }),
      });

      const stale = findings.find((f) => f.status === "stale");
      expect(stale).toMatchObject({
        installed_version: "0.57.0-rc.1",
        latest_version: "0.57.0-rc.2",
      });
      expect(String(stale?.message)).toContain("latest v0.57.0-rc.2");
      expect(String(stale?.message)).not.toContain("latest stable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not query npm for a branch pin whose sha matches", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-"));
    try {
      const sha = "9".repeat(40);
      let npmCalls = 0;
      const findings: Finding[] = [];
      runPayloadStalenessCheck(root, createPlainSink(), (f) => findings.push(f), {
        isFile: (p) => p.includes("VERSION"),
        readText: (p) => (p.includes("VERSION") ? `sha: ${sha}\nref: master\n` : null),
        runGitLsRemote: () => ({ ok: true, stdout: `${sha}\trefs/heads/master\n` }),
        runNpmViewVersion: () => {
          npmCalls += 1;
          return { ok: true, version: "99.0.0" };
        },
      });
      expect(npmCalls).toBe(0);
      expect(findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
