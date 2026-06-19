import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { subscriptionHash } from "./normalize.js";
import { pyListRepr } from "./python-repr.js";

const LIFECYCLE_FOLDERS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

export function extractReferencedIssues(
  projectRoot: string,
  lifecycleFolders: readonly string[] = LIFECYCLE_FOLDERS,
): { any: Set<number>; active: Set<number> } {
  const root = join(projectRoot, "vbrief");
  const anySet = new Set<number>();
  const activeSet = new Set<number>();
  if (!existsSync(root)) return { any: anySet, active: activeSet };

  for (const folder of lifecycleFolders) {
    const folderPath = join(root, folder);
    if (!existsSync(folderPath)) continue;
    for (const name of readdirSync(folderPath)) {
      if (!name.endsWith(".vbrief.json")) continue;
      const vbriefPath = join(folderPath, name);
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(vbriefPath, "utf8"));
      } catch {
        continue;
      }
      if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
      const plan = (data as Record<string, unknown>).plan;
      if (typeof plan !== "object" || plan === null || Array.isArray(plan)) continue;
      const refs = (plan as Record<string, unknown>).references ?? [];
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
        const rec = ref as Record<string, unknown>;
        if (rec.type !== "x-vbrief/github-issue") continue;
        const uri = rec.uri;
        if (typeof uri !== "string") continue;
        const tail = uri.replace(/\/$/, "").split("/").pop() ?? "";
        if (/^\d+$/.test(tail)) {
          const n = Number.parseInt(tail, 10);
          anySet.add(n);
          if (folder === "active") activeSet.add(n);
        }
      }
    }
  }
  return { any: anySet, active: activeSet };
}

function renderRule(idx: number, rule: Record<string, unknown>): string[] {
  const kind = rule.rule ?? "<unknown>";
  if (kind === "all-open") return [`  ${idx}. all-open`];
  if (kind === "labels") {
    if ("any-of" in rule && Array.isArray(rule["any-of"])) {
      const sorted = [...rule["any-of"]].filter((x): x is string => typeof x === "string").sort();
      return [`  ${idx}. labels any-of=${pyListRepr(sorted)}`];
    }
    if ("all-of" in rule && Array.isArray(rule["all-of"])) {
      const sorted = [...rule["all-of"]].filter((x): x is string => typeof x === "string").sort();
      return [`  ${idx}. labels all-of=${pyListRepr(sorted)}`];
    }
    return [`  ${idx}. labels (malformed)`];
  }
  if (kind === "milestone") {
    if ("name" in rule) return [`  ${idx}. milestone name=${JSON.stringify(rule.name ?? "?")}`];
    if ("any-of" in rule) {
      const raw = rule["any-of"];
      const sorted = Array.isArray(raw)
        ? [...raw].filter((x): x is string => typeof x === "string").sort()
        : raw;
      return [
        `  ${idx}. milestone any-of=${Array.isArray(sorted) ? pyListRepr(sorted) : String(sorted)}`,
      ];
    }
    if (rule["is-open"] === true) {
      return [`  ${idx}. milestone is-open=true (currently-open upstream)`];
    }
    return [`  ${idx}. milestone (malformed)`];
  }
  if (kind === "opened-since" || kind === "updated-since") {
    return [`  ${idx}. ${kind} duration=${rule.duration ?? "?"}`];
  }
  if (kind === "referenced-by-vbrief") {
    return [`  ${idx}. referenced-by-vbrief scope=${rule.scope ?? "?"}`];
  }
  if (kind === "sliced-from") {
    return [`  ${idx}. sliced-from scope=${rule.scope ?? "?"}`];
  }
  if (kind === "explicit-watch") {
    const out = [`  ${idx}. explicit-watch:`];
    const issues = rule.issues;
    if (Array.isArray(issues)) {
      for (const entry of issues) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const rec = entry as Record<string, unknown>;
        out.push(`       - #${rec.n}  (${rec.note ?? ""})`);
      }
    }
    return out;
  }
  return [`  ${idx}. ${kind} (unknown rule type)`];
}

export function renderList(
  rules: Iterable<Record<string, unknown>>,
  options: { isDefault?: boolean } = {},
): string {
  const ruleList = [...rules];
  const lines: string[] = [];
  let header = `triage:scope effective rules (${ruleList.length}):`;
  if (options.isDefault) {
    header += " (default applied -- plan.policy.triageScope unset)";
  }
  lines.push(header);
  for (let i = 0; i < ruleList.length; i += 1) {
    const rule = ruleList[i];
    if (typeof rule === "object" && rule !== null && !Array.isArray(rule)) {
      lines.push(...renderRule(i + 1, rule));
    }
  }
  lines.push(`subscription-hash: ${subscriptionHash(ruleList)}`);
  return lines.join("\n");
}

export function renderIgnores(
  ignores: Iterable<Record<string, unknown>> | null | undefined,
): string {
  const entries = [...(ignores ?? [])];
  const lines = [`triage:scope ignores (${entries.length} entries):`];
  if (entries.length === 0) {
    lines.push("  (none) -- task triage:scope -- --ignore-label=<L> to add");
    return lines.join("\n");
  }
  const labels: string[] = [];
  const milestones: string[] = [];
  const authors: string[] = [];
  const other: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      other.push(JSON.stringify(entry));
      continue;
    }
    if (entry.rule === "author") {
      const anyOf = entry["any-of"];
      if (Array.isArray(anyOf)) {
        for (const name of anyOf) {
          if (typeof name === "string" && name) authors.push(name);
        }
      }
      continue;
    }
    const label = entry.label;
    if (typeof label === "string" && label) {
      labels.push(label);
      continue;
    }
    const milestone = entry.milestone;
    if (typeof milestone === "string" && milestone) {
      milestones.push(milestone);
      continue;
    }
    other.push(JSON.stringify(entry));
  }
  if (labels.length > 0) lines.push(`  labels:     ${pyListRepr([...labels].sort())}`);
  if (milestones.length > 0) lines.push(`  milestones: ${pyListRepr([...milestones].sort())}`);
  if (authors.length > 0) lines.push(`  authors:    ${pyListRepr([...authors].sort())}`);
  if (other.length > 0) lines.push(`  unrecognised: ${JSON.stringify(other)}`);
  return lines.join("\n");
}
