import { GROUP_DISPLAY } from "./constants.js";
import type { QueueItem } from "./types.js";

function truncate(text: string, width: number): string {
  if (width <= 1 || text.length <= width) {
    return text;
  }
  return `${text.slice(0, width - 1)}...`;
}

/** Pretty-print the ranked queue. Mirrors scripts/triage_queue.py::render_queue. */
export function renderQueue(options: {
  readonly items: readonly QueueItem[];
  readonly repo: string;
  readonly limit?: number | null;
  readonly rankingLabels?: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push(`triage:queue -- ${options.repo}`);
  const rankingLabels = options.rankingLabels ?? [];
  if (rankingLabels.length > 0) {
    lines.push(`  consumer ranking labels (in declared order): ${rankingLabels.join(", ")}`);
  } else {
    lines.push(
      "  consumer ranking labels: <empty> (framework default; within-group = updated_at desc)",
    );
  }
  if (options.limit !== null && options.limit !== undefined) {
    lines.push(`  limit: ${options.limit}`);
  }
  lines.push("");
  if (options.items.length === 0) {
    lines.push("  (no cached issues -- run `task triage:bootstrap` first)");
    return lines.join("\n");
  }
  for (const item of options.items) {
    const marker = GROUP_DISPLAY[item.group] ?? `[${item.group}] `;
    const labelHint = item.matchedLabel !== null ? ` (label: ${item.matchedLabel})` : "";
    const title = truncate(item.title, 72);
    lines.push(`  ${marker}#${item.number}  ${title}  -- updated ${item.updatedAt}${labelHint}`);
  }
  return lines.join("\n");
}
