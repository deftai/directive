import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateXbriefDrift } from "./drift-gate.js";

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "xbrief-drift-"));
  git(root, ["init", "-q"]);
  return root;
}

function writeTracked(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
  git(root, ["add", "--", rel]);
}

/** A canonical corpus artifact using the migrated reference token. */
const CANONICAL_ARTIFACT = JSON.stringify(
  { xBRIEFInfo: { version: "0.8" }, refs: [{ type: "x-xbrief/reference" }] },
  null,
  2,
);

/** A corpus artifact that smuggled in the legacy reference token. */
const LEGACY_TOKEN_ARTIFACT = JSON.stringify(
  { xBRIEFInfo: { version: "0.8" }, refs: [{ type: "x-vbrief/reference" }] },
  null,
  2,
);

describe("evaluateXbriefDrift", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("exits 0 on a clean canonical xbrief tree", () => {
    root = initRepo();
    writeTracked(root, "xbrief/active/2026-06-30-1-thing.xbrief.json", CANONICAL_ARTIFACT);
    writeTracked(root, "xbrief/PROJECT-DEFINITION.xbrief.json", CANONICAL_ARTIFACT);
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.message).toContain("no legacy-layout drift");
  });

  it("exits 1 on a NEW *.xbrief.json artifact (legacy suffix)", () => {
    root = initRepo();
    writeTracked(root, "packages/core/regression.vbrief.json", CANONICAL_ARTIFACT);
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("legacy-suffix");
    expect(result.message).toContain("regression.vbrief.json");
  });

  it("exits 1 on a NEW top-level vbrief/ lifecycle dir", () => {
    root = initRepo();
    writeTracked(root, "vbrief/active/2026-06-30-1-thing.vbrief.json", CANONICAL_ARTIFACT);
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("legacy-lifecycle-dir");
  });

  it("exits 1 on a bare x-vbrief/ reference token in a canonical corpus artifact", () => {
    root = initRepo();
    writeTracked(root, "xbrief/active/2026-06-30-1-thing.xbrief.json", LEGACY_TOKEN_ARTIFACT);
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("legacy-reference-token");
  });

  it("does NOT trip on sanctioned back-compat fixture trees (allowlisted)", () => {
    root = initRepo();
    // Legacy read-path regression fixtures + the shipped content/vbrief surface +
    // forensic doc template + archived history + framework migration RESULT artifacts
    // legitimately retain the legacy layout / token and must stay green.
    writeTracked(root, "tests/fixtures/migration/clean/xbrief/x.xbrief.json", CANONICAL_ARTIFACT);
    writeTracked(root, "content/xbrief/conformance/valid/x.xbrief.json", CANONICAL_ARTIFACT);
    writeTracked(
      root,
      ".deft/core/xbrief/conformance/valid/extension-at-root.xbrief.json",
      CANONICAL_ARTIFACT,
    );
    writeTracked(
      root,
      "docs/reference/forensic-research/templates/x.xbrief.json",
      CANONICAL_ARTIFACT,
    );
    writeTracked(root, "history/archive/2026-03-20-thing/x.xbrief.json", CANONICAL_ARTIFACT);
    writeTracked(root, "xbrief/migration/legacy-note.xbrief.json", LEGACY_TOKEN_ARTIFACT);
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("still trips on legacy artifacts misplaced under .deft/core outside vbrief/", () => {
    root = initRepo();
    writeTracked(root, ".deft/core/xbrief/legacy.vbrief.json", CANONICAL_ARTIFACT);
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(1);
    expect(result.findings[0]?.path).toBe(".deft/core/xbrief/legacy.vbrief.json");
  });

  it("does NOT trip on TS source shims that intentionally mention legacy tokens", () => {
    root = initRepo();
    // The Part 1 resolver fallback, EXTENSION_PREFIXES legacy entry, #2110 migrate
    // path, and #1650 policy fallback are source files outside the scanned data plane.
    writeTracked(
      root,
      "packages/core/src/vbrief-validate/conformance.ts",
      `export const EXTENSION_PREFIXES = ["x-directive/", "x-vbrief/", "x-xbrief/"] as const;\n`,
    );
    writeTracked(
      root,
      "packages/core/src/layout/resolve.ts",
      `export const LEGACY_ARTIFACT_DIR = "vbrief";\nexport const LEGACY_ARTIFACT_SUFFIX = ".xbrief.json";\n`,
    );
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("honors a custom --allow-list file to sanction an additional path", () => {
    root = initRepo();
    writeTracked(root, "sandbox/legacy.vbrief.json", CANONICAL_ARTIFACT);
    const allowFile = join(root, "allow.txt");
    writeFileSync(allowFile, "# extra exception\nsandbox/**\n", "utf8");
    const withAllow = evaluateXbriefDrift(root, { allowListPath: allowFile });
    expect(withAllow.code).toBe(0);
    const withoutAllow = evaluateXbriefDrift(root);
    expect(withoutAllow.code).toBe(1);
  });

  it("exits 2 when --project-root is not a directory", () => {
    const result = evaluateXbriefDrift(join(tmpdir(), "xbrief-drift-does-not-exist-xyz"));
    expect(result.code).toBe(2);
    expect(result.stream).toBe("stderr");
  });

  it("exits 2 when --allow-list file is missing", () => {
    root = initRepo();
    const result = evaluateXbriefDrift(root, { allowListPath: join(root, "nope.txt") });
    expect(result.code).toBe(2);
    expect(result.message).toContain("--allow-list file not found");
  });

  it("staged mode only inspects staged files", () => {
    root = initRepo();
    // Commit a clean tree, then stage a NEW legacy artifact: staged mode must catch it.
    writeTracked(root, "xbrief/active/x.xbrief.json", CANONICAL_ARTIFACT);
    git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    writeTracked(root, "new.vbrief.json", CANONICAL_ARTIFACT);
    const staged = evaluateXbriefDrift(root, { mode: "staged" });
    expect(staged.code).toBe(1);
    expect(staged.findings[0]?.kind).toBe("legacy-suffix");
  });

  it("exits 1 on a correctly named *.xbrief.json with a vBRIEFInfo pin", () => {
    root = initRepo();
    writeTracked(
      root,
      "xbrief/specification.xbrief.json",
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { title: "x" } }, null, 2),
    );
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(1);
    expect(result.findings[0]?.kind).toBe("legacy-envelope-key");
    expect(result.findings[0]?.path).toBe("xbrief/specification.xbrief.json");
  });

  it("exits 1 on a hybrid xBRIEFInfo@0.6 envelope", () => {
    root = initRepo();
    writeTracked(
      root,
      "xbrief/plan.xbrief.json",
      JSON.stringify({ xBRIEFInfo: { version: "0.6" }, plan: { title: "x" } }, null, 2),
    );
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(1);
    expect(result.findings[0]?.kind).toBe("legacy-envelope-version");
  });

  it("does NOT trip lifecycle-folder historical v0.6 envelopes", () => {
    root = initRepo();
    const legacy = JSON.stringify(
      { vBRIEFInfo: { version: "0.6" }, plan: { title: "old" } },
      null,
      2,
    );
    writeTracked(root, "xbrief/completed/2026-01-01-old.xbrief.json", legacy);
    writeTracked(root, "xbrief/cancelled/2026-01-01-old.xbrief.json", legacy);
    writeTracked(root, "xbrief/proposed/2026-01-01-old.xbrief.json", legacy);
    writeTracked(root, "xbrief/pending/2026-01-01-old.xbrief.json", legacy);
    writeTracked(root, "xbrief/active/2026-01-01-old.xbrief.json", legacy);
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("does NOT trip an allowlisted tree that still carries vBRIEFInfo", () => {
    root = initRepo();
    writeTracked(
      root,
      "tests/fixtures/legacy.xbrief.json",
      JSON.stringify({ vBRIEFInfo: { version: "0.6" } }, null, 2),
    );
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(0);
  });

  it("exits 0 on a current xBRIEFInfo 0.8 envelope", () => {
    root = initRepo();
    writeTracked(root, "xbrief/specification.xbrief.json", CANONICAL_ARTIFACT);
    writeTracked(root, "xbrief/plan.xbrief.json", CANONICAL_ARTIFACT);
    const result = evaluateXbriefDrift(root);
    expect(result.code).toBe(0);
  });

  it("exits 0 with empty message when quiet option is true (lines 246-247)", () => {
    // quiet: true suppresses the success message, returning an empty string.
    root = initRepo();
    writeTracked(root, "xbrief/active/2026-06-30-1-thing.xbrief.json", CANONICAL_ARTIFACT);
    const result = evaluateXbriefDrift(root, { quiet: true });
    expect(result.code).toBe(0);
    expect(result.message).toBe("");
    expect(result.stream).toBe("stdout");
  });

  it("exits 2 when project root is not inside a git repo (lines 192-193)", () => {
    // A directory that exists but is not a git repo causes gitTrackedFiles to
    // throw GitCommandError, which listFiles converts to an error object.
    // evaluateXbriefDrift then returns code 2 via the !Array.isArray(listed) branch.
    const nonGitDir = mkdtempSync(join(tmpdir(), "xbrief-drift-non-git-"));
    try {
      const result = evaluateXbriefDrift(nonGitDir);
      expect(result.code).toBe(2);
      expect(result.stream).toBe("stderr");
      expect(result.message).toContain("verify_xbrief_drift:");
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
