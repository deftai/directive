import { pythonTypeName } from "./python-repr.js";

const MILESTONE_VARIANT_KEYS = ["name", "any-of", "is-open"] as const;
const MILESTONE_ALL_KEYS = new Set(["rule", ...MILESTONE_VARIANT_KEYS]);

export function validateMilestoneRule(
  rule: Record<string, unknown>,
  prefix: string,
  errors: string[],
  warnings: string[],
): void {
  const hasName = "name" in rule;
  const hasAny = "any-of" in rule;
  const hasOpen = "is-open" in rule;
  const setCount = [hasName, hasAny, hasOpen].filter(Boolean).length;

  if (setCount === 0) {
    errors.push(
      `${prefix}.milestone requires one of 'name' / 'any-of' / ` +
        "'is-open: true' (D14b / #1181); see " +
        "scripts/triage_scope.py for the variant matrix",
    );
    return;
  }

  if (setCount > 1) {
    const present = MILESTONE_VARIANT_KEYS.filter((k) => k in rule);
    errors.push(
      `${prefix}.milestone: ${JSON.stringify(present)} are mutually exclusive; ` +
        "choose exactly one of name / any-of / is-open (#1181)",
    );
    return;
  }

  if (hasName) {
    const name = rule.name;
    if (typeof name !== "string" || !name.trim()) {
      errors.push(`${prefix}.milestone.name must be a non-empty string`);
    }
    return;
  }

  if (hasAny) {
    const anyOf = rule["any-of"];
    if (!Array.isArray(anyOf) || anyOf.length === 0) {
      errors.push(`${prefix}.milestone.any-of must be a non-empty list of strings (#1181)`);
      return;
    }
    for (let j = 0; j < anyOf.length; j += 1) {
      const item = anyOf[j];
      if (typeof item !== "string" || !item) {
        errors.push(`${prefix}.milestone.any-of[${j}] must be a non-empty string`);
      }
    }
    return;
  }

  const isOpen = rule["is-open"];
  if (typeof isOpen !== "boolean") {
    errors.push(
      `${prefix}.milestone.is-open must be a boolean literal \`true\`; ` +
        `got ${pythonTypeName(isOpen)} (#1181)`,
    );
    return;
  }
  if (isOpen === false) {
    errors.push(
      `${prefix}.milestone.is-open: false is meaningless -- ` +
        "to subscribe to specific milestones use `name` or " +
        "`any-of` (#1181)",
    );
    return;
  }

  const extra = Object.keys(rule)
    .filter((k) => !MILESTONE_ALL_KEYS.has(k))
    .sort();
  if (extra.length > 0) {
    warnings.push(`${prefix}.milestone: ignoring unrecognised keys ${JSON.stringify(extra)}`);
  }
}

export function collectMilestoneSubscribedNames(
  rules: Iterable<Record<string, unknown>>,
): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    if (rule.rule !== "milestone") continue;
    const name = rule.name;
    if (typeof name === "string" && name) out.add(name);
    const anyOf = rule["any-of"];
    if (Array.isArray(anyOf)) {
      for (const item of anyOf) {
        if (typeof item === "string" && item) out.add(item);
      }
    }
  }
  return out;
}

export function rulesRequestIsOpen(rules: Iterable<Record<string, unknown>>): boolean {
  for (const r of rules) {
    if (r.rule === "milestone" && r["is-open"] === true) return true;
  }
  return false;
}

const GITHUB_HOSTNAMES = new Set(["github.com", "api.github.com"]);

export function inferRepoFromIssues(issues: Iterable<Record<string, unknown>>): string | null {
  for (const issue of issues) {
    for (const key of ["repository_url", "html_url"] as const) {
      const value = issue[key];
      if (typeof value !== "string" || !value) continue;
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        continue;
      }
      const host = (parsed.hostname ?? "").toLowerCase();
      if (!GITHUB_HOSTNAMES.has(host)) continue;
      const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
      let owner: string | undefined;
      let name: string | undefined;
      if (segments[0] === "repos" && segments.length >= 3) {
        owner = segments[1];
        name = segments[2];
      } else if (segments.length >= 2) {
        owner = segments[0];
        name = segments[1];
      }
      if (owner && name) return `${owner}/${name}`;
    }
  }
  return null;
}

export type OpenMilestonesFetcher = () => Set<string> | readonly string[];

export function makeOpenMilestonesResolver(
  fetcher: OpenMilestonesFetcher | null | undefined,
  issues: readonly Record<string, unknown>[],
  repo: string | null | undefined,
  defaultFetcher: (repo: string | null) => Set<string>,
): () => Set<string> {
  let cached: Set<string> | null = null;
  return (): Set<string> => {
    if (cached !== null) return cached;
    if (fetcher !== null && fetcher !== undefined) {
      try {
        const raw = fetcher();
        cached = new Set(Array.isArray(raw) ? raw : [...raw]);
      } catch {
        cached = new Set();
      }
    } else {
      const resolvedRepo = repo ?? inferRepoFromIssues(issues);
      cached = defaultFetcher(resolvedRepo);
    }
    return cached;
  };
}

export function evaluateMilestoneRuleInto(
  rule: Record<string, unknown>,
  issues: readonly Record<string, unknown>[],
  matched: Map<number, Record<string, unknown>>,
  helpers: {
    getOpenMilestones: () => Set<string>;
    isOpenIssue: (issue: Record<string, unknown>) => boolean;
    issueNumber: (issue: Record<string, unknown>) => number;
    milestoneName: (issue: Record<string, unknown>) => string;
  },
): void {
  if ("name" in rule) {
    const wanted = rule.name;
    if (typeof wanted !== "string" || !wanted) return;
    for (const issue of issues) {
      if (helpers.isOpenIssue(issue) && helpers.milestoneName(issue) === wanted) {
        matched.set(helpers.issueNumber(issue), issue);
      }
    }
    return;
  }

  if ("any-of" in rule) {
    const raw = rule["any-of"];
    if (!Array.isArray(raw) || raw.length === 0) return;
    const wantedSet = new Set(raw.filter((w): w is string => typeof w === "string" && Boolean(w)));
    if (wantedSet.size === 0) return;
    for (const issue of issues) {
      if (helpers.isOpenIssue(issue) && wantedSet.has(helpers.milestoneName(issue))) {
        matched.set(helpers.issueNumber(issue), issue);
      }
    }
    return;
  }

  if (rule["is-open"] === true) {
    const openSet = helpers.getOpenMilestones();
    if (openSet.size === 0) return;
    for (const issue of issues) {
      if (helpers.isOpenIssue(issue) && openSet.has(helpers.milestoneName(issue))) {
        matched.set(helpers.issueNumber(issue), issue);
      }
    }
  }
}
