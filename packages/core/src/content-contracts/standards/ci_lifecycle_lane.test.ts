import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readText, repoRoot } from "./_helpers.js";

/** Top-level job mapping block in a workflow YAML file. */
function jobBlock(yaml: string, id: string): string {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  if (start < 0) {
    throw new Error(`job ${id} not found`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z][A-Za-z0-9_-]*:/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const SCRIPT = join(repoRoot(), ".github", "scripts", "artifact-only-lifecycle.mjs");

/** Real two-file leftover-completion shape from sampled lifecycle PRs (#3678). */
const TWO_FILE_SHAPE = [
  "CHANGELOG.md",
  "xbrief/completed/2026-08-24-3671-leftover-completed-tracked.xbrief.json",
] as const;

function artifactOnly(paths: string[]): boolean {
  const out = execFileSync(process.execPath, [SCRIPT, ...paths], { encoding: "utf8" }).trim();
  const match = /^artifact_only=(true|false)$/m.exec(out);
  if (!match?.[1]) {
    throw new Error(`unexpected predicate output: ${JSON.stringify(out)}`);
  }
  return match[1] === "true";
}

function workflowOnBlock(text: string): string {
  const start = text.indexOf("\non:");
  const onAt = start >= 0 ? start + 1 : text.startsWith("on:") ? 0 : -1;
  if (onAt < 0) {
    throw new Error("workflow on: block not found");
  }
  const after = text.slice(onAt);
  const perm = after.search(/\npermissions:/);
  if (perm < 0) {
    throw new Error("permissions: not found after on:");
  }
  return after.slice(0, perm);
}

describe("artifact-only lifecycle CI lane (#3678)", () => {
  it("two-file leftover shape (completed xBRIEF + CHANGELOG) routes to the lane", () => {
    expect(artifactOnly([...TWO_FILE_SHAPE])).toBe(true);
  });

  it("CHANGELOG-only head routes to the lane", () => {
    expect(artifactOnly(["CHANGELOG.md"])).toBe(true);
  });

  it("xbrief/completed-only is in the allowlist (paired with CHANGELOG in real PRs)", () => {
    expect(artifactOnly(["xbrief/completed/2026-08-24-example.xbrief.json"])).toBe(true);
  });

  it("empty diff fails closed to the full stack", () => {
    expect(artifactOnly([])).toBe(false);
  });

  it("allowlist is exactly CHANGELOG.md and xbrief/completed/**", () => {
    expect(artifactOnly(["docs/CHANGELOG.md"])).toBe(false);
    expect(artifactOnly(["xbrief/completed"])).toBe(false);
    expect(artifactOnly(["xbrief/completed-extra.json"])).toBe(false);
    expect(artifactOnly(["xbrief/active/foo.xbrief.json"])).toBe(false);
    expect(artifactOnly(["xbrief/pending/foo.xbrief.json"])).toBe(false);
  });

  it("rename source plus allowlisted dest fails closed (workflow lists both via --no-renames)", () => {
    expect(
      artifactOnly(["packages/core/src/foo.ts", "xbrief/completed/2026-08-24-renamed.xbrief.json"]),
    ).toBe(false);
    expect(artifactOnly(["packages/core/src/foo.ts", "CHANGELOG.md"])).toBe(false);
  });

  it("a diff touching packages/** takes the full stack", () => {
    expect(artifactOnly([...TWO_FILE_SHAPE, "packages/core/src/index.ts"])).toBe(false);
  });

  it("a diff touching .github/** takes the full stack", () => {
    expect(artifactOnly([...TWO_FILE_SHAPE, ".github/workflows/ci.yml"])).toBe(false);
  });

  it("a diff touching xbrief/proposed/** takes the full stack", () => {
    expect(artifactOnly([...TWO_FILE_SHAPE, "xbrief/proposed/2026-08-24-next.xbrief.json"])).toBe(
      false,
    );
  });

  it("product commits behind an artifact-only tip still take the full stack", () => {
    // Merge-base evaluation: the complete diff includes earlier product files.
    expect(
      artifactOnly([
        "packages/core/src/foo.ts",
        "CHANGELOG.md",
        "xbrief/completed/2026-08-24-tip.xbrief.json",
      ]),
    ).toBe(false);
  });

  it("ci.yml changes job diffs against the merge base and exposes artifact_only", () => {
    const ci = readText(".github/workflows/ci.yml");
    const script = readText(".github/scripts/compute-artifact-only.sh");
    expect(ci).toContain("  changes:");
    expect(ci).toMatch(/name:\s*Changes \(artifact-only predicate\)/);
    expect(ci).toContain("artifact_only:");
    expect(ci).toContain("compute-artifact-only.sh");
    expect(script).toContain("git diff --name-only --no-renames");
    expect(script).toContain("ARTIFACT_ONLY_SCRIPT");
    expect(script).toMatch(/\$\{BASE\}\.\.\.\$\{TIP\}/);
  });

  it("predicate scripts run from the merge-base copy, not PR HEAD", () => {
    const ci = readText(".github/workflows/ci.yml");
    const smoke = readText(".github/workflows/greenfield-python-free-smoke.yml");
    const script = readText(".github/scripts/compute-artifact-only.sh");
    for (const text of [ci, smoke]) {
      expect(text).toMatch(/git cat-file -e "\$\{BASE\}:\$\{MJS\}"/);
      expect(text).toContain("Trusted predicate absent");
      expect(text).toMatch(/git show "\$\{BASE\}:\$\{MJS\}"/);
      expect(text).toContain("export ARTIFACT_ONLY_SCRIPT=");
      expect(text).not.toMatch(/^        run: bash \.github\/scripts\/compute-artifact-only\.sh\s*$/m);
    }
    expect(script).toContain("ARTIFACT_ONLY_SCRIPT unset");
  });

  it("ci.yml does not use workflow-level paths filters (required aggregator must report)", () => {
    const ci = readText(".github/workflows/ci.yml");
    const onBlock = workflowOnBlock(ci);
    expect(onBlock).not.toMatch(/\bpaths:/);
    expect(onBlock).not.toMatch(/\bpaths-ignore:/);
  });

  it("exactly one job publishes the required TypeScript check name", () => {
    const ci = readText(".github/workflows/ci.yml");
    const matches = ci.match(/name:\s*TypeScript \(build \+ lint \+ test\)/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(ci).toContain("  ts:");
  });

  it("required-check comment map matches live protection (only TypeScript is YES)", () => {
    const ci = readText(".github/workflows/ci.yml");
    expect(ci).toMatch(
      /\|\s*Aggregator\s*\|\s*ts\s+\|\s*TypeScript \(build \+ lint \+ test\)\s+\|\s*YES\s+\|/,
    );
    expect(ci).toMatch(/\|\s*Aggregator\s*\|\s*go\s+\|\s*Go \(test \+ build\)\s+\|\s*no\s+\|/);
    expect(ci).toMatch(
      /\|\s*Aggregator\s*\|\s*merge-gate\s+\|\s*Merge gate \(task check\)\s+\|\s*no\s+\|/,
    );
    expect(ci).not.toMatch(/\|\s*Aggregator\s*\|\s*go\s+\|\s*Go \(test \+ build\)\s+\|\s*YES\s+\|/);
    expect(ci).not.toMatch(
      /\|\s*Aggregator\s*\|\s*merge-gate\s+\|\s*Merge gate \(task check\)\s+\|\s*YES\s+\|/,
    );
  });

  it("non-required ci.yml jobs gate on the artifact-only output", () => {
    const ci = readText(".github/workflows/ci.yml");
    const skipIf = "if: always() && needs.changes.outputs.artifact_only != 'true'";
    expect(ci).toContain("  go-primary:");
    expect(ci).toContain("  merge-gate-primary:");
    expect(ci).toContain("  windows-task-dispatch:");
    const goPrimary = jobBlock(ci, "go-primary");
    const mergePrimary = jobBlock(ci, "merge-gate-primary");
    const windows = jobBlock(ci, "windows-task-dispatch");
    const goAgg = jobBlock(ci, "go");
    const mergeAgg = jobBlock(ci, "merge-gate");
    for (const block of [goPrimary, mergePrimary, windows, goAgg, mergeAgg]) {
      expect(block).toContain(skipIf);
      expect(block).toMatch(/needs:\s*\[changes/);
    }
  });

  it("TypeScript aggregator stays ungated by the artifact-only predicate", () => {
    const ci = readText(".github/workflows/ci.yml");
    const job = jobBlock(ci, "ts");
    expect(job).toContain("name: TypeScript (build + lint + test)");
    expect(job).toContain("if: always()");
    expect(job).not.toContain("artifact_only");
  });

  it("watchdog and arm do not treat skipped Go/merge-gate as capacity death on artifact-only", () => {
    const ci = readText(".github/workflows/ci.yml");
    expect(ci).toContain("ARTIFACT_ONLY:");
    expect(ci).toContain("needs.changes.outputs.artifact_only");
    expect(ci).toMatch(/ARTIFACT_ONLY" == "true"/);
  });

  it("resolver still treats a skipped primary as failure, not success", () => {
    const resolver = readText(".github/scripts/resolve-ci-authoritative-lane.mjs");
    expect(resolver).toContain('conclusion === "success"');
    expect(resolver).not.toMatch(/skipped.*success|success.*skipped/i);
    expect(resolver).toContain("isCapacityDeath");
  });

  it("smoke gates on the merge-base predicate; branch-gate always runs", () => {
    const smoke = readText(".github/workflows/greenfield-python-free-smoke.yml");
    const branchGate = readText(".github/workflows/branch-gate.yml");
    const skipIf = "if: always() && needs.changes.outputs.artifact_only != 'true'";
    expect(smoke).toContain("compute-artifact-only.sh");
    expect(smoke).toContain(skipIf);
    expect(jobBlock(smoke, "smoke")).toMatch(/needs:\s*\[changes/);
    const smokeOn = workflowOnBlock(smoke);
    const gateOn = workflowOnBlock(branchGate);
    // Native GitHub path filters hide rename sources; these workflows must not use them.
    expect(smokeOn).not.toMatch(/\bpaths-ignore:/);
    expect(gateOn).not.toMatch(/\bpaths-ignore:/);
    expect(smokeOn).not.toMatch(/\bpaths:/);
    expect(gateOn).not.toMatch(/\bpaths:/);
  });
});
