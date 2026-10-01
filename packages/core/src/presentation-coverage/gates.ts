/** Execute the closed required set using pinned candidate inputs. No synthetic
 * success records: absent adapter/results are unrun; exceptions are errors.
 * Policy parsing delegates to existing loaders in temporary snapshot dirs.
 * Class checks use base authority and compare candidate boundaries; the
 * independent test-boundary gate uses candidate policy, as its normal CLI does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateClassChecks,
  parseClassChecksFromProjectDefinition,
} from "../class-checks/evaluate.js";
import { loadClassChecksPolicy } from "../class-checks/policy.js";
import {
  evaluateConsumerCheckContract,
  resolveCanonicalDeftTaskfileInclude,
} from "../consumer-check-contract/evaluate.js";
import {
  DISPOSITION_REL,
  evaluate as evaluateSurface,
  isEvaluatorSurfacePath,
} from "../evaluator-surface/evaluate.js";
import { containedWrite } from "../fs/contained-write.js";
import { evaluateIntentConstraint } from "../intent-constraint/evaluate.js";
import { evaluateObservableScope } from "../observable-scope/evaluate.js";
import { isLifecycleXbriefPath } from "../scope-provenance/continuity.js";
import { parseApprovedScopeRecordRaw } from "../scope-provenance/evaluate.js";
import { evaluateTestBoundary } from "../test-boundary/evaluate.js";
import { loadTestBoundaryPolicy } from "../test-boundary/policy.js";
import { evaluateIsolatedScope } from "./isolated-scope.js";
import { type CoverageSnapshot, readTexts, type SnapshotTree } from "./snapshot.js";
import type { ComposedGateCoverage } from "./types.js";
/** Closed #5079 inventory. Consumer-required supplier/compositor gates are
 * independent peers, not recursive members of this composition. */
export const COMPOSED_GATE_IDS: readonly string[] = [
  "verify:test-boundary",
  "verify:class-checks",
  "verify:scope-provenance",
  "verify:consumer-check-contract",
  "verify:evaluator-surface",
  "verify:observable-scope",
  "verify:intent-constraint",
];
function policies(tree: SnapshotTree) {
  const dir = mkdtempSync(join(tmpdir(), "deft-ceiling-policy-"));
  try {
    for (const path of [
      ".deft/test-boundary.policy.json",
      ".deft/class-checks.policy.json",
      "xbrief/PROJECT-DEFINITION.xbrief.json",
    ]) {
      const text = tree.read(path);
      if (text === null) continue;
      // Validate even project-definition JSON, whose legacy loader defaults on parse failure.
      JSON.parse(text);
      containedWrite({ root: dir, target: path, data: text, mode: "create" });
    }
    const boundary = loadTestBoundaryPolicy(dir);
    let classes = loadClassChecksPolicy(dir);
    const pd = tree.read("xbrief/PROJECT-DEFINITION.xbrief.json");
    if (tree.read(".deft/class-checks.policy.json") === null && pd !== null) {
      const parsed = parseClassChecksFromProjectDefinition(pd, dir);
      if (!parsed.ok) classes = { error: parsed.message.replace(/^merge-base /, "") };
    }
    return { boundary, classes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function outcome(
  gateId: string,
  result: {
    code?: 0 | 1 | 2;
    exitCode?: 0 | 1 | 2;
    skipped?: boolean;
    message: string;
    analyzedPaths?: readonly string[];
  },
  paths: readonly string[],
  cannot: readonly string[] = [],
): ComposedGateCoverage {
  const code = result.code ?? result.exitCode ?? 2;
  return {
    gateId,
    code,
    status: result.skipped === true ? "skipped" : "evaluated",
    analyzedPaths: code === 0 && result.skipped !== true ? (result.analyzedPaths ?? paths) : [],
    cannotEvaluatePaths: cannot,
    message: result.message,
  };
}
export function runComposedGates(
  snapshot: CoverageSnapshot,
  planId?: string,
): ComposedGateCoverage[] {
  const { projectRoot, mergeBase, changed, base, head } = snapshot;
  const coverage: ComposedGateCoverage[] = [];
  const run = (id: string, call: () => ComposedGateCoverage) => {
    try {
      coverage.push(call());
    } catch (error) {
      coverage.push({
        gateId: id,
        code: 2,
        status: "evaluated",
        analyzedPaths: [],
        cannotEvaluatePaths: changed,
        message: `${id}: adapter failed: ${String(error)}`,
      });
    }
  };
  const common = {
    projectRoot,
    mergeBase,
    changedFiles: changed,
    readAtBase: base.read,
    readAtHead: head.read,
    planId,
    quiet: true,
  };
  run("verify:intent-constraint", () => {
    const r = evaluateIntentConstraint({
      ...common,
      recordTextsAtBase: readTexts(
        base,
        (p) => p.startsWith(".deft/intent-constraint/") && p.endsWith(".json"),
      ),
    });
    return outcome(
      "verify:intent-constraint",
      r,
      [],
      changed.filter((p) => !r.analyzedPaths?.includes(p)),
    );
  });
  run("verify:observable-scope", () => {
    const r = evaluateObservableScope({
      ...common,
      policyTextAtBase: base.read(".deft/observable-ui.policy.json"),
      recordTextsAtBase: readTexts(
        base,
        (p) => p.startsWith(".deft/observable-scope/") && p.endsWith(".json"),
      ),
    });
    const warned = (r.findings ?? [])
      .filter((f) => f.kind === "non-adoption")
      .flatMap((f) => (f.path ? [f.path] : []));
    return outcome(
      "verify:observable-scope",
      { ...r, analyzedPaths: (r.analyzedPaths ?? []).filter((p) => !warned.includes(p)) },
      [],
      [...new Set([...warned, ...changed.filter((p) => !r.analyzedPaths?.includes(p))])],
    );
  });
  run("verify:class-checks", () => {
    const b = policies(base),
      h = policies(head);
    if ("error" in b.classes)
      return outcome(
        "verify:class-checks",
        { code: 2, message: `base policy: ${b.classes.error}` },
        [],
      );
    if ("error" in h.classes)
      return outcome(
        "verify:class-checks",
        { code: 2, message: `head policy: ${h.classes.error}` },
        [],
      );
    const contents = readTexts(head, (p) => changed.includes(p));
    return outcome(
      "verify:class-checks",
      evaluateClassChecks(projectRoot, {
        baseRef: mergeBase,
        changedFiles: changed,
        fileContents: contents,
        baseTestBoundaryPolicy: b.boundary,
        headTestBoundaryPolicy: h.boundary,
        classChecksPolicy: b.classes,
      }),
      changed,
    );
  });
  run("verify:test-boundary", () => {
    const p = policies(head);
    return outcome(
      "verify:test-boundary",
      evaluateTestBoundary(projectRoot, {
        files: head.paths,
        fileContents: readTexts(head, () => true),
        policy: p.boundary,
        enforce: true,
      }),
      changed,
    );
  });
  run("verify:scope-provenance", () => {
    const p = policies(base);
    const approved = [
      ...readTexts(
        head,
        (p) =>
          p.startsWith(".deft/approved-scope/") &&
          p.endsWith(".json") &&
          !p.endsWith(".intent.json"),
      ).values(),
    ].map(parseApprovedScopeRecordRaw);
    const baseApproved = [
      ...readTexts(
        base,
        (p) =>
          p.startsWith(".deft/approved-scope/") &&
          p.endsWith(".json") &&
          !p.endsWith(".intent.json"),
      ).values(),
    ].map(parseApprovedScopeRecordRaw);
    if (approved.some((r) => r === null) || baseApproved.some((r) => r === null))
      return outcome(
        "verify:scope-provenance",
        { code: 2, message: "invalid approved-scope record in pinned snapshot" },
        [],
      );
    // Head: active/ plus changed completed/cancelled moves (not new pending/).
    // New pending briefs must not bind membership over an unrelated active
    // story's product paths. Base: full lifecycle census for continuity.
    const headXbriefs = readTexts(head, (p) => {
      if (!p.endsWith(".xbrief.json") && !p.endsWith(".vbrief.json")) return false;
      if (p.startsWith("xbrief/active/")) return true;
      if (
        (p.startsWith("xbrief/completed/") || p.startsWith("xbrief/cancelled/")) &&
        changed.includes(p)
      ) {
        return true;
      }
      return false;
    });
    const baseXbriefs = readTexts(base, (p) => isLifecycleXbriefPath(p));
    return outcome(
      "verify:scope-provenance",
      evaluateIsolatedScope(snapshot, {
        baseRef: mergeBase,
        changedFiles: changed,
        activeXbriefs: headXbriefs,
        baseXbriefs,
        approvedRecords: approved.filter((r) => r !== null),
        baseApprovedRecords: new Map(
          baseApproved.filter((r) => r !== null).map((r) => [r.planId, r]),
        ),
        readAtBase: base.read,
        testRoots: p.boundary.testRoots,
        fixtureRoots: p.boundary.fixtureRoots,
        sourceRoots: p.boundary.sourceRoots,
      }),
      changed,
    );
  });
  run("verify:evaluator-surface", () => {
    // Preserve renewal requirement when injecting immutable disposition bytes.
    const disposition = changed.includes(DISPOSITION_REL) ? head.read(DISPOSITION_REL) : null;
    const r = evaluateSurface({
      projectRoot,
      baseRef: mergeBase,
      paths: changed,
      dispositionText: disposition,
    });
    return outcome("verify:evaluator-surface", r, changed.filter(isEvaluatorSurfacePath));
  });
  run("verify:consumer-check-contract", () => {
    const rootText = head.read("Taskfile.yml"),
      include = rootText === null ? null : resolveCanonicalDeftTaskfileInclude(rootText);
    const included = include === null ? null : include.replace(/^\.\//, "");
    const includedVerify =
      included === null ? null : included.replace(/Taskfile\.ya?ml$/, "tasks/verify.yml");
    const r = evaluateConsumerCheckContract(projectRoot, {
      rootTaskfileText: rootText,
      verifyTaskfileText: head.read("tasks/verify.yml"),
      ciWorkflows: readTexts(head, (p) => /^\.github\/workflows\/.*\.ya?ml$/.test(p)),
      includedFrameworkTaskfileText: included === null ? null : head.read(included),
      includedVerifyTaskfileText: includedVerify === null ? null : head.read(includedVerify),
      frameworkSource: head.paths.includes("packages/core/src/check/gate-lists.ts"),
      ciWarnOnly: false,
      enforce: true,
    });
    return outcome(
      "verify:consumer-check-contract",
      r,
      changed.filter(
        (p) =>
          p === "Taskfile.yml" || p === "tasks/verify.yml" || p.startsWith(".github/workflows/"),
      ),
    );
  });
  return coverage;
}
