import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readText, repoRoot } from "./_helpers.js";

/**
 * Wave 1 policy lock (#4316 / parent #4164). Invert of closed unmerged PR 4196.
 *
 * GitHub merge protection is the TypeScript aggregator, not FRAMEWORK_CHECK_GATES.
 * A later worker can recouple leftover-complete to ROADMAP without putting
 * roadmap:check on the Taskfile lists — this suite scan is that lock.
 * Fixture-level checkDrift against a temp outPath stays legal (AC 1).
 * Bound names: identifier alias of roadmapRenderMain, repoRoot() stored then
 * used with --check, and checkDrift against checkout ROADMAP.md via a local
 * path variable.
 */
const LOCK_BASENAME = "roadmap_merge_lane_lock.test.ts";
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identAlt(names: readonly string[]): string {
  return names.map(escapeRegExp).join("|");
}

function collectBindings(source: string, rhs: string): string[] {
  const names: string[] = [];
  const re = new RegExp(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*${rhs}`, "g");
  for (const m of source.matchAll(re)) {
    const name = m[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

function collectRoadmapRenderAliases(source: string): string[] {
  const names = collectBindings(source, String.raw`roadmapRenderMain\b`);
  if (!source.includes("roadmap-render")) {
    return names;
  }
  const importAs = new RegExp(String.raw`\bmain\s+as\s+(${IDENT})`, "g");
  for (const m of source.matchAll(importAs)) {
    const name = m[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

function collectVitestSuiteFiles(dir: string, acc: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist") {
      continue;
    }
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectVitestSuiteFiles(abs, acc);
      continue;
    }
    if (ent.name.endsWith(".test.ts")) {
      acc.push(abs);
    }
  }
}

function requiredVitestSuite(): string[] {
  const root = repoRoot();
  const packagesDir = join(root, "packages");
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) {
      continue;
    }
    const src = join(packagesDir, pkg.name, "src");
    try {
      collectVitestSuiteFiles(src, files);
    } catch {
      /* package has no src/ */
    }
  }
  return files.sort();
}

function liveCheckoutRoadmapHits(source: string, rel: string): string[] {
  const hits: string[] = [];
  const renderNames = ["roadmapRenderMain", ...collectRoadmapRenderAliases(source)];
  const rootNames = [
    "REPO_ROOT",
    ...collectBindings(source, String.raw`repoRoot\s*\(\s*\)`),
    ...collectBindings(source, String.raw`REPO_ROOT\b`),
  ];
  const renderAlt = identAlt(renderNames);
  const rootExpr = `(?:${identAlt(rootNames)}|repoRoot\\s*\\(\\s*\\))`;
  // 4196 exemplar: roadmapRenderMain(["--project-root", REPO_ROOT, "--check"])
  const liveMainCheck =
    new RegExp(String.raw`\b(?:${renderAlt})\s*\(\s*\[[^\]]*(?:${rootExpr})[^\]]*--check`).test(
      source,
    ) ||
    new RegExp(String.raw`\b(?:${renderAlt})\s*\(\s*\[[^\]]*--check[^\]]*(?:${rootExpr})`).test(
      source,
    );
  if (liveMainCheck) {
    hits.push(`${rel}: live-repo roadmapRenderMain --check`);
  }
  const checkoutJoin = new RegExp(
    String.raw`join\s*\(\s*(?:${rootExpr})\s*,\s*["']ROADMAP\.md["']`,
  );
  const pathVars = collectBindings(
    source,
    String.raw`join\s*\(\s*(?:${rootExpr})\s*,\s*["']ROADMAP\.md["']\s*\)`,
  );
  const usesCheckoutPathVar =
    pathVars.length > 0 &&
    new RegExp(String.raw`checkDrift\s*\([^;]*\b(?:${identAlt(pathVars)})\b`).test(source);
  if (/checkDrift\s*\(/.test(source) && (checkoutJoin.test(source) || usesCheckoutPathVar)) {
    hits.push(`${rel}: checkDrift against checkout ROADMAP.md`);
  }
  if (/\btask\s+roadmap:check\b/.test(source)) {
    hits.push(`${rel}: task roadmap:check from a test`);
  }
  if (/\b(?:execFileSync|execSync|spawnSync|spawn)\b[\s\S]{0,400}roadmap:check/.test(source)) {
    hits.push(`${rel}: spawned roadmap:check`);
  }
  return hits;
}

describe("ROADMAP merge-lane lock (#4316)", () => {
  it("still flags the 4196 exemplar and named equivalents", () => {
    expect(
      liveCheckoutRoadmapHits(
        'roadmapRenderMain(["--project-root", REPO_ROOT, "--check"])',
        "ex.ts",
      ),
    ).toEqual(["ex.ts: live-repo roadmapRenderMain --check"]);
    expect(
      liveCheckoutRoadmapHits(
        'const run = roadmapRenderMain;\nrun(["--project-root", REPO_ROOT, "--check"]);',
        "ex.ts",
      ),
    ).toEqual(["ex.ts: live-repo roadmapRenderMain --check"]);
    expect(
      liveCheckoutRoadmapHits(
        'import { main as run } from "./roadmap-render.js";\nrun(["--project-root", REPO_ROOT, "--check"]);',
        "ex.ts",
      ),
    ).toEqual(["ex.ts: live-repo roadmapRenderMain --check"]);
    expect(
      liveCheckoutRoadmapHits(
        'const root = repoRoot();\nroadmapRenderMain(["--project-root", root, "--check"]);',
        "ex.ts",
      ),
    ).toEqual(["ex.ts: live-repo roadmapRenderMain --check"]);
    expect(
      liveCheckoutRoadmapHits(
        'const root = repoRoot();\nconst path = join(root, "ROADMAP.md");\ncheckDrift(actual, path);',
        "ex.ts",
      ),
    ).toEqual(["ex.ts: checkDrift against checkout ROADMAP.md"]);
  });

  it("keeps fixture-level checkDrift against a temp outPath legal", () => {
    const src = [
      'const root = mkdtempSync(join(tmpdir(), "deft-roadmap-"));',
      'const outPath = join(root, "ROADMAP.md");',
      "checkDrift(pending, outPath);",
      'roadmapRenderMain(["--project-root", root, outPath, "--check"]);',
    ].join("\n");
    expect(liveCheckoutRoadmapHits(src, "ex.ts")).toEqual([]);
  });

  it("required vitest suite has no live-checkout ROADMAP freshness assertion", () => {
    const root = repoRoot();
    const hits: string[] = [];
    for (const abs of requiredVitestSuite()) {
      const rel = relative(root, abs).split("\\").join("/");
      if (rel.endsWith(LOCK_BASENAME)) {
        continue;
      }
      const source = readFileSync(abs, "utf8");
      hits.push(...liveCheckoutRoadmapHits(source, rel));
    }
    expect(hits).toEqual([]);
  });

  it("named producer files do not write or require ROADMAP.md", () => {
    const root = repoRoot();
    const files = [
      "packages/core/src/scope/transition.ts",
      "packages/core/src/swarm/finalize-cohort.ts",
      "packages/core/src/swarm/complete-cohort.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(join(root, rel), "utf8");
      expect(src, rel).not.toContain("syncRoadmapAfterCompletedSetChange");
      expect(src, rel).not.toContain("roadmap-render");
      expect(src, rel).not.toMatch(/ROADMAP\.md/);
      expect(src, rel).not.toContain("refreshRoadmapNative");
    }
  });

  it("refreshRoadmapNative remains the sole automatic ROADMAP producer", () => {
    const native = readFileSync(
      join(repoRoot(), "packages/core/src/release/native-steps.ts"),
      "utf8",
    );
    expect(native).toContain("export function refreshRoadmapNative");
    expect(native).toMatch(/renderRoadmap\(/);
    const renderer = readFileSync(
      join(repoRoot(), "packages/core/src/render/roadmap-render.ts"),
      "utf8",
    );
    expect(renderer).not.toContain("syncRoadmapAfterCompletedSetChange");
  });

  it("does not add verify:roadmap-policy", () => {
    const taskfile = readFileSync(join(repoRoot(), "Taskfile.yml"), "utf8");
    const gates = readFileSync(join(repoRoot(), "packages/core/src/check/gate-lists.ts"), "utf8");
    expect(taskfile).not.toContain("verify:roadmap-policy");
    expect(gates).not.toContain("verify:roadmap-policy");
  });

  it("issue-closing PR template does not ask for a ROADMAP.md edit", () => {
    const template = readText(".github/PULL_REQUEST_TEMPLATE.md");
    expect(template).not.toMatch(/updated if this closes a tracked issue/);
    expect(template).not.toMatch(/ROADMAP\.md[^\n]*leftover/i);
  });

  it("PR templates stop advising Closes #N for an active story (#6316)", () => {
    for (const rel of [
      ".github/PULL_REQUEST_TEMPLATE.md",
      "content/templates/PULL_REQUEST_TEMPLATE.md",
    ]) {
      const template = readFileSync(join(repoRoot(), rel), "utf8");
      expect(template).not.toMatch(/Use closing keywords so GitHub auto-closes/);
      expect(template).toContain("Active story");
      expect(template).toContain("do not use Closes #N");
      expect(template).toContain("deft-story: N");
      expect(template).toContain("deft-story-part: N");
      expect(template).toContain("--write-story-line");
    }
  });
});
