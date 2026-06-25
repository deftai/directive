import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANONICAL_UPGRADE_COMMAND } from "./constants.js";
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
      runPayloadStalenessCheck(root, sink, (f) => findings.push(f), {
        isFile: (p) => p.endsWith("VERSION") || p.endsWith("AGENTS.md"),
        readText: (p) => (p.endsWith("VERSION") ? `sha: ${"1".repeat(40)}\nref: v0.56.0\n` : null),
        runGitLsRemote: () => ({ ok: true, stdout: `${"2".repeat(40)}\trefs/tags/v0.56.0\n` }),
      });
      const stale = findings.find((f) => f.status === "stale");
      expect(stale?.suggestion).toBe(CANONICAL_UPGRADE_COMMAND);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to npm view when ls-remote yields no sha", () => {
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
});
