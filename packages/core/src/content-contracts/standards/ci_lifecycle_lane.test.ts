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

  it("ROADMAP.md is not allowlisted, alone or with leftover shape (#4316)", () => {
    // Invert of closed unmerged PR 4196, which set artifactOnly(["ROADMAP.md"]) true
    // so leftover land could carry the shared snapshot. Named false-case is the lock.
    expect(artifactOnly(["ROADMAP.md"])).toBe(false);
    expect(artifactOnly([...TWO_FILE_SHAPE, "ROADMAP.md"])).toBe(false);
    expect(artifactOnly(["docs/ROADMAP.md"])).toBe(false);
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
      expect(text).not.toMatch(/run: bash \.github\/scripts\/compute-artifact-only\.sh/);
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
    const matches = ci.match(/name:\s*TypeScript \(build \+ lint\)/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(ci).toContain("  ts:");
  });

  it("enrollment docs name the artifact-only skip path before a ruleset flip (#633)", () => {
    const github = readText("scm/github.md");
    expect(github).toContain("Merge-gate aggregator enrollment (#633)");
    expect(github).toContain("Merge gate (task check)");
    expect(github).toContain("if: always() && needs.changes.outputs.artifact_only != 'true'");
    expect(github).toContain("operator-owned repo-scoped ruleset");
    expect(github).toMatch(/empty-PUT/i);
    expect(github).toContain("#4912");
  });

  it("required-check comment map matches live protection (TypeScript and Merge gate are YES)", () => {
    const ci = readText(".github/workflows/ci.yml");
    expect(ci).toMatch(
      /\|\s*Aggregator\s*\|\s*ts\s+\|\s*TypeScript \(build \+ lint\)\s+\|\s*YES\s+\|/,
    );
    expect(ci).toMatch(
      /\|\s*Aggregator\s*\|\s*merge-gate\s+\|\s*Merge gate \(task check\)\s+\|\s*YES\s+\|/,
    );
  });

  it("non-required ci.yml jobs gate on the artifact-only output", () => {
    const ci = readText(".github/workflows/ci.yml");
    const skipIf = "if: always() && needs.changes.outputs.artifact_only != 'true'";
    expect(ci).toContain("  merge-gate-primary:");
    expect(ci).toContain("  windows-task-dispatch:");
    const mergePrimary = jobBlock(ci, "merge-gate-primary");
    const windows = jobBlock(ci, "windows-task-dispatch");
    const mergeAgg = jobBlock(ci, "merge-gate");
    expect(windows).toContain(skipIf);
    // #7014: the merge-gate primary uses `!cancelled()` so an ordinary cancel takes.
    expect(mergePrimary).toContain(
      "if: ${{ !cancelled() && needs.changes.outputs.artifact_only != 'true' && needs.changes.outputs.queue_passed != 'true' }}",
    );
    for (const block of [mergePrimary, windows]) {
      expect(block).toMatch(/needs:\s*\[changes/);
    }
    // #6584: queue reuse overrides the artifact-only skip on the aggregator.
    expect(mergeAgg).toContain(
      "if: ${{ !cancelled() && (needs.changes.outputs.artifact_only != 'true' || needs.changes.outputs.queue_passed == 'true') }}",
    );
    expect(mergeAgg).toMatch(/needs:\s*\[changes/);
  });

  it("merge-gate lanes bound the check step and the job; ordinary cancel takes (#7014)", () => {
    const ci = readText(".github/workflows/ci.yml");
    for (const id of ["merge-gate-primary", "merge-gate-failover"]) {
      const block = jobBlock(ci, id);
      expect(block).toMatch(/\n {4}timeout-minutes: 30\n/);
      const step = /- name: task check:merge[^\n]*\n {8}timeout-minutes: 20\n {8}run: task check:merge\n/;
      expect(block).toMatch(step);
      expect(block).not.toMatch(/\n {4}if: always\(\)/);
    }
    const failover = jobBlock(ci, "merge-gate-failover");
    expect(failover).toContain("needs.capacity-arm.outputs.merge_failover == 'true' }}");
    const agg = jobBlock(ci, "merge-gate");
    expect(agg).not.toMatch(/\n {4}if: always\(\)/);
    expect(agg).toContain('OBSERVATION_BUDGET_MINUTES: "35"');
    // Only the merge-gate aggregator carries a budget; the TypeScript check keeps its deadline.
    expect(jobBlock(ci, "ts")).not.toContain("OBSERVATION_BUDGET_MINUTES");
  });

  it("windows-task-dispatch promote fixture has a derivable list item (#4768 / #577)", () => {
    const windows = jobBlock(readText(".github/workflows/ci.yml"), "windows-task-dispatch");
    expect(windows).toContain("2026-04-22-scope-cli-args-windows-ci.xbrief.json");
    expect(windows).toContain("- promote proposed scope via relative Windows path (#577)");
    expect(windows).toContain(
      "scope:promote -- .\\xbrief\\proposed\\2026-04-22-scope-cli-args-windows-ci.xbrief.json",
    );
    const jsonMatch = /\$scopeJson = '(\{.*\})'/.exec(windows);
    expect(jsonMatch?.[1]).toBeTruthy();
    const fixture = JSON.parse(jsonMatch?.[1] ?? "") as {
      plan: { narratives?: { AcceptanceCriteria?: string }; items?: { title?: string }[] };
    };
    expect(fixture.plan.narratives?.AcceptanceCriteria).toMatch(/^- /);
    expect(fixture.plan.items?.[0]?.title).toMatch(/relative Windows path/);
  });

  it("TypeScript aggregator stays ungated by the artifact-only predicate", () => {
    const ci = readText(".github/workflows/ci.yml");
    const job = jobBlock(ci, "ts");
    expect(job).toContain("name: TypeScript (build + lint)");
    expect(job).toContain("if: always()");
    expect(job).not.toContain("artifact_only");
  });

  it("watchdog and arm do not treat skipped merge-gate as capacity death on artifact-only", () => {
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

describe("artifact-only lifecycle lane changelog entry paths (#6314)", () => {
  it("routes a changelog.d fragment beside a completed brief to the lane", () => {
    expect(
      artifactOnly(["changelog.d/6314-x.md", "xbrief/completed/2026-11-15-6314-x.xbrief.json"]),
    ).toBe(true);
  });

  it("keeps nested and upper-case fragment paths on the full stack", () => {
    expect(artifactOnly(["changelog.d/sub/x.md"])).toBe(false);
    expect(artifactOnly(["changelog.d/X.md"])).toBe(false);
    expect(artifactOnly(["changelog.d/6314-x.md", "packages/core/src/x.ts"])).toBe(false);
  });
});

const OVPR_SCRIPT = join(repoRoot(), ".github", "scripts", "ovpr-fixture-paths.mjs");

/** Run the OVPR fixture path filter (#6749) the way the `changes` job does. */
function ovprPaths(paths: string[]): boolean {
  const out = execFileSync(process.execPath, [OVPR_SCRIPT, "--stdin"], {
    encoding: "utf8",
    input: `${paths.join("\n")}\n`,
  }).trim();
  const match = /^ovpr_paths=(true|false)$/m.exec(out);
  if (!match?.[1]) {
    throw new Error(`unexpected path filter output: ${JSON.stringify(out)}`);
  }
  return match[1] === "true";
}

describe("OVPR fixture path filter (#6749)", () => {
  it("a docs-only change set gives ovpr_paths=false", () => {
    expect(ovprPaths(["docs/getting-started.md", "README.md", "content/coding/docs.md"])).toBe(
      false,
    );
  });

  it("a scope-code change set gives ovpr_paths=false", () => {
    expect(
      ovprPaths([
        "packages/core/src/scope/acceptance-evidence.ts",
        "packages/core/src/scope/acceptance-evidence.test.ts",
      ]),
    ).toBe(false);
  });

  it.each([
    ["launcher", "packages/cli/src/launcher.ts"],
    ["hook", "packages/core/src/hooks/classify/index.ts"],
    ["content staging", "packages/content/stage-pack.mjs"],
    ["runtime", "packages/runtime/scripts/stage-bundle.mjs"],
    ["deposit", "packages/core/src/deposit/x.ts"],
    ["install", "packages/core/src/install-health/x.ts"],
    ["toolchain", "pnpm-lock.yaml"],
  ])("a %s change gives ovpr_paths=true", (_label, path) => {
    expect(ovprPaths(["docs/x.md", path])).toBe(true);
  });

  it("an empty change set fails open to ovpr_paths=true", () => {
    expect(ovprPaths([])).toBe(true);
  });

  it("changes job exposes ovpr_paths and fails open on an unusable base or absent script", () => {
    const changes = jobBlock(readText(".github/workflows/ci.yml"), "changes");
    expect(changes).toContain("ovpr_paths: ${{ steps.ovpr.outputs.ovpr_paths }}");
    expect(changes).toContain('git show "${BASE}:${SCRIPT}"');
    expect(changes).toContain('SCRIPT=".github/scripts/ovpr-fixture-paths.mjs"');
    expect(changes).toContain('git diff --name-only --no-renames "${BASE}...${PR_HEAD_SHA}"');
    expect(changes).toMatch(
      /Unusable base or head; running the OVPR fixture"\n\s+echo "ovpr_paths=true"/,
    );
    expect(changes).toMatch(
      /Path filter absent on \$\{BASE\}; running the OVPR fixture"\n\s+echo "ovpr_paths=true"/,
    );
    expect(changes).toMatch(/Diff failed; running the OVPR fixture"\n\s+echo "ovpr_paths=true"/);
  });

  it("ubuntu fixture skips on a pull request only when ovpr_paths is exactly false", () => {
    const block = jobBlock(readText(".github/workflows/ci.yml"), "ovpr-fixture");
    expect(block).toContain(
      "if: always() && needs.changes.outputs.artifact_only != 'true' && (github.event_name != 'pull_request' || needs.changes.outputs.ovpr_paths != 'false')",
    );
    expect(block).toMatch(/needs:\s*\[changes/);
  });

  it("Windows fixture runs on push only", () => {
    const block = jobBlock(readText(".github/workflows/ci.yml"), "ovpr-fixture-windows");
    expect(block).toContain(
      "if: always() && github.event_name == 'push' && needs.changes.outputs.artifact_only != 'true'",
    );
    expect(block).toMatch(/needs:\s*\[changes/);
  });
});
