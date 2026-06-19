import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { referenceWithDefaultTrust, slugify } from "./build.js";
import { EMITTED_VBRIEF_VERSION } from "./constants.js";
import { pythonJsonPretty } from "./json.js";
import type { JsonObject } from "./types.js";

/** Return (from_id, to_id) for a vBRIEF edge, reading both dialects. */
export function edgeNodes(edge: JsonObject): [string, string] {
  if (typeof edge !== "object" || edge === null || Array.isArray(edge)) {
    return ["", ""];
  }
  const src = edge.from ?? edge.source ?? "";
  const tgt = edge.to ?? edge.target ?? "";
  return [String(src || ""), String(tgt || "")];
}

/** Return item IDs that block ``itemId`` (bilingual reader). */
export function dependenciesForItem(itemId: string, edges: readonly JsonObject[]): string[] {
  const deps: string[] = [];
  for (const edge of edges ?? []) {
    if (typeof edge !== "object" || edge === null || Array.isArray(edge)) {
      continue;
    }
    if (edge.type !== "blocks") {
      continue;
    }
    const [src, tgt] = edgeNodes(edge);
    if (tgt === itemId && src && !deps.includes(src)) {
      deps.push(src);
    }
  }
  return deps;
}

/** Return a slug for a speckit IP item filename. */
export function speckitIpSlug(title: string, itemId: string): string {
  let source = (title || itemId || "").trim();
  source = source.replace(/^\s*IP[\s-]*\d+\s*[:-]\s*/i, "");
  const slug = slugify(source);
  return slug || slugify(itemId) || "ip-phase";
}

/** Derive the numeric IP index for a speckit plan item. */
export function speckitIpIndex(item: JsonObject, fallbackIndex: number): number {
  const itemId = String(item.id ?? "");
  // Python oracle: re.search(r"(\d+)\s*$", item_id). Digits and whitespace are
  // disjoint classes, so trimming trailing whitespace first and anchoring with
  // /(\d+)$/ is parity-exact while removing the polynomial backtracking CodeQL
  // flagged (js/polynomial-redos). See scripts/_vbrief_speckit.py:69.
  const tail = itemId.trimEnd().match(/(\d+)$/);
  if (tail) {
    return Number.parseInt(tail[1] ?? "0", 10);
  }
  const title = String(item.title ?? "");
  const lead = title.match(/IP[\s-]*(\d+)/i);
  if (lead) {
    return Number.parseInt(lead[1] ?? "0", 10);
  }
  return fallbackIndex;
}

function nonEmptyText(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function vbriefRelativeSpecRef(specRef: string): string {
  let normalized = specRef.trim();
  while (normalized.startsWith("../")) {
    normalized = normalized.slice(3);
  }
  return normalized || "specification.vbrief.json";
}

/** Build a Phase 4 scope vBRIEF dict for a speckit implementation phase. */
export function createSpeckitScopeVbrief(
  item: JsonObject,
  options: {
    readonly ipIndex: number;
    readonly dependencies: readonly string[];
    readonly specRef: string;
  },
): JsonObject {
  const specRef = vbriefRelativeSpecRef(options.specRef);
  const fallbackTitle = `IP-${options.ipIndex}`;
  const title = nonEmptyText(item.title, fallbackTitle);
  const rawNarrative = item.narrative;
  const narrative =
    typeof rawNarrative === "object" && rawNarrative !== null && !Array.isArray(rawNarrative)
      ? (rawNarrative as JsonObject)
      : {};

  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = narrative[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return "";
  };

  const description = pick("Description", "Summary") || title || fallbackTitle;
  const acceptance = pick("Acceptance", "AcceptanceCriteria");
  const traces = pick("Traces", "Trace", "Requirements") || fallbackTitle;

  const defaultAcceptance = `Acceptance criteria for IP-${options.ipIndex} (copy from specification.vbrief.json).`;

  const narratives: Record<string, string> = {
    Description: description,
    Acceptance: acceptance || defaultAcceptance,
    Traces: traces,
  };
  for (const extra of ["Phase", "PhaseDescription", "Tier"] as const) {
    const value = narrative[extra];
    if (typeof value === "string" && value.trim().length > 0) {
      narratives[extra] = value.trim();
    }
  }

  const references: JsonObject[] = [
    referenceWithDefaultTrust({ type: "x-vbrief/plan", uri: specRef }),
  ];
  const itemRefs = item.references;
  if (Array.isArray(itemRefs)) {
    for (const ref of itemRefs) {
      if (
        typeof ref === "object" &&
        ref !== null &&
        !Array.isArray(ref) &&
        (ref as JsonObject).type !== "x-vbrief/plan"
      ) {
        references.push(referenceWithDefaultTrust(ref as JsonObject));
      }
    }
  }

  const metadata: JsonObject = { kind: "phase" };
  if (options.dependencies.length > 0) {
    metadata.dependencies = [...options.dependencies];
  }

  return {
    vBRIEFInfo: {
      version: EMITTED_VBRIEF_VERSION,
      description: `Scope vBRIEF for speckit IP-${options.ipIndex}`,
    },
    plan: {
      title,
      status: "pending",
      narratives,
      items: [],
      metadata,
      references,
    },
  };
}

/** Translate a speckit-shaped ``plan.vbrief.json`` into scope vBRIEFs. */
export function migrateSpeckitPlan(
  planPath: string,
  options: {
    readonly pendingDir?: string;
    readonly date?: string;
    readonly specRef?: string;
    readonly today?: string;
  } = {},
): [boolean, string[]] {
  const actions: string[] = [];
  if (!existsSync(planPath)) {
    return [false, [`ERROR: plan.vbrief.json not found at ${planPath}`]];
  }
  let planData: unknown;
  try {
    planData = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return [false, [`ERROR: invalid JSON in ${basename(planPath)}: ${msg}`]];
  }

  const planRoot =
    typeof planData === "object" && planData !== null ? (planData as JsonObject) : {};
  const plan =
    typeof planRoot.plan === "object" && planRoot.plan !== null && !Array.isArray(planRoot.plan)
      ? (planRoot.plan as JsonObject)
      : {};
  const items = Array.isArray(plan.items) ? plan.items : [];
  const edges = Array.isArray(plan.edges) ? (plan.edges as JsonObject[]) : [];

  if (items.length === 0) {
    return [false, ["ERROR: plan.vbrief.json has no items to migrate (empty speckit plan?)"]];
  }

  const planDir = planPath.replace(/[/\\][^/\\]+$/, "");
  const pendingDir = options.pendingDir ?? `${planDir}/pending`;
  mkdirSync(pendingDir, { recursive: true });
  const effectiveDate = options.date ?? options.today ?? new Date().toISOString().slice(0, 10);
  const specRef = options.specRef ?? "specification.vbrief.json";

  for (let idx = 0; idx < items.length; idx += 1) {
    const item = items[idx];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const itemObj = item as JsonObject;
    const ipIndex = speckitIpIndex(itemObj, idx + 1);
    const itemId = String(itemObj.id ?? `ip-${ipIndex}`);
    const dependencies = dependenciesForItem(itemId, edges);
    const slug = speckitIpSlug(String(itemObj.title ?? ""), itemId);
    const ipToken = `ip${String(ipIndex).padStart(3, "0")}`;
    const filename = `${effectiveDate}-${ipToken}-${slug}.vbrief.json`;
    const target = `${pendingDir}/${filename}`;
    try {
      readFileSync(target);
      actions.push(`SKIP   pending/${filename} already exists`);
      continue;
    } catch {
      /* create new file */
    }
    const scope = createSpeckitScopeVbrief(itemObj, {
      ipIndex,
      dependencies,
      specRef,
    });
    writeFileSync(target, pythonJsonPretty(scope), { encoding: "utf8" });
    actions.push(`CREATE pending/${filename} (IP-${ipIndex})`);
  }

  const envelope =
    typeof planRoot.vBRIEFInfo === "object" &&
    planRoot.vBRIEFInfo !== null &&
    !Array.isArray(planRoot.vBRIEFInfo)
      ? { ...(planRoot.vBRIEFInfo as JsonObject) }
      : {};
  envelope.version = EMITTED_VBRIEF_VERSION;
  envelope.description =
    "Session-level tactical plan (migrated from speckit plan). " +
    "Scope vBRIEFs live in vbrief/pending/.";

  const sessionPlan = {
    vBRIEFInfo: envelope,
    plan: {
      title: String(plan.title ?? "Session plan") || "Session plan",
      status: "running",
      items: [],
    },
  };
  writeFileSync(planPath, pythonJsonPretty(sessionPlan), { encoding: "utf8" });
  actions.push(`REWRITE ${basename(planPath)} -> session-todo scaffold`);
  return [true, actions];
}
