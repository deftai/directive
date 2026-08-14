import { resolve } from "node:path";
import { cachedIssueLabels, extractIssueRef } from "../capacity/backfill.js";
import { classifyBucket, loadBucketMatchers } from "../policy/capacity.js";
import { restIssueView } from "../scm/gh-rest.js";

/** Read the labels for an issue reference. Returns null when they cannot be resolved. */
export type LabelReader = (repo: string, issueNumber: number) => ReadonlySet<string> | null;

export interface StampCompletionOptions {
  /**
   * Explicit label set for the completing brief. When provided it takes precedence
   * over any linked-issue lookup, keeping bucket resolution pure and network-free.
   */
  readonly labels?: Iterable<string>;
  /**
   * Injectable reader used to resolve labels from the brief's linked issue when no
   * explicit `labels` are supplied. Defaults to a cached-issue lookup (no network).
   * A `null` return signals a cache MISS and triggers the live fallback below.
   */
  readonly labelReader?: LabelReader;
  /**
   * Injectable fail-open fallback used ONLY on a cache miss (`labelReader` returned
   * `null`). Defaults to a single REST read via the scm shim (PRs excluded, #2246).
   * A `null` return leaves resolution on the `defaultBucket` fallback. Injected in
   * tests so the fallback path is exercised without a network call.
   */
  readonly liveLabelReader?: LabelReader;
  /** Session that ran scope:complete; check uses this to target xbrief/completed (#3357). */
  readonly completedSessionId?: string | null;
}

function normalizeLabels(labels: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const label of labels) {
    if (typeof label === "string" && label.trim().length > 0) {
      out.add(label);
    }
  }
  return out;
}

/** Extract label name strings from a raw REST/cache `labels` array. */
function labelsFromRaw(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) {
    return out;
  }
  for (const label of raw) {
    if (typeof label === "string" && label.length > 0) {
      out.add(label);
    } else if (typeof label === "object" && label !== null && !Array.isArray(label)) {
      const name = (label as Record<string, unknown>).name;
      if (typeof name === "string" && name.length > 0) {
        out.add(name);
      }
    }
  }
  return out;
}

/**
 * Fail-open live label read for a cache miss: a single REST GET through the scm
 * shim (`restIssueView`), with PRs excluded. Any error (or a PR ref) yields `null`
 * so resolution falls through to `defaultBucket` instead of crashing (#2246).
 */
function liveIssueLabels(repo: string, issueNumber: number): ReadonlySet<string> | null {
  try {
    const issue = restIssueView(repo, issueNumber);
    // The issues endpoint also returns PRs; a PR object carries `pull_request`.
    // Exclude PRs from label-based bucket resolution.
    if (issue.pull_request !== undefined) {
      return null;
    }
    return labelsFromRaw(issue.labels);
  } catch {
    return null;
  }
}

/**
 * Resolve the capacityBucket for a completing brief by matching its issue labels
 * against `capacityAllocation.buckets[].match.labels` (first declared match wins),
 * falling back to `defaultBucket` when nothing matches (#2237).
 */
function resolveCapacityBucket(
  plan: Record<string, unknown>,
  projectRoot: string,
  options: StampCompletionOptions,
): string {
  const root = resolve(projectRoot);
  const { matchers, default_bucket: defaultBucket } = loadBucketMatchers(root);

  let labels: ReadonlySet<string> | null = null;
  if (options.labels !== undefined) {
    labels = normalizeLabels(options.labels);
  } else {
    const [repo, issueNumber] = extractIssueRef(plan);
    if (repo !== null && issueNumber !== null) {
      const reader: LabelReader = options.labelReader ?? ((r, n) => cachedIssueLabels(root, r, n));
      labels = reader(repo, issueNumber);
      // Cache MISS (null) -- take the fail-open live fallback. A cache HIT (even an
      // empty set) stays the fast path and makes NO network call (#2246).
      if (labels === null) {
        const live: LabelReader = options.liveLabelReader ?? liveIssueLabels;
        labels = live(repo, issueNumber);
      }
    }
  }

  const [bucket] = classifyBucket(labels ?? new Set<string>(), matchers, defaultBucket);
  return bucket;
}

/** Stamp completedAt + label-matched capacityBucket onto a completing vBRIEF (#1419, #2237). */
export function stampCompletionMetadata(
  plan: Record<string, unknown>,
  projectRoot: string,
  timestamp: string,
  options: StampCompletionOptions = {},
): void {
  let metadata = plan.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    metadata = {};
    plan.metadata = metadata;
  }
  const meta = metadata as Record<string, unknown>;
  meta.completedAt = timestamp;
  const sessionId = options.completedSessionId?.trim() ?? "";
  if (sessionId.length > 0) {
    meta.completedSessionId = sessionId;
  }

  const existing = meta.capacityBucket;
  if (typeof existing === "string" && existing.trim().length > 0) {
    return;
  }

  const bucket = resolveCapacityBucket(plan, projectRoot, options);
  if (bucket.length > 0) {
    meta.capacityBucket = bucket;
  }
}
