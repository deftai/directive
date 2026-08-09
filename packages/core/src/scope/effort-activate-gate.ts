/**
 * Effort estimate activate gate (#1581).
 *
 * PlanItem.effort is optional (S|M|L|XL). XL means "needs breakdown" —
 * a scope must not move into active/running while any plan item (nested
 * via items or subItems) still carries effort === "XL".
 */

export const EFFORT_XL = "XL" as const;

export interface XlEffortHit {
  readonly id: string;
  readonly title: string;
  readonly path: string;
}

export interface EffortActivateGateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly xlItems: readonly XlEffortHit[];
}

function itemLabel(item: Record<string, unknown>): string {
  if (typeof item.id === "string" && item.id.length > 0) {
    return item.id;
  }
  if (typeof item.title === "string" && item.title.length > 0) {
    return item.title;
  }
  return "<no-id>";
}

/**
 * Walk plan.items / subItems and collect every item with effort === "XL".
 */
export function collectXlEffortItems(items: unknown, pathPrefix = "plan.items"): XlEffortHit[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const hits: XlEffortHit[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const item = raw as Record<string, unknown>;
    const id = itemLabel(item);
    const path = `${pathPrefix}[${id}]`;
    if (item.effort === EFFORT_XL) {
      hits.push({
        id,
        title: typeof item.title === "string" ? item.title : id,
        path,
      });
    }
    hits.push(...collectXlEffortItems(item.items, `${path}.items`));
    hits.push(...collectXlEffortItems(item.subItems, `${path}.subItems`));
  }
  return hits;
}

/**
 * Fail-closed activate gate: any XL plan item blocks pending → active.
 * Omitted effort is allowed (field is optional).
 */
export function evaluateEffortActivateGate(
  plan: Record<string, unknown>,
): EffortActivateGateResult {
  const xlItems = collectXlEffortItems(plan.items);
  if (xlItems.length === 0) {
    return { ok: true, message: "", xlItems: [] };
  }
  const listing = xlItems.map((h) => `${h.path} ("${h.title}")`).join("; ");
  return {
    ok: false,
    message:
      `Refusing activate: plan item(s) still have effort=XL and must be broken ` +
      `into S/M/L before active/running (#1581): ${listing}. ` +
      `Replace each XL item with smaller S/M/L sub-items (or re-estimate to S/M/L), then retry.`,
    xlItems,
  };
}
