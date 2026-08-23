import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ISSUE_URI_RE = /\/issues\/(\d+)\b/u;
const ISSUE_HASH_RE = /(?:Issue\s+)?#(\d+)\b/u;

export interface XbriefHit {
  readonly issue: number;
  readonly path: string;
  readonly folder: "active" | "pending" | "proposed" | "completed" | "cancelled";
}

function numbersFromUnknown(value: unknown, into: Set<number>): void {
  if (typeof value === "string") {
    for (const re of [ISSUE_URI_RE, ISSUE_HASH_RE]) {
      const match = re.exec(value);
      if (match?.[1] !== undefined) {
        into.add(Number.parseInt(match[1], 10));
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      numbersFromUnknown(item, into);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      numbersFromUnknown(nested, into);
    }
  }
}

export function issueNumbersFromXbriefJson(raw: unknown): number[] {
  const found = new Set<number>();
  if (raw === null || typeof raw !== "object") {
    return [];
  }
  const plan = (raw as { plan?: { references?: unknown } }).plan;
  numbersFromUnknown(plan?.references, found);
  return [...found];
}

export function listXbriefHits(root: string, folder: XbriefHit["folder"]): XbriefHit[] {
  const dir = join(root, "xbrief", folder);
  if (!existsSync(dir)) {
    return [];
  }
  const hits: XbriefHit[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".xbrief.json") && !name.endsWith(".vbrief.json")) {
      continue;
    }
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      continue;
    }
    for (const issue of issueNumbersFromXbriefJson(parsed)) {
      hits.push({ issue, path, folder });
    }
  }
  return hits;
}
