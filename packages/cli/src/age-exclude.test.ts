/** #6164 / #6181: read-only release-step AgeExclude gate. The #5854 heal was removed (Outcome B). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluatePreInstallAgeExcludeFile,
  evaluatePreInstallAgeExcludeText,
  runReleaseLocalUpdatePreInstallGate,
} from "./age-exclude.js";

const TEMPS: string[] = [];
function tempRoot(yaml?: string): string {
  const root = mkdtempSync(join(tmpdir(), "age-exclude-"));
  TEMPS.push(root);
  if (yaml !== undefined) writeFileSync(join(root, "pnpm-workspace.yaml"), yaml, "utf8");
  return root;
}
afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

const BASE = (rows: string) => `packages:
  - packages/*
# supply-chain: keep a 24h age gate except for our own fresh pins
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - '@deftai/some-other@1.0.0'
${rows}  - left-pad
allowBuilds:
  esbuild: true
  '@deftai/directive-runtime@0.127.0': true
`;

describe("evaluatePreInstallAgeExcludeText (#6164)", () => {
  it("exact-row pass", () => {
    const r = evaluatePreInstallAgeExcludeText(
      BASE("  - '@deftai/directive-runtime@0.128.0'\n"),
      "0.128.0",
    );
    expect(r).toEqual({ ok: true, reason: "exact-row-present" });
  });

  it("wrong-version refuse", () => {
    const r = evaluatePreInstallAgeExcludeText(
      BASE("  - '@deftai/directive-runtime@0.127.0'\n"),
      "0.128.0",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refuse");
    expect(r.reason).toBe("missing-exact-row");
  });

  it("version-prefix false-pass refuse (0.129.1 vs 0.129.10)", () => {
    const r = evaluatePreInstallAgeExcludeText(
      BASE("  - '@deftai/directive-runtime@0.129.10'\n"),
      "0.129.1",
    );
    expect(r.ok).toBe(false);
  });

  it("comment-only and out-of-block matches refuse", () => {
    const commented = BASE("  # - '@deftai/directive-runtime@0.128.0'\n");
    expect(evaluatePreInstallAgeExcludeText(commented, "0.128.0").ok).toBe(false);
    const outOfBlock =
      "packages:\n  - packages/*\nminimumReleaseAgeExclude:\n  - left-pad\nallowBuilds:\n  '@deftai/directive-runtime@0.128.0': true\n";
    expect(evaluatePreInstallAgeExcludeText(outOfBlock, "0.128.0").ok).toBe(false);
  });

  it("absent key continues", () => {
    const y = "packages:\n  - packages/*\nallowBuilds:\n  esbuild: true\n";
    expect(evaluatePreInstallAgeExcludeText(y, "0.128.0")).toEqual({
      ok: true,
      reason: "key-absent",
    });
  });
});

describe("evaluatePreInstallAgeExcludeFile + control-flow (#6164)", () => {
  it("absent-file/read fail closed", () => {
    const root = tempRoot();
    const r = evaluatePreInstallAgeExcludeFile(root, "0.128.0");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected read-error");
    expect(r.reason).toBe("read-error");
  });

  it("control-flow harness: install not reached on probe failure", () => {
    const root = tempRoot(BASE("  - '@deftai/directive-runtime@0.127.0'\n"));
    let installed = false;
    const r = runReleaseLocalUpdatePreInstallGate({
      projectRoot: root,
      version: "0.128.0",
      install: () => {
        installed = true;
      },
    });
    expect(r.ok).toBe(false);
    expect(installed).toBe(false);
  });

  it("control-flow harness: install runs after exact-row pass", () => {
    const root = tempRoot(BASE("  - '@deftai/directive-runtime@0.128.0'\n"));
    let installed = false;
    const r = runReleaseLocalUpdatePreInstallGate({
      projectRoot: root,
      version: "0.128.0",
      install: () => {
        installed = true;
      },
    });
    expect(r).toEqual({ ok: true, reason: "exact-row-present" });
    expect(installed).toBe(true);
  });
});
