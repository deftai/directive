/** A mint binds one running story, its merge-base file scope and its contract.
 * Mere historical mint existence, head scope expansion, and inferred scans are
 * not admission. Record bytes always come from the pinned base snapshot.
 */
import { isAbsolute, relative } from "node:path";
import {
  computeContractDigest as intentDigest,
  parseIntentConstraintContract,
  parseIntentConstraintRecord,
} from "../intent-constraint/mint.js";
import {
  computeContractDigest as observableDigest,
  parseObservableChangeContract,
  parseObservableScopeRecord,
} from "../observable-scope/mint.js";
import { isLandsWithProductPlan } from "../scope/lifecycle-write.js";
import { matchPolicyGlob } from "../test-boundary/evaluate.js";
import { isRecord, normalizeRel } from "./paths.js";
import { type CoverageSnapshot, readTexts } from "./snapshot.js";
export interface CurrentStory {
  readonly planId: string;
  readonly rel: string;
  readonly scope: readonly string[];
  readonly basePlan: Record<string, unknown>;
  readonly headPlan: Record<string, unknown>;
}
export function currentStory(
  snapshot: CoverageSnapshot,
  planId?: string,
): CurrentStory | { error: string } {
  const candidates: CurrentStory[] = [];
  const moved: CurrentStory[] = [];
  const pin = process.env.DEFT_ACTIVE_SCOPE;
  const pinRel = pin
    ? normalizeRel(isAbsolute(pin) ? relative(snapshot.projectRoot, pin) : pin)
    : undefined;
  // #6277 Bound 6: a changed completed/ brief stamped lands-with-product is the
  // story's brief moved out of active/ by this change set; its base is active/.
  const changed = new Set(snapshot.changed.map((p) => normalizeRel(p)));
  for (const [rel, text] of readTexts(
    snapshot.head,
    (p) =>
      /^xbrief\/active\/.*\.xbrief\.json$/.test(p) ||
      (/^xbrief\/completed\/[^/]+\.xbrief\.json$/.test(p) && changed.has(normalizeRel(p))),
  )) {
    const isMove = rel.startsWith("xbrief/completed/");
    const baseRel = isMove ? `xbrief/active/${rel.slice("xbrief/completed/".length)}` : rel;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { error: `invalid active story ${rel}` };
    }
    if (
      !isRecord(raw) ||
      !isRecord(raw.plan) ||
      raw.plan.status !== (isMove ? "completed" : "running") ||
      typeof raw.plan.id !== "string" ||
      (isMove && !isLandsWithProductPlan(raw.plan))
    )
      continue;
    if (planId !== undefined && raw.plan.id !== planId) continue;
    if (planId === undefined && pinRel !== undefined && pinRel !== rel && pinRel !== baseRel)
      continue;
    const baseText = snapshot.base.read(baseRel);
    if (baseText === null) continue;
    let base: unknown;
    try {
      base = JSON.parse(baseText);
    } catch {
      return { error: `invalid base story ${rel}` };
    }
    if (
      !isRecord(base) ||
      !isRecord(base.plan) ||
      base.plan.id !== raw.plan.id ||
      base.plan.status !== "running"
    )
      continue;
    const meta = isRecord(base.plan.metadata) ? base.plan.metadata : {};
    const swarm = isRecord(meta.swarm) ? meta.swarm : {};
    const scope = Array.isArray(swarm.file_scope)
      ? swarm.file_scope.filter((x): x is string => typeof x === "string")
      : [];
    // A moved story keeps its merge-base active/ path as `rel`: base mints name it.
    const story = {
      planId: raw.plan.id,
      rel: baseRel,
      scope,
      basePlan: base.plan,
      headPlan: raw.plan,
    };
    candidates.push(story);
    if (isMove) moved.push(story);
  }
  const soleMove = moved.length === 1 ? moved[0] : undefined;
  if (soleMove !== undefined && candidates.length > 1) {
    return soleMove;
  }
  return candidates.length === 1
    ? candidates[0]!
    : {
        error:
          "exactly one current running story with merge-base file_scope is required for admission; use --plan-id",
      };
}
export function storyCovers(story: CurrentStory, path: string): boolean {
  return story.scope.some((glob) => matchPolicyGlob(path, glob));
}
export function scopedMint(
  snapshot: CoverageSnapshot,
  story: CurrentStory,
  kind: "intent" | "observable",
): { records: Map<string, string>; authority: string } | { error: string; absent?: boolean } {
  const texts = readTexts(
    snapshot.base,
    (p) =>
      p.startsWith(`.deft/${kind === "intent" ? "intent-constraint" : "observable-scope"}/`) &&
      p.endsWith(".json"),
  );
  const matches: Array<[string, string]> = [];
  for (const [rel, text] of texts) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { error: `invalid mint JSON ${rel}` };
    }
    const mint =
      kind === "intent" ? parseIntentConstraintRecord(raw) : parseObservableScopeRecord(raw);
    if ("error" in mint) return { error: `${rel}: ${mint.error}` };
    if (mint.planId !== story.planId || normalizeRel(mint.xbriefRelPath) !== story.rel) continue;
    for (const plan of [story.basePlan, story.headPlan]) {
      if (kind === "intent") {
        const c = parseIntentConstraintContract(plan["x-directive/intentConstraint"]);
        if ("error" in c || intentDigest(c.constraints) !== mint.contractDigest)
          return { error: `${rel}: intent contract does not match current story` };
      } else {
        const c = parseObservableChangeContract(plan["x-directive/observableChange"]);
        if (
          "error" in c ||
          observableDigest(c) !== mint.contractDigest ||
          ("changeKind" in mint && c.changeKind !== mint.changeKind)
        )
          return { error: `${rel}: observable contract does not match current story` };
      }
    }
    matches.push([rel, text]);
  }
  return matches.length === 1
    ? { records: new Map(matches), authority: matches[0]![0] }
    : {
        error: `no unique ${kind} mint for current story ${story.planId}`,
        absent: matches.length === 0,
      };
}
