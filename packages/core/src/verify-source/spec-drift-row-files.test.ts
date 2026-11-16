/**
 * Per-story spec-drift row files and delivery-bound rewrite proof (#6335).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SPEC_IMPACT_KEY } from "../policy/spec-guard.js";
import { resolveBranchMergeBase } from "../scope/lands-with-product.js";
import {
  evaluateSpecDrift,
  findReusedRewriteEvidence,
  gateScopeCompleteSpecDrift,
  listInvalidSpecDriftRowFiles,
  readSpecDriftRowFiles,
  recordScopeCompleteDrift,
  requirementsFingerprint,
  resolveDeliveryRequirementsFingerprints,
  seedSpecDriftLedger,
  snapshotSpecDriftLedger,
  specDriftRowFileName,
  writeSpecDriftLedger,
  writeSpecDriftRowFile,
} from "./spec-drift.js";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, "add", "-A");
  git(
    cwd,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=.git/fixture-no-hooks",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  );
  return git(cwd, "rev-parse", "HEAD");
}

type Enforcement = "advise" | "shadow" | "enforce";

const LEDGER_REL = ["xbrief", ".audit", "spec-drift-ledger.json"] as const;

function rowFile(root: string, scopeId: string): string {
  return join(root, "xbrief", ".audit", "spec-drift", specDriftRowFileName(scopeId));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Shape-changing scope without specImpact: an advise finding. */
function uncoveredScope(id: string): Record<string, unknown> {
  return {
    plan: { id, title: "RFC: uncovered", tags: ["rfc"], items: [{ id: "i1", title: "t" }] },
  };
}

/** Scope declaring namespaced delta: no advise finding; needs rewrite proof under shadow/enforce. */
function deltaScope(id: string): Record<string, unknown> {
  return {
    plan: {
      id,
      title: "RFC: delta",
      tags: ["rfc"],
      items: [{ id: "i1", title: "t", [SPEC_IMPACT_KEY]: "delta" }],
    },
  };
}

describe("spec-drift row files (#6335)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function writePolicy(enforcement: Enforcement): void {
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "p",
          status: "proposed",
          "x-directive/policy": {
            specGuard: { enabled: true, driftGuard: { enforcement, trigger: "both" } },
          },
        },
      }),
    );
  }

  function writeSpec(items: unknown[], updated = "2026-10-01T00:00:00Z"): void {
    writeFileSync(
      join(root, "xbrief", "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", updated },
        plan: { title: "spec", status: "proposed", items },
      }),
    );
  }

  function setup(enforcement: Enforcement = "advise"): string {
    root = mkdtempSync(join(tmpdir(), "spec-drift-rows-"));
    mkdirSync(join(root, "xbrief", ".audit"), { recursive: true });
    writePolicy(enforcement);
    writeSpec([]);
    return root;
  }

  function ledgerBytes(): Buffer {
    return readFileSync(join(root, ...LEDGER_REL));
  }

  function seedWithLegacyRow(scopeId: string): void {
    expect(seedSpecDriftLedger(root).ok).toBe(true);
    const header = snapshotSpecDriftLedger(root);
    writeSpecDriftLedger(root, {
      ...header,
      unresolved: [
        {
          scopeId,
          reason: "legacy finding",
          specImpact: null,
          completedAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
  }

  it("two completions from the same tip both merge with no conflict and keep both rows", () => {
    setup("advise");
    seedWithLegacyRow("legacy-scope");
    git(root, "init", "-q", "-b", "master");
    commitAll(root, "base");
    const before = ledgerBytes();

    git(root, "checkout", "-q", "-b", "complete-a");
    expect(recordScopeCompleteDrift(root, uncoveredScope("story-a"), "a.json")).not.toBeNull();
    commitAll(root, "complete a");

    git(root, "checkout", "-q", "master");
    git(root, "checkout", "-q", "-b", "complete-b");
    expect(recordScopeCompleteDrift(root, uncoveredScope("story-b"), "b.json")).not.toBeNull();
    commitAll(root, "complete b");

    git(root, "checkout", "-q", "master");
    git(root, "merge", "-q", "--no-ff", "--no-edit", "complete-a");
    // The second completion merges cleanly after the first (no conflict in xbrief/.audit/).
    git(root, "merge", "-q", "--no-ff", "--no-edit", "complete-b");
    expect(git(root, "status", "--porcelain")).toBe("");

    expect(ledgerBytes()).toEqual(before);
    expect(readSpecDriftRowFiles(root).map((r) => r.scopeId)).toEqual(["story-a", "story-b"]);
    const result = evaluateSpecDrift(root);
    expect(result.findings.map((f) => f.scopeId).sort()).toEqual([
      "legacy-scope",
      "story-a",
      "story-b",
    ]);
  });

  it("a completion with a finding writes its row file and leaves the ledger unchanged", () => {
    setup("advise");
    expect(seedSpecDriftLedger(root).ok).toBe(true);
    const before = ledgerBytes();
    const finding = recordScopeCompleteDrift(root, uncoveredScope("story-1"), "s.json");
    expect(finding).not.toBeNull();
    expect(ledgerBytes()).toEqual(before);
    const row = readJson<{ scopeId: string; unresolved: Array<{ reason: string }> }>(
      rowFile(root, "story-1"),
    );
    expect(row.scopeId).toBe("story-1");
    expect(row.unresolved.map((f) => f.reason)).toEqual([finding?.reason]);
  });

  it("a retry overwrites the scope's row file", () => {
    setup("shadow");
    expect(seedSpecDriftLedger(root).ok).toBe(true);
    recordScopeCompleteDrift(root, deltaScope("story-r"), "r.json");
    const first = readJson<{ shadowFindings: unknown[] }>(rowFile(root, "story-r"));
    expect(first.shadowFindings).toHaveLength(1);
    // Retry: missing per-item impact gives a different finding; the file holds only it.
    recordScopeCompleteDrift(
      root,
      { plan: { id: "story-r", title: "RFC: r", tags: ["rfc"], items: [{ id: "i9" }] } },
      "r.json",
    );
    const second = readJson<{ shadowFindings: Array<{ reason: string }> }>(
      rowFile(root, "story-r"),
    );
    expect(second.shadowFindings).toHaveLength(1);
    expect(second.shadowFindings[0]?.reason).toMatch(/uncovered/);
  });

  it("a clean retry over a legacy unresolved row writes an empty row file that hides it", () => {
    setup("advise");
    seedWithLegacyRow("story-legacy");
    expect(evaluateSpecDrift(root).findings.map((f) => f.scopeId)).toEqual(["story-legacy"]);
    const before = ledgerBytes();
    const cleared = recordScopeCompleteDrift(root, deltaScope("story-legacy"), "l.json");
    expect(cleared).toBeNull();
    const row = readJson<{ unresolved: unknown[]; coverage: unknown[]; shadowFindings: unknown[] }>(
      rowFile(root, "story-legacy"),
    );
    expect(row).toMatchObject({ unresolved: [], coverage: [], shadowFindings: [] });
    expect(ledgerBytes()).toEqual(before);
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("a completion with nothing to record and no earlier record writes no row file", () => {
    setup("advise");
    expect(seedSpecDriftLedger(root).ok).toBe(true);
    expect(recordScopeCompleteDrift(root, deltaScope("story-none"), "n.json")).toBeNull();
    expect(existsSync(rowFile(root, "story-none"))).toBe(false);
    setup("shadow");
    expect(seedSpecDriftLedger(root).ok).toBe(true);
    const noItems = { plan: { id: "story-plain", title: "plain fix", items: [] } };
    expect(recordScopeCompleteDrift(root, noItems, "p.json")).toBeNull();
    expect(existsSync(rowFile(root, "story-plain"))).toBe(false);
  });

  it("a ledger with rows and no row files gives today's result", () => {
    setup("advise");
    seedWithLegacyRow("legacy-1");
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(1);
    expect(result.state).toBe("drift");
    expect(result.message).toBe(
      "verify:spec-drift: 1 unresolved completion(s) lack requirements/delta coverage",
    );
    expect(result.findings.map((f) => f.scopeId)).toEqual(["legacy-1"]);
  });

  it("row files without a header are judged against the live baseline", () => {
    setup("advise");
    expect(recordScopeCompleteDrift(root, uncoveredScope("headerless"), "h.json")).not.toBeNull();
    expect(existsSync(join(root, ...LEDGER_REL))).toBe(false);
    expect(evaluateSpecDrift(root).code).toBe(1);
    recordScopeCompleteDrift(root, deltaScope("headerless"), "h.json");
    expect(evaluateSpecDrift(root).code).toBe(0);
  });

  it("verify:spec-drift reports reused evidence across two row files", () => {
    setup("advise");
    expect(seedSpecDriftLedger(root).ok).toBe(true);
    const cov = (scopeId: string, recordedAt: string) => ({
      scopeId,
      coveredItemIds: ["i1"],
      beforeRequirementsFingerprint: "aaa",
      afterRequirementsFingerprint: "bbb",
      affectedRequirementRefs: [],
      recordedAt,
      source: "rewrite" as const,
    });
    writeSpecDriftRowFile(root, {
      scopeId: "first",
      unresolved: [],
      coverage: [cov("first", "2026-10-01T00:00:00Z")],
      shadowFindings: [],
    });
    expect(evaluateSpecDrift(root).code).toBe(0);
    writeSpecDriftRowFile(root, {
      scopeId: "second",
      unresolved: [],
      coverage: [cov("second", "2026-10-02T00:00:00Z")],
      shadowFindings: [],
    });
    const result = evaluateSpecDrift(root);
    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.scopeId).toBe("second");
    expect(result.findings[0]?.reason).toMatch(/reused-evidence/);
    expect(findReusedRewriteEvidence([cov("x", "t"), cov("x", "t")])).toEqual([]);
    expect(
      findReusedRewriteEvidence([cov("a", "t"), { ...cov("b", "t"), source: "override" as const }]),
    ).toEqual([]);
  });

  it("reports an unreadable row file as unassessable, never as absent", () => {
    setup("advise");
    expect(seedSpecDriftLedger(root).ok).toBe(true);
    expect(evaluateSpecDrift(root).code).toBe(0);
    const dir = join(root, "xbrief", ".audit", "spec-drift");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "story-x.json"), "{not json\n");
    const advise = evaluateSpecDrift(root);
    expect(advise.code).toBe(2);
    expect(advise.state).toBe("unassessable");
    expect(advise.message).toContain("story-x.json");
    expect(listInvalidSpecDriftRowFiles(root)).toEqual(["story-x.json"]);
    writePolicy("shadow");
    const shadow = evaluateSpecDrift(root);
    expect(shadow.code).toBe(0);
    expect(shadow.state).toBe("unassessable");
    expect(shadow.message).toMatch(/shadow warning/);
  });

  it("merges only valid row files and keeps legacy shadow rows of other scopes", () => {
    setup("advise");
    expect(seedSpecDriftLedger(root).ok).toBe(true);
    const header = snapshotSpecDriftLedger(root);
    writeSpecDriftLedger(root, {
      ...header,
      shadowFindings: [
        { scopeId: "legacy-shadow", reason: "s", specImpact: null, completedAt: null },
      ],
    });
    const dir = join(root, "xbrief", ".audit", "spec-drift");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "array.json"), "[]\n");
    writeFileSync(join(dir, "no-scope.json"), '{"unresolved":[]}\n');
    writeFileSync(join(dir, "broken.json"), "{not json\n");
    writeFileSync(join(dir, "readme.txt"), "ignored\n");
    writeFileSync(
      join(dir, "mixed.json"),
      JSON.stringify({
        scopeId: "mixed",
        unresolved: [
          { scopeId: "mixed", reason: "own" },
          { scopeId: "someone-else", reason: "foreign" },
        ],
      }),
    );
    expect(readSpecDriftRowFiles(root).map((r) => r.scopeId)).toEqual(["mixed"]);
    const view = snapshotSpecDriftLedger(root);
    expect(view.unresolved.map((f) => f.reason)).toEqual(["own"]);
    expect(view.shadowFindings.map((f) => f.scopeId)).toEqual(["legacy-shadow"]);
  });

  describe("delivery-bound rewrite proof", () => {
    function specAt(commit: string): string | null {
      const shown = git(root, "show", `${commit}:./xbrief/specification.xbrief.json`);
      return requirementsFingerprint(JSON.parse(shown) as Record<string, unknown>);
    }

    it("story A merged without a spec change fails even after story B changed the spec", () => {
      setup("enforce");
      expect(seedSpecDriftLedger(root).ok).toBe(true);
      git(root, "init", "-q", "-b", "master");
      commitAll(root, "base");
      writeFileSync(join(root, "a.txt"), "story A product\n");
      const mergeA = commitAll(root, "story A (no spec change)");
      writeSpec([{ id: "req-b", title: "B requirement" }], "2026-10-05T00:00:00Z");
      commitAll(root, "story B (spec change)");
      const gate = gateScopeCompleteSpecDrift(root, deltaScope("story-a"), "a.json", {
        delivery: { baseCommit: `${mergeA}^1`, deliveryCommit: mergeA },
      });
      expect(gate.ok).toBe(false);
      expect(gate.message).toMatch(/unchanged/);
    });

    it("a delta completion's in-PR proof uses its own merge base and head", () => {
      setup("enforce");
      expect(seedSpecDriftLedger(root).ok).toBe(true);
      git(root, "init", "-q", "-b", "master");
      const branchPoint = commitAll(root, "base");
      git(root, "checkout", "-q", "-b", "delta");
      writeSpec([{ id: "req-d", title: "delta requirement" }], "2026-10-06T00:00:00Z");
      const head = commitAll(root, "delta rewrites spec");
      git(root, "checkout", "-q", "master");
      // A `none` completion merges between the branch point and the delta merge.
      expect(recordScopeCompleteDrift(root, uncoveredScope("none-story"), "n.json")).not.toBeNull();
      commitAll(root, "none completion");
      git(root, "checkout", "-q", "delta");
      const mergeBase = resolveBranchMergeBase(root, { baseRef: "master" });
      expect(mergeBase).toBe(branchPoint);
      const delivery = { baseCommit: mergeBase, deliveryCommit: "HEAD" };
      const fps = resolveDeliveryRequirementsFingerprints(root, delivery);
      expect(fps).toEqual({ before: specAt(branchPoint), after: specAt(head) });
      expect(fps.before).not.toBe(fps.after);
      const gate = gateScopeCompleteSpecDrift(root, deltaScope("delta-story"), "d.json", {
        delivery,
      });
      expect(gate.ok).toBe(true);
      const recorded = recordScopeCompleteDrift(root, deltaScope("delta-story"), "d.json", {
        delivery: () => delivery,
      });
      expect(recorded).toBeNull();
      const row = readJson<{
        coverage: Array<{
          beforeRequirementsFingerprint: string;
          afterRequirementsFingerprint: string;
        }>;
      }>(rowFile(root, "delta-story"));
      expect(row.coverage).toHaveLength(1);
      expect(row.coverage[0]?.beforeRequirementsFingerprint).toBe(fps.before);
      expect(row.coverage[0]?.afterRequirementsFingerprint).toBe(fps.after);
      // A second scope claiming the same delivery pair fails as reused evidence.
      const reused = gateScopeCompleteSpecDrift(root, deltaScope("copycat"), "c.json", {
        delivery,
      });
      expect(reused.ok).toBe(false);
      expect(reused.message).toMatch(/reused-evidence/);
    });

    it("ignores a stored last fingerprint and the live spec; writes no fingerprint", () => {
      setup("enforce");
      git(root, "init", "-q", "-b", "master");
      const base = commitAll(root, "base");
      expect(seedSpecDriftLedger(root).ok).toBe(true);
      expect(snapshotSpecDriftLedger(root).lastRequirementsFingerprint).toBeNull();
      // Stored fingerprint differs from everything; live spec differs from the delivery.
      writeSpecDriftLedger(root, {
        ...snapshotSpecDriftLedger(root),
        lastRequirementsFingerprint: "stale",
      });
      writeSpec([{ id: "live-only", title: "uncommitted" }], "2026-10-07T00:00:00Z");
      const before = ledgerBytes();
      const gate = gateScopeCompleteSpecDrift(root, deltaScope("same"), "s.json", {
        delivery: { baseCommit: base, deliveryCommit: base },
      });
      expect(gate.ok).toBe(false);
      expect(gate.message).toMatch(/unchanged/);
      recordScopeCompleteDrift(root, deltaScope("same"), "s.json", {
        delivery: { baseCommit: base, deliveryCommit: base },
      });
      expect(ledgerBytes()).toEqual(before);
      expect(readJson<{ unresolved: unknown[] }>(rowFile(root, "same")).unresolved).toHaveLength(1);
    });

    it("an unresolvable product merge commit gives an unassessable proof", () => {
      setup("enforce");
      git(root, "init", "-q", "-b", "master");
      commitAll(root, "base");
      expect(seedSpecDriftLedger(root).ok).toBe(true);
      const missing = "0123456789abcdef0123456789abcdef01234567";
      expect(
        resolveDeliveryRequirementsFingerprints(root, {
          baseCommit: `${missing}^1`,
          deliveryCommit: missing,
        }),
      ).toEqual({ before: null, after: null });
      const gate = gateScopeCompleteSpecDrift(root, deltaScope("lost"), "l.json", {
        delivery: { baseCommit: `${missing}^1`, deliveryCommit: missing },
      });
      expect(gate.ok).toBe(false);
      expect(gate.message).toMatch(/unassessable/);
      expect(
        resolveDeliveryRequirementsFingerprints(root, { baseCommit: null, deliveryCommit: null }),
      ).toEqual({ before: null, after: null });
      expect(
        resolveDeliveryRequirementsFingerprints(root, () => {
          throw new Error("boom");
        }),
      ).toEqual({ before: null, after: null });
    });
  });
});
