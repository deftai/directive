/**
 * Tests for verify:contained-writes inventory + --enforce path (#2951 Phase 2).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTAINED_WRITES_ALLOWLIST,
  evaluateContainedWrites,
  NON_PRODUCT_HARNESS_PATH_MARKERS,
} from "./contained-writes.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe("evaluateContainedWrites (#2951)", () => {
  it("exits 2 when project root is missing", () => {
    const missing = join(tmpdir(), `cw-verify-missing-${Date.now()}`);
    const result = evaluateContainedWrites({ projectRoot: missing });
    expect(result.code).toBe(2);
    expect(result.findings).toEqual([]);
  });

  it("is fail-open (exit 0) when raw sinks exist without --enforce", () => {
    const root = freshDir("cw-verify-open-");
    const src = join(root, "packages", "core", "src", "evil");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "sink.ts"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("/tmp/x", "y");\n',
      "utf8",
    );
    const result = evaluateContainedWrites({ projectRoot: root });
    expect(result.code).toBe(0);
    expect(result.failOpen).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.message).toMatch(/fail-open|ADVISORY/i);
  });

  it("fails closed with exit 1 under --enforce on a fixture raw write sink", () => {
    const root = freshDir("cw-verify-enforce-");
    const src = join(root, "packages", "core", "src", "evil");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "sink.ts"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("/tmp/x", "y");\n',
      "utf8",
    );
    const result = evaluateContainedWrites({ projectRoot: root, enforce: true });
    expect(result.code).toBe(1);
    expect(result.failOpen).toBe(false);
    expect(result.enforce).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.path.includes("evil/sink.ts"))).toBe(true);
    expect(result.message).toMatch(/FAIL: --enforce/i);
    expect(result.stream).toBe("stderr");
  });

  it("Phase 2 allowlist no longer grandfathers cache/io or lifecycle/events", () => {
    expect(CONTAINED_WRITES_ALLOWLIST).not.toContain("packages/core/src/cache/io.ts");
    expect(CONTAINED_WRITES_ALLOWLIST).not.toContain("packages/core/src/lifecycle/events.ts");
    expect(CONTAINED_WRITES_ALLOWLIST).toContain("packages/core/src/fs/contained-write.ts");
  });

  it("skips test files and allowlisted modules", () => {
    const root = freshDir("cw-verify-allow-");
    const fsDir = join(root, "packages", "core", "src", "fs");
    mkdirSync(fsDir, { recursive: true });
    writeFileSync(join(fsDir, "contained-write.ts"), 'writeFileSync("x", "y");\n', "utf8");
    writeFileSync(join(fsDir, "contained-write.test.ts"), 'writeFileSync("x", "y");\n', "utf8");
    const result = evaluateContainedWrites({ projectRoot: root, enforce: true });
    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("allowlist seed includes contained-write implementation", () => {
    expect(CONTAINED_WRITES_ALLOWLIST).toContain("packages/core/src/fs/contained-write.ts");
  });

  it("allowlists intended-placement read-only fd pin (#3424)", () => {
    expect(CONTAINED_WRITES_ALLOWLIST).toContain(
      "packages/core/src/preflight/intended-placement.ts",
    );
  });

  it("does not allowlist a path that merely ends with an allowlisted suffix", () => {
    const root = freshDir("cw-verify-endswith-");
    const spoof = join(root, "packages", "core", "src", "evil", "packages", "core", "src", "fs");
    mkdirSync(spoof, { recursive: true });
    writeFileSync(join(spoof, "contained-write.ts"), "writeFileSync(a, b);\n", "utf8");
    const result = evaluateContainedWrites({ projectRoot: root, enforce: true });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.path.includes("evil"))).toBe(true);
  });

  it("detects low-level openSync/writeSync sinks under --enforce", () => {
    const root = freshDir("cw-verify-opensync-");
    const src = join(root, "packages", "core", "src", "evil");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "low.ts"),
      'import { openSync, writeSync } from "node:fs";\nconst fd = openSync(p, "w");\nwriteSync(fd, buf);\n',
      "utf8",
    );
    const result = evaluateContainedWrites({ projectRoot: root, enforce: true });
    expect(result.code).toBe(1);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("migrated #3953 product sinks are not allowlisted", () => {
    expect(CONTAINED_WRITES_ALLOWLIST).not.toContain("packages/core/src/platform/changelog-cli.ts");
    expect(CONTAINED_WRITES_ALLOWLIST).not.toContain("packages/core/src/render/export-spec.ts");
    expect(CONTAINED_WRITES_ALLOWLIST).not.toContain("packages/core/src/render/prd-render.ts");
    expect(CONTAINED_WRITES_ALLOWLIST).not.toContain("packages/core/src/render/spec-render.ts");
  });

  it("does not grow the allowlist without an explicit snapshot update (#3953)", () => {
    const frozen = [
      "packages/core/src/deposit/contain.ts",
      "packages/core/src/deposit/copy-tree.ts",
      "packages/core/src/doctor/main.ts",
      "packages/core/src/eval-health-relocation/evaluate.ts",
      "packages/core/src/fs/contained-write.ts",
      "packages/core/src/fs/projection-containment.ts",
      "packages/core/src/intake/issue-ingest.ts",
      "packages/core/src/intake/reconcile-issues.ts",
      "packages/core/src/issue-sync/sync-from-xbrief.ts",
      "packages/core/src/orchestration/verify-judgment-gates.ts",
      "packages/core/src/preflight/intended-placement.ts",
      "packages/core/src/release/build-dist.ts",
      "packages/core/src/release/gh.ts",
      "packages/core/src/release/pipeline-fixture.ts",
      "packages/core/src/release/pipeline.ts",
      "packages/core/src/render/roadmap-render.ts",
      "packages/core/src/render/rule-map.ts",
      "packages/core/src/scm/gh-rest.ts",
      "packages/core/src/slice/lock.ts",
      "packages/core/src/triage/actions/candidates-log.ts",
      "packages/core/src/triage/bootstrap/index.ts",
      "packages/core/src/triage/reconcile/reconcile.ts",
      "packages/core/src/triage/scope-drift/add-ignore.ts",
      "packages/core/src/triage/scope/coverage.ts",
      "packages/core/src/triage/scope/mutations-core.ts",
      "packages/core/src/triage/smoketest/index.ts",
      "packages/core/src/triage/subscribe/index.ts",
      "packages/core/src/triage/summary/index.ts",
      "packages/core/src/vbrief-build/project-definition-io.ts",
      "packages/core/src/vbrief-build/speckit.ts",
      "packages/core/src/vbrief-reconcile/reconciliation.ts",
      "packages/core/src/vbrief-validation/safety.ts",
      "packages/core/src/xbrief-migrate/agents-header.ts",
    ];
    expect([...CONTAINED_WRITES_ALLOWLIST].sort()).toEqual([...frozen].sort());
  });

  it("excludes release-e2e, integration-e2e, and parity-scenarios harness paths (#2980)", () => {
    expect(NON_PRODUCT_HARNESS_PATH_MARKERS).toEqual(
      expect.arrayContaining(["/release-e2e/", "/integration-e2e/", "parity-scenarios.ts"]),
    );
    const root = freshDir("cw-verify-harness-");
    const base = join(root, "packages", "core", "src");
    const releaseE2e = join(base, "release-e2e");
    const integrationE2e = join(base, "integration-e2e");
    const vbrief = join(base, "vbrief-validation");
    const product = join(base, "product");
    mkdirSync(releaseE2e, { recursive: true });
    mkdirSync(integrationE2e, { recursive: true });
    mkdirSync(vbrief, { recursive: true });
    mkdirSync(product, { recursive: true });
    writeFileSync(join(releaseE2e, "npm-ops.ts"), 'writeFileSync("/tmp/e2e", "x");\n', "utf8");
    writeFileSync(join(integrationE2e, "helpers.ts"), 'writeFileSync("/tmp/ie2e", "x");\n', "utf8");
    writeFileSync(
      join(vbrief, "parity-scenarios.ts"),
      'writeFileSync("/tmp/parity", "x");\n',
      "utf8",
    );
    writeFileSync(join(product, "sink.ts"), 'writeFileSync("/tmp/product", "x");\n', "utf8");

    const open = evaluateContainedWrites({ projectRoot: root });
    expect(open.findings.every((f) => !f.path.includes("release-e2e"))).toBe(true);
    expect(open.findings.every((f) => !f.path.includes("integration-e2e"))).toBe(true);
    expect(open.findings.every((f) => !f.path.includes("parity-scenarios"))).toBe(true);
    expect(open.findings.some((f) => f.path.includes("product/sink.ts"))).toBe(true);

    const enforced = evaluateContainedWrites({ projectRoot: root, enforce: true });
    expect(enforced.code).toBe(1);
    expect(enforced.findings.some((f) => f.path.includes("product/sink.ts"))).toBe(true);
    expect(enforced.findings.some((f) => f.path.includes("release-e2e"))).toBe(false);
    expect(enforced.findings.some((f) => f.path.includes("integration-e2e"))).toBe(false);
    expect(enforced.findings.some((f) => f.path.includes("parity-scenarios"))).toBe(false);
  });
});
