import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateLiveProcedureTargets,
  extraDepositMarkdownFiles,
} from "../deposit/live-procedure-targets.js";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import { resolveCapacityAllocation, validateCapacityAllocation } from "./capacity-policy.js";
import { computeReport, renderReport } from "./capacity-show.js";
import { isDatePrefixedVbriefFilename } from "./filename.js";
import { extractLinkTargets, shouldSkipLinkTarget } from "./link-parser.js";
import {
  collectBrokenLinks,
  evaluate as evaluateLinks,
  resolveC3EvaluationRoot,
} from "./validate-links.js";
import {
  evaluate as evaluateStrategy,
  validateStrategyOutput,
} from "./validate-strategy-output.js";
import { evaluate as evaluateCapacity } from "./verify-capacity.js";

const NOW = new Date("2026-06-04T12:00:00Z");
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-vc-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("link-parser", () => {
  it("extracts targets linearly", () => {
    expect(extractLinkTargets("See [a](b.md) and [c](d.md)")).toEqual(["b.md", "d.md"]);
  });

  it("skips template and example targets", () => {
    expect(shouldSkipLinkTarget("{var}")).toBe(true);
    expect(shouldSkipLinkTarget("./relative-x")).toBe(true);
    expect(shouldSkipLinkTarget("path")).toBe(true);
    expect(shouldSkipLinkTarget("ok.md")).toBe(false);
  });
});

describe("filename convention", () => {
  it("accepts date-prefixed names", () => {
    expect(isDatePrefixedVbriefFilename("2026-05-26-foo-bar.xbrief.json")).toBe(true);
    expect(isDatePrefixedVbriefFilename("scaffold.xbrief.json")).toBe(false);
  });
});

describe("validate-links", () => {
  it("passes when links resolve", () => {
    const root = tempRoot();
    writeFileSync(join(root, "README.md"), "See [guide](guide.md)\n");
    writeFileSync(join(root, "guide.md"), "#\n");
    const result = evaluateLinks({ cwd: root });
    expect(result.code).toBe(0);
    expect(result.message).toContain("All internal markdown links valid");
  });

  it("fails closed when C3 finds a pruned helper on a live procedure (non-vacuous)", () => {
    const root = tempRoot();
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(
      join(root, "skills", "demo", "SKILL.md"),
      "! run `scripts/missing.py` and `.deft/core/run bootstrap`\n",
      "utf8",
    );
    const result = evaluateLinks({ cwd: root });
    expect(result.code).toBe(1);
    expect(result.message).toContain("unique live-invalid helper target");
    expect(result.message).toContain("scripts/missing.py");
  });

  it("warns on broken links by default", () => {
    const root = tempRoot();
    writeFileSync(join(root, "README.md"), "See [missing](nope.md)\n");
    const result = evaluateLinks({ cwd: root, linkCheckStrict: false });
    expect(result.code).toBe(0);
    expect(result.message).toContain("warnings");
  });

  it("errors in strict mode", () => {
    const root = tempRoot();
    writeFileSync(join(root, "doc.md"), "See [nope](nope.md).\n");
    const result = evaluateLinks({ cwd: root, strict: true });
    expect(result.code).toBe(1);
    expect(result.message).toContain("errors");
  });

  it("skips external and anchor links", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "README.md"),
      "See [Google](https://google.com) and [anchor](#section).\n",
    );
    expect(evaluateLinks({ cwd: root }).code).toBe(0);
  });

  it("excludes archive paths", () => {
    const root = tempRoot();
    const archive = join(root, "history", "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "old.md"), "See [gone](deleted.md).\n");
    expect(evaluateLinks({ cwd: root, strict: true }).code).toBe(0);
  });

  it("excludes .deft-scratch worktrees from link walks (#2953)", () => {
    const root = tempRoot();
    writeFileSync(join(root, "README.md"), "ok\n");
    const scratch = join(root, ".deft-scratch", "worktrees", "story-1");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "broken.md"), "See [gone](missing.md).\n");
    // Broken links under scratch must not fail or warn — tree is not scanned.
    expect(evaluateLinks({ cwd: root, strict: true }).code).toBe(0);
    expect(evaluateLinks({ cwd: root, strict: true }).message).toContain(
      "All internal markdown links valid",
    );
  });
});

describe("validate-links C3 consumer root (#4081)", () => {
  const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

  function packDeposit(dest: string): void {
    const copies: readonly [string, string][] = [
      ["content/UPGRADING.md", "UPGRADING.md"],
      ["content/scm/github.md", "scm/github.md"],
      ["content/docs/BROWNFIELD.md", "docs/BROWNFIELD.md"],
      ["content/skills/deft-directive-setup/SKILL.md", "skills/deft-directive-setup/SKILL.md"],
      ["main.md", "main.md"],
      ["SKILL.md", "SKILL.md"],
    ];
    for (const [src, rel] of copies) {
      const from = join(repoRoot, src);
      if (!existsSync(from)) continue;
      const to = join(dest, rel);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
    }
    mkdirSync(join(dest, "skills", "demo"), { recursive: true });
    writeFileSync(join(dest, "skills", "demo", "SKILL.md"), "# Demo\nLive procedure.\n", "utf8");
  }

  function initializedConsumer(opts?: {
    readonly dirtyDeposit?: boolean;
    readonly contentDir?: boolean;
    readonly npmContentPackage?: boolean;
  }): { cwd: string; deposit: string } {
    const cwd = tempRoot();
    const deposit = join(cwd, CANONICAL_INSTALL_ROOT);
    mkdirSync(deposit, { recursive: true });
    packDeposit(deposit);
    writeFileSync(join(cwd, "package.json"), '{"name":"consumer"}\n', "utf8");
    writeFileSync(join(cwd, "README.md"), "App entry is `path/to.py`.\n", "utf8");
    if (opts?.dirtyDeposit) {
      writeFileSync(
        join(deposit, "skills", "demo", "SKILL.md"),
        "! run `scripts/definitely_missing.py`\n",
        "utf8",
      );
    }
    if (opts?.contentDir) {
      mkdirSync(join(cwd, "content", "blog"), { recursive: true });
      writeFileSync(join(cwd, "content", "blog", "hello.md"), "`scripts/seed.py`\n", "utf8");
    }
    if (opts?.npmContentPackage) {
      const pkg = join(cwd, "node_modules", "@deftai", "directive-content");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), '{"name":"@deftai/directive-content"}\n', "utf8");
      writeFileSync(join(pkg, "README.md"), "clean package copy\n", "utf8");
    }
    return { cwd, deposit };
  }

  it("evaluates a packed consumer deposit in deposit-relative coordinates", () => {
    const { cwd, deposit } = initializedConsumer();
    const resolved = resolveC3EvaluationRoot(cwd);
    expect(resolved.stagedRoot).toBe(resolve(deposit));
    expect(resolved.extraFiles.map((f) => f.relativePath).sort()).toEqual(
      extraDepositMarkdownFiles(deposit)
        .map((f) => f.relativePath)
        .sort(),
    );
    const fromConsumer = evaluateLiveProcedureTargets(resolved);
    const fromDeposit = evaluateLiveProcedureTargets({
      stagedRoot: deposit,
      extraFiles: extraDepositMarkdownFiles(deposit),
    });
    expect(fromConsumer.uniqueTargets, "consumer-root C3").toEqual([]);
    expect(fromDeposit.uniqueTargets, "deposit-root C3").toEqual([]);
    expect(evaluateLinks({ cwd }).code).toBe(0);
    expect(evaluateLinks({ cwd: deposit }).code).toBe(0);
  });

  it("does not walk consumer-authored path/to.py mentions (recut AC5)", () => {
    const { cwd } = initializedConsumer();
    const c3 = evaluateLiveProcedureTargets(resolveC3EvaluationRoot(cwd));
    expect(c3.uniqueTargets).toEqual([]);
    expect(c3.hits.map((h) => h.file)).not.toContain("README.md");
    expect(c3.uniqueTargets).not.toContain("path/to.py");
    expect(evaluateLinks({ cwd }).code).toBe(0);
  });

  it("keeps declared exclusions excluded from both consumer and deposit roots", () => {
    const { cwd, deposit } = initializedConsumer();
    const consumerHits = evaluateLiveProcedureTargets(resolveC3EvaluationRoot(cwd)).hits.map(
      (h) => h.file,
    );
    const depositHits = evaluateLiveProcedureTargets({
      stagedRoot: deposit,
      extraFiles: extraDepositMarkdownFiles(deposit),
    }).hits.map((h) => h.file);
    expect(consumerHits).not.toContain("UPGRADING.md");
    expect(consumerHits).not.toContain(".deft/core/UPGRADING.md");
    expect(depositHits).not.toContain("UPGRADING.md");
  });

  it("fails C3 when the missing helper is planted in the deposit, not the consumer tree (recut AC4)", () => {
    const dirty = initializedConsumer({ dirtyDeposit: true });
    const consumerDirty = evaluateLinks({ cwd: dirty.cwd });
    const depositDirty = evaluateLinks({ cwd: dirty.deposit });
    expect(consumerDirty.code).toBe(1);
    expect(depositDirty.code).toBe(1);
    expect(consumerDirty.message).toContain("scripts/definitely_missing.py");
    expect(consumerDirty.message).toContain("skills/demo/SKILL.md");
    expect(consumerDirty.message).not.toContain(".deft/core/skills/demo/SKILL.md");
    expect(consumerDirty.message).not.toContain("path/to.py");

    const clean = initializedConsumer();
    mkdirSync(join(clean.cwd, "docs"), { recursive: true });
    writeFileSync(join(clean.cwd, "docs", "deploy.md"), "`scripts/mytool.py`\n", "utf8");
    const consumerPlant = evaluateLinks({ cwd: clean.cwd });
    expect(consumerPlant.code).toBe(0);
    expect(consumerPlant.message).not.toContain("scripts/mytool.py");
  });

  it("does not fail-open a dirty deposit when the consumer owns content/", () => {
    const { cwd } = initializedConsumer({ dirtyDeposit: true, contentDir: true });
    const result = evaluateLinks({ cwd });
    expect(result.code).toBe(1);
    expect(result.message).toContain("scripts/definitely_missing.py");
    expect(result.message).not.toContain("scripts/seed.py");
    expect(result.message).not.toContain("content/blog/hello.md");
  });

  it("does not substitute contentRoot(cwd) npm package for the initialized deposit", () => {
    const { cwd, deposit } = initializedConsumer({
      dirtyDeposit: true,
      npmContentPackage: true,
    });
    expect(resolveC3EvaluationRoot(cwd).stagedRoot).toBe(resolve(deposit));
    const result = evaluateLinks({ cwd });
    expect(result.code).toBe(1);
    expect(result.message).toContain("scripts/definitely_missing.py");
  });

  it("binds C3 extras to the deposit, not consumer-root main.md", () => {
    const { cwd } = initializedConsumer();
    writeFileSync(join(cwd, "main.md"), "! run `scripts/injected.py`\n", "utf8");
    const result = evaluateLinks({ cwd });
    expect(result.code).toBe(0);
    expect(result.message).not.toContain("scripts/injected.py");
  });

  it("probes framework source before a nested deposit", () => {
    const root = resolveC3EvaluationRoot(repoRoot);
    expect(root.stagedRoot).toBe(resolve(repoRoot, "content"));
  });

  it("evaluates a legacy deft/ consumer deposit", () => {
    const cwd = tempRoot();
    const deposit = join(cwd, "deft");
    mkdirSync(deposit, { recursive: true });
    packDeposit(deposit);
    writeFileSync(join(cwd, "README.md"), "`path/to.py`\n", "utf8");
    expect(resolveC3EvaluationRoot(cwd).stagedRoot).toBe(resolve(deposit));
    expect(evaluateLiveProcedureTargets(resolveC3EvaluationRoot(cwd)).uniqueTargets).toEqual([]);
  });

  it("fails closed when the selected C3 root is not a directory", () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, "not-a-dir"), "x\n", "utf8");
    const result = evaluateLinks({ cwd: join(cwd, "not-a-dir") });
    expect(result.code).toBe(1);
    expect(result.message).toContain("deposit root is missing or not a directory");
  });

  it("still warns on consumer broken links separately from C3", () => {
    const { cwd } = initializedConsumer();
    writeFileSync(join(cwd, "README.md"), "See [missing](nope.md) and `path/to.py`.\n", "utf8");
    const c3 = evaluateLiveProcedureTargets(resolveC3EvaluationRoot(cwd));
    expect(c3.uniqueTargets).toEqual([]);
    const broken = collectBrokenLinks(cwd);
    expect(
      broken.some((b) => b.file.replaceAll("\\", "/") === "README.md" && b.target === "nope.md"),
    ).toBe(true);
    expect(evaluateLinks({ cwd, linkCheckStrict: false }).code).toBe(0);
  });
});

describe("validate-strategy-output", () => {
  it("passes conformant tree", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}");
    writeFileSync(join(root, "xbrief", "proposed", "2026-05-26-good.xbrief.json"), "{}");
    expect(validateStrategyOutput(root)).toEqual([]);
    const result = evaluateStrategy({ projectRoot: root });
    expect(result.code).toBe(0);
    expect(result.message).toContain("conforms");
  });

  it("flags missing project definition", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    writeFileSync(join(root, "xbrief", "proposed", "2026-05-26-good.xbrief.json"), "{}");
    const errors = validateStrategyOutput(root);
    expect(errors.some((e) => e.includes("PROJECT-DEFINITION"))).toBe(true);
  });

  it("flags non-date-prefixed filenames", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}");
    writeFileSync(join(root, "xbrief", "proposed", "scaffold.xbrief.json"), "{}");
    const errors = validateStrategyOutput(root);
    expect(errors.some((e) => e.includes("scaffold.xbrief.json"))).toBe(true);
  });

  it("forbids legacy spec in user projects", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", "specification.vbrief.json"), "{}");
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}");
    writeFileSync(join(root, "xbrief", "proposed", "2026-05-26-good.xbrief.json"), "{}");
    expect(validateStrategyOutput(root).some((e) => e.includes("Legacy artifact"))).toBe(true);
  });

  it("tolerates framework root heuristic", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "strategies"));
    writeFileSync(join(root, "AGENTS.md"), "#");
    writeFileSync(join(root, "Taskfile.yml"), "version: '3'");
    writeFileSync(join(root, "xbrief", "specification.xbrief.json"), "{}");
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}");
    writeFileSync(join(root, "xbrief", "proposed", "2026-05-26-good.xbrief.json"), "{}");
    expect(validateStrategyOutput(root)).toEqual([]);
  });

  it("strict mode flags missing vbrief dir", () => {
    const root = tempRoot();
    const result = evaluateStrategy({ projectRoot: root, strict: true });
    expect(result.code).toBe(1);
    expect(result.message).toContain("xbrief/ directory missing entirely");
  });

  it("non-strict mode passes silently when xbrief/ layout missing", () => {
    const root = tempRoot();
    // No xbrief/ layout — resolveLifecycleLayout throws; non-strict should return no errors
    const errors = validateStrategyOutput(root, false);
    expect(errors).toEqual([]);
  });

  it("quiet mode suppresses success output", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}");
    writeFileSync(join(root, "xbrief", "proposed", "2026-05-26-good.xbrief.json"), "{}");
    const result = evaluateStrategy({ projectRoot: root, quiet: true });
    expect(result.code).toBe(0);
    expect(result.stream).toBe("none");
  });
});

describe("verify-capacity", () => {
  function writeProject(root: string, capacity: Record<string, unknown> | null): void {
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    const plan: Record<string, unknown> = { title: "T", status: "running", items: [] };
    if (capacity) plan.policy = { capacityAllocation: capacity };
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }),
    );
  }

  it("exits 2 for invalid project root", () => {
    const root = tempRoot();
    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    const result = evaluateCapacity({ projectRoot: file });
    expect(result.code).toBe(2);
    expect(result.message).toContain("not a directory");
  });

  it("advise posture always exits 0", () => {
    const root = tempRoot();
    writeProject(root, {
      unit: "vbrief-count",
      window: 30,
      enforcement: "advise",
      minSampleSize: 2,
      defaultBucket: "feature",
      buckets: [
        { id: "debt", target: 0.4 },
        { id: "feature", target: 0.6 },
      ],
    });
    const completedAt = "2026-06-03T12:00:00Z";
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(
        join(root, "xbrief", "completed", `f-${i}.xbrief.json`),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: `f-${i}`,
            status: "completed",
            items: [],
            metadata: { capacityBucket: "feature", completedAt },
          },
        }),
      );
    }
    const result = evaluateCapacity({ projectRoot: root, now: NOW });
    expect(result.code).toBe(0);
    expect(result.message).toContain("advisory posture");
  });

  it("enforce posture exits 1 on deficit", () => {
    const root = tempRoot();
    writeProject(root, {
      unit: "vbrief-count",
      window: 30,
      enforcement: "enforce",
      minSampleSize: 2,
      defaultBucket: "feature",
      buckets: [
        { id: "debt", target: 0.4 },
        { id: "feature", target: 0.6 },
      ],
    });
    const completedAt = "2026-06-03T12:00:00Z";
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(
        join(root, "xbrief", "completed", `f-${i}.xbrief.json`),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: `f-${i}`,
            status: "completed",
            items: [],
            metadata: { capacityBucket: "feature", completedAt },
          },
        }),
      );
    }
    const result = evaluateCapacity({ projectRoot: root, now: NOW });
    expect(result.code).toBe(1);
    expect(result.message).toContain("DEFICIT");
  });

  it("unconfigured policy exits 0", () => {
    const root = tempRoot();
    writeProject(root, null);
    expect(evaluateCapacity({ projectRoot: root, now: NOW }).code).toBe(0);
  });
});

describe("capacity-policy validation", () => {
  it("rejects malformed allocation blocks", () => {
    expect(validateCapacityAllocation({ window: "bad" }).length).toBeGreaterThan(0);
    expect(validateCapacityAllocation([]).length).toBeGreaterThan(0);
  });

  it("resolves default when missing", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { status: "running" } }),
    );
    const allocation = resolveCapacityAllocation(root);
    expect(allocation.source).toBe("default");
    expect(allocation.configured).toBe(false);
  });
});

describe("capacity-show rendering", () => {
  it("renders advisory banner when unconfigured", () => {
    const root = tempRoot();
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { status: "running", items: [] } }),
    );
    const report = computeReport(root, { now: NOW });
    const text = renderReport(report);
    expect(text).toContain("Capacity allocation");
    expect(text).toContain("no buckets configured");
  });
});
