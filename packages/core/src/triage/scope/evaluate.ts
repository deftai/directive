import { DEFAULT_TRIAGE_SCOPE } from "./constants.js";
import { parseDurationMs } from "./duration.js";
import {
  evaluateMilestoneRuleInto,
  makeOpenMilestonesResolver,
  type OpenMilestonesFetcher,
} from "./milestone.js";
import { parseIso } from "./time.js";

export interface EvaluateRulesOptions {
  readonly now?: Date;
  readonly vbriefReferenced?: ReadonlySet<number>;
  readonly vbriefActiveReferenced?: ReadonlySet<number>;
  readonly umbrellaSlices?: ReadonlySet<number>;
  readonly openMilestonesFetcher?: OpenMilestonesFetcher;
  readonly repo?: string | null;
  readonly defaultOpenMilestonesFetcher?: (repo: string | null) => Set<string>;
}

function isOpen(issue: Record<string, unknown>): boolean {
  return issue.state === undefined ? true : issue.state === "open";
}

function issueNumber(issue: Record<string, unknown>): number {
  const n = issue.number;
  return typeof n === "number" && Number.isInteger(n) ? n : 0;
}

function labelNames(issue: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const raw = issue.labels;
  if (!Array.isArray(raw)) return names;
  for (const item of raw) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === "string") names.add(name);
    } else if (typeof item === "string") {
      names.add(item);
    }
  }
  return names;
}

function milestoneName(issue: Record<string, unknown>): string {
  const raw = issue.milestone;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const title = rec.title;
    if (typeof title === "string") return title;
    const alt = rec.name;
    if (typeof alt === "string") return alt;
    return "";
  }
  if (typeof raw === "string") return raw;
  return "";
}

function tsAfter(stamp: unknown, cutoff: Date): boolean {
  if (typeof stamp !== "string" || !stamp) return false;
  try {
    const dt = parseIso(stamp);
    return dt >= cutoff;
  } catch {
    return false;
  }
}

const noopFetcher = (): Set<string> => new Set();

/** Apply scope rules to issues; returns union of matches sorted by number. */
export function evaluateRules(
  rules: Iterable<Record<string, unknown>>,
  issues: Iterable<Record<string, unknown>>,
  options: EvaluateRulesOptions = {},
): Record<string, unknown>[] {
  const ruleList = [...rules];
  const effectiveRules =
    ruleList.length > 0 ? ruleList : DEFAULT_TRIAGE_SCOPE.map((r) => ({ ...r }));
  const issueList = [...issues];
  const nowDt = options.now ?? new Date();
  const matched = new Map<number, Record<string, unknown>>();

  const resolveOpen = makeOpenMilestonesResolver(
    options.openMilestonesFetcher,
    issueList,
    options.repo ?? null,
    options.defaultOpenMilestonesFetcher ?? noopFetcher,
  );

  const helpers = {
    getOpenMilestones: resolveOpen,
    isOpenIssue: isOpen,
    issueNumber,
    milestoneName,
  };

  for (const rule of effectiveRules) {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) continue;
    const kind = rule.rule;
    if (kind === "all-open") {
      for (const issue of issueList) {
        if (isOpen(issue)) matched.set(issueNumber(issue), issue);
      }
    } else if (kind === "labels") {
      const wantedAny = rule["any-of"];
      const wantedAll = rule["all-of"];
      for (const issue of issueList) {
        if (!isOpen(issue)) continue;
        const names = labelNames(issue);
        const hitAny =
          Array.isArray(wantedAny) &&
          wantedAny.some((label) => typeof label === "string" && names.has(label));
        const hitAll =
          Array.isArray(wantedAll) &&
          wantedAll.every((label) => typeof label === "string" && names.has(label));
        if (hitAny || hitAll) matched.set(issueNumber(issue), issue);
      }
    } else if (kind === "opened-since") {
      const cutoff = new Date(nowDt.getTime() - parseDurationMs(String(rule.duration)));
      for (const issue of issueList) {
        if (isOpen(issue) && tsAfter(issue.created_at, cutoff)) {
          matched.set(issueNumber(issue), issue);
        }
      }
    } else if (kind === "updated-since") {
      const cutoff = new Date(nowDt.getTime() - parseDurationMs(String(rule.duration)));
      for (const issue of issueList) {
        if (isOpen(issue) && tsAfter(issue.updated_at, cutoff)) {
          matched.set(issueNumber(issue), issue);
        }
      }
    } else if (kind === "referenced-by-vbrief") {
      const scope = rule.scope ?? "any";
      const refSet =
        scope === "active"
          ? (options.vbriefActiveReferenced ?? new Set())
          : (options.vbriefReferenced ?? new Set());
      for (const issue of issueList) {
        const n = issueNumber(issue);
        if (isOpen(issue) && refSet.has(n)) matched.set(n, issue);
      }
    } else if (kind === "sliced-from") {
      const slices = options.umbrellaSlices ?? new Set();
      for (const issue of issueList) {
        const n = issueNumber(issue);
        if (isOpen(issue) && slices.has(n)) matched.set(n, issue);
      }
    } else if (kind === "explicit-watch") {
      const issuesList = rule.issues;
      const pinned = new Set<number>();
      if (Array.isArray(issuesList)) {
        for (const e of issuesList) {
          if (typeof e === "object" && e !== null && !Array.isArray(e)) {
            const n = (e as Record<string, unknown>).n;
            if (typeof n === "number" && Number.isInteger(n)) pinned.add(n);
          }
        }
      }
      for (const issue of issueList) {
        const n = issueNumber(issue);
        if (pinned.has(n)) matched.set(n, issue);
      }
    } else if (kind === "milestone") {
      evaluateMilestoneRuleInto(rule, issueList, matched, helpers);
    }
  }

  return [...matched.keys()]
    .sort((a, b) => a - b)
    .map((k) => {
      const issue = matched.get(k);
      return issue ?? {};
    });
}

export { isOpen, issueNumber, labelNames, milestoneName };
