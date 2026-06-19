import { spawnSync } from "node:child_process";
import { collectMilestoneSubscribedNames, rulesRequestIsOpen } from "./milestone.js";
import { addIgnore, subscribe } from "./mutations-core.js";
import { resolveScopeIgnores, resolveScopeRules } from "./resolve.js";

export interface DiffReport {
  readonly subscribedLabels: ReadonlySet<string>;
  readonly ignoredLabels: ReadonlySet<string>;
  readonly neitherLabels: ReadonlySet<string>;
  readonly subscribedMilestones: ReadonlySet<string>;
  readonly ignoredMilestones: ReadonlySet<string>;
  readonly neitherMilestones: ReadonlySet<string>;
  readonly repo: string;
}

function subscribedLabels(rules: Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    if (rule.rule !== "labels") continue;
    for (const key of ["any-of", "all-of"] as const) {
      const value = rule[key];
      if (Array.isArray(value)) {
        for (const label of value) {
          if (typeof label === "string" && label) out.add(label);
        }
      }
    }
  }
  return out;
}

function subscribedMilestones(
  rules: Record<string, unknown>[],
  openSnapshot?: Set<string>,
): Set<string> {
  const out = collectMilestoneSubscribedNames(rules);
  if (rulesRequestIsOpen(rules) && openSnapshot) {
    for (const name of openSnapshot) out.add(name);
  }
  return out;
}

export function computeDiffFromUpstream(
  projectRoot: string,
  options: {
    upstreamLabels: Set<string>;
    upstreamMilestones: Set<string>;
    repo?: string;
    openMilestonesSnapshot?: Set<string>;
  },
): DiffReport {
  const rules = resolveScopeRules(projectRoot);
  const ignores = resolveScopeIgnores(projectRoot);
  const subLabels = subscribedLabels(rules);
  const subMs = subscribedMilestones(rules, options.openMilestonesSnapshot);
  const ignLabels = ignores.labels;
  const ignMs = ignores.milestones;

  const subscribedLabelSet = new Set<string>();
  const ignoredLabelSet = new Set<string>();
  const neitherLabelSet = new Set<string>();
  for (const name of options.upstreamLabels) {
    if (!name) continue;
    if (subLabels.has(name)) subscribedLabelSet.add(name);
    else if (ignLabels.has(name)) ignoredLabelSet.add(name);
    else neitherLabelSet.add(name);
  }

  const subscribedMsSet = new Set<string>();
  const ignoredMsSet = new Set<string>();
  const neitherMsSet = new Set<string>();
  for (const name of options.upstreamMilestones) {
    if (!name) continue;
    if (subMs.has(name)) subscribedMsSet.add(name);
    else if (ignMs.has(name)) ignoredMsSet.add(name);
    else neitherMsSet.add(name);
  }

  return {
    subscribedLabels: subscribedLabelSet,
    ignoredLabels: ignoredLabelSet,
    neitherLabels: neitherLabelSet,
    subscribedMilestones: subscribedMsSet,
    ignoredMilestones: ignoredMsSet,
    neitherMilestones: neitherMsSet,
    repo: options.repo ?? "",
  };
}

function fmtBucket(bucket: ReadonlySet<string>): string {
  if (bucket.size === 0) return "-";
  return [...bucket].sort().join(", ");
}

export function renderDiffReport(report: DiffReport): string {
  const lines: string[] = [];
  const repoSuffix = report.repo ? ` (repo: ${report.repo})` : "";
  lines.push(`triage:scope --diff-from-upstream${repoSuffix}`);
  lines.push("Labels:");
  lines.push(
    `  subscribed (${report.subscribedLabels.size}): ${fmtBucket(report.subscribedLabels)}`,
  );
  lines.push(`  ignored    (${report.ignoredLabels.size}): ${fmtBucket(report.ignoredLabels)}`);
  lines.push(`  neither    (${report.neitherLabels.size}): ${fmtBucket(report.neitherLabels)}`);
  lines.push("Milestones:");
  lines.push(
    `  subscribed (${report.subscribedMilestones.size}): ${fmtBucket(report.subscribedMilestones)}`,
  );
  lines.push(
    `  ignored    (${report.ignoredMilestones.size}): ${fmtBucket(report.ignoredMilestones)}`,
  );
  lines.push(
    `  neither    (${report.neitherMilestones.size}): ${fmtBucket(report.neitherMilestones)}`,
  );
  if (report.neitherLabels.size > 0 || report.neitherMilestones.size > 0) {
    lines.push("");
    lines.push(
      "To act on 'neither' items: task triage:scope -- --add-label=<L> / " +
        "--add-milestone=<M> / --ignore-label=<L>",
    );
  }
  return lines.join("\n");
}

function rawDecodeJson(text: string, offset: number): [unknown, number] {
  for (let end = offset + 1; end <= text.length; end += 1) {
    try {
      const obj = JSON.parse(text.slice(offset, end)) as unknown;
      return [obj, end - offset];
    } catch {
      // keep extending
    }
  }
  throw new SyntaxError("invalid JSON");
}

function addNamesFromList(data: unknown, nameField: string, names: Set<string>): void {
  if (!Array.isArray(data)) {
    throw new Error("non-list payload");
  }
  for (const item of data) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const value = (item as Record<string, unknown>)[nameField];
      if (typeof value === "string" && value) names.add(value);
    }
  }
}

function parseGhPaginatedNames(stdout: string, nameField: string): Set<string> {
  const names = new Set<string>();
  const text = stdout.trim();
  if (!text) return names;

  try {
    addNamesFromList(JSON.parse(text) as unknown, nameField, names);
    return names;
  } catch {
    // Paginate may concatenate arrays; decode one document at a time.
  }

  let idx = 0;
  while (idx < text.length) {
    while (idx < text.length && /\s/.test(text[idx] ?? "")) idx += 1;
    if (idx >= text.length) break;
    try {
      const [obj, consumed] = rawDecodeJson(text, idx);
      addNamesFromList(obj, nameField, names);
      idx += consumed;
    } catch (err) {
      throw new Error(`\`gh api\` returned non-JSON output: ${String(err)}`);
    }
  }
  return names;
}

function fetchNamesViaGh(binary: string, path: string, nameField: string): Set<string> {
  let proc: ReturnType<typeof spawnSync>;
  try {
    proc = spawnSync(binary, ["api", "--paginate", path], {
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch {
    throw new Error(`\`${binary} api ${path}\` timed out after 30s -- check your network.`);
  }
  if (proc.error) {
    const errCode = (proc.error as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      throw new Error(
        `\`${binary}\` not found on PATH -- install GitHub CLI to use ` +
          "`task triage:scope -- --diff-from-upstream`.",
      );
    }
    if (proc.error.message?.includes("ETIMEDOUT")) {
      throw new Error(`\`${binary} api ${path}\` timed out after 30s -- check your network.`);
    }
  }
  if (proc.status !== 0) {
    const errText = String(proc.stderr ?? proc.stdout ?? "").trim();
    throw new Error(`\`${binary} api ${path}\` failed (exit ${proc.status}): ${errText}`);
  }
  return parseGhPaginatedNames(String(proc.stdout ?? ""), nameField);
}

export function fetchUpstreamLabelsAndMilestones(
  repo: string,
  binary = "gh",
): [Set<string>, Set<string>] {
  if (!repo.includes("/")) {
    throw new Error(
      `--repo must be 'owner/name'; got ${JSON.stringify(repo)}. Pass --repo OR set $DEFT_TRIAGE_REPO.`,
    );
  }
  const labels = fetchNamesViaGh(binary, `repos/${repo}/labels?per_page=100`, "name");
  const milestones = fetchNamesViaGh(
    binary,
    `repos/${repo}/milestones?per_page=100&state=open`,
    "title",
  );
  return [labels, milestones];
}

export function addLabelToScope(
  projectRoot: string,
  label: string,
  actor?: string | null,
): [boolean, string] {
  if (!label.trim())
    throw new Error(`label must be a non-empty string; got ${JSON.stringify(label)}`);
  return subscribe(projectRoot, { label, actor });
}

export function addMilestoneToScope(
  projectRoot: string,
  milestone: string,
  actor?: string | null,
): [boolean, string] {
  if (!milestone.trim()) {
    throw new Error(`milestone must be a non-empty string; got ${JSON.stringify(milestone)}`);
  }
  return subscribe(projectRoot, { milestone, actor });
}

export function addLabelToIgnores(projectRoot: string, label: string): [boolean, string] {
  if (!label.trim())
    throw new Error(`label must be a non-empty string; got ${JSON.stringify(label)}`);
  return addIgnore(projectRoot, label);
}
