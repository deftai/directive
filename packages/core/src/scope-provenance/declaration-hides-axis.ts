/**
 * Declaration hides a strict axis after activation (#6591).
 *
 * `x-directive/requires` (or one of its seven aliases) can turn off the axes an
 * item's text infers, so scope:complete accepts test or review evidence for a
 * deploy, smoke or UAT clause. A declaration on the merge-base active brief is
 * agent precommitment reviewed at activation, not human authorization. This
 * module finds a declaration written or changed after activation by comparing
 * each head item with the same item on the merge-base copy of the brief.
 *
 * One line per head item when all three hold:
 * (a) the resolved merge-base copy of the brief is under xbrief/active/;
 * (b) the item is absent from that copy, or the value of any of the eight
 *     declaration fields differs from the base item (items match by id; an
 *     item with no id matches by its position in the item tree);
 * (c) the head item hides an axis that the base item does not hide (an absent
 *     base item hides none).
 *
 * The row warns only (#6281). The caller prints the lines on the extra-path
 * warning channel; they never change the exit code and are not intent-pin
 * findings. There is no enforce mode for this row (#6591 item 10).
 */
import { formatDeclaredRefusal } from "../refusal-declarations/print.js";
import {
  forEachStrictAxisItem,
  inferHiddenStrictAxes,
  readExplicitAcceptanceRequirementFields,
  type StrictAcceptanceAxis,
  strictAxisItemId,
} from "../scope/acceptance-evidence.js";
import { type BaseBriefRead, normalizeRepoRelPath } from "./census-batch.js";

/** Refusal table id of the row (warn mode). */
export const DECLARATION_HIDES_AXIS_REFUSAL_ID = "declaration-hides-axis";

/** One head item whose declaration newly hides a strict axis. */
export interface DeclarationHidesAxisHit {
  /** JSON path of the head item, e.g. `plan.items[0].subItems[1]`. */
  readonly path: string;
  readonly id: string | null;
  /** Axes the head item hides that the base item did not hide. */
  readonly axes: readonly StrictAcceptanceAxis[];
  /** True when the item is not on the merge-base copy. */
  readonly newItem: boolean;
}

function planOf(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return (payload as Record<string, unknown>).plan;
}

/** True when all eight declaration fields hold the same value on both items. */
function sameDeclaration(head: Record<string, unknown>, base: Record<string, unknown>): boolean {
  const baseValues = readExplicitAcceptanceRequirementFields(base);
  return readExplicitAcceptanceRequirementFields(head).every(
    (value, index) => JSON.stringify(value) === JSON.stringify(baseValues[index]),
  );
}

/**
 * Conditions (b) and (c): head items whose declaration newly hides a strict
 * axis, compared with the merge-base payload of the same brief. The caller
 * checks (a).
 */
export function findDeclarationHidesAxis(
  basePayload: unknown,
  headPayload: unknown,
): DeclarationHidesAxisHit[] {
  const baseById = new Map<string, Record<string, unknown>>();
  const baseByPath = new Map<string, Record<string, unknown>>();
  forEachStrictAxisItem(planOf(basePayload), (item, path) => {
    baseByPath.set(path, item);
    const id = strictAxisItemId(item);
    if (id !== null && !baseById.has(id)) {
      baseById.set(id, item);
    }
  });
  const hits: DeclarationHidesAxisHit[] = [];
  forEachStrictAxisItem(planOf(headPayload), (item, path) => {
    const hidden = inferHiddenStrictAxes(item);
    if (hidden.length === 0) {
      return;
    }
    const id = strictAxisItemId(item);
    const base = id !== null ? baseById.get(id) : baseByPath.get(path);
    if (base !== undefined && sameDeclaration(item, base)) {
      return;
    }
    const baseHidden = base === undefined ? [] : inferHiddenStrictAxes(base);
    const axes = hidden.filter((axis) => !baseHidden.includes(axis));
    if (axes.length > 0) {
      hits.push({ path, id, axes, newItem: base === undefined });
    }
  });
  return hits;
}

/**
 * The declared warn lines for one brief modified in the change set (#6591).
 * `baseRel` and `baseRead` come from the path fence's continuity and pre-move
 * resolution, so a completed/ or cancelled/ head is compared with its
 * pre-move copy. A base copy outside xbrief/active/ (for example a pending/
 * to active/ move), missing, unreadable or not JSON yields no line; the path
 * fence reports base read failures.
 */
export function declarationHidesAxisLines(input: {
  readonly headRel: string;
  readonly headPayload: unknown;
  readonly baseRel: string;
  readonly baseRead: BaseBriefRead;
}): string[] {
  const baseRel = normalizeRepoRelPath(input.baseRel);
  if (!baseRel.startsWith("xbrief/active/") || input.baseRead.kind !== "text") {
    return [];
  }
  let basePayload: unknown;
  try {
    basePayload = JSON.parse(input.baseRead.text) as unknown;
  } catch {
    return [];
  }
  return findDeclarationHidesAxis(basePayload, input.headPayload).map((hit) => {
    const change = hit.newItem
      ? "the item is not on"
      : "its declaration fields differ from the item on";
    return formatDeclaredRefusal({
      id: DECLARATION_HIDES_AXIS_REFUSAL_ID,
      detail:
        `${input.headRel} item ${hit.id ?? hit.path}: its declaration hides ` +
        `${hit.axes.join(", ")}, which the item text requires, and ${change} ` +
        `the active brief on the merge base (${baseRel})`,
    }).line;
  });
}
