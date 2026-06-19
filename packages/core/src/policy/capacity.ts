import { loadProjectDefinition } from "../policy/resolve.js";

export const DEFAULT_CAPACITY_UNIT = "vbrief-count";
export const CAPACITY_UNIT_COST = "cost";
export const CAPACITY_UNITS = new Set([DEFAULT_CAPACITY_UNIT, CAPACITY_UNIT_COST]);
export const DEFAULT_CAPACITY_WINDOW_DAYS = 30;
export const DEFAULT_CAPACITY_ENFORCEMENT = "advise";
export const CAPACITY_ENFORCEMENTS = new Set(["advise", "enforce"]);
export const DEFAULT_CAPACITY_MIN_SAMPLE_SIZE = 20;
export const DEFAULT_EPIC_ESTIMATE = 3;
export const DEFAULT_EPIC_STALENESS_DAYS = 30;
export const CAPACITY_TARGET_SUM_TOLERANCE = 1e-6;

export interface CapacityBucket {
  readonly bucket_id: string;
  readonly target: number;
}

export interface CapacityAllocation {
  readonly unit: string;
  readonly window_days: number;
  readonly enforcement: string;
  readonly min_sample_size: number;
  readonly buckets: readonly CapacityBucket[];
  readonly default_bucket: string;
  readonly default_epic_estimate: number;
  readonly epic_staleness_days: number;
  readonly source: "typed" | "default" | "default-on-error";
  readonly error: string | null;
  readonly configured: boolean;
}

function isNumber(value: unknown): boolean {
  return typeof value === "number" && !Number.isNaN(value) && typeof value !== "boolean";
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function defaultCapacityAllocation(
  source: CapacityAllocation["source"],
  error: string | null = null,
): CapacityAllocation {
  return {
    unit: DEFAULT_CAPACITY_UNIT,
    window_days: DEFAULT_CAPACITY_WINDOW_DAYS,
    enforcement: DEFAULT_CAPACITY_ENFORCEMENT,
    min_sample_size: DEFAULT_CAPACITY_MIN_SAMPLE_SIZE,
    buckets: [],
    default_bucket: "",
    default_epic_estimate: DEFAULT_EPIC_ESTIMATE,
    epic_staleness_days: DEFAULT_EPIC_STALENESS_DAYS,
    source,
    error,
    configured: false,
  };
}

function validateCapacityBuckets(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const buckets = value.buckets;
  if (!Array.isArray(buckets) || buckets.length === 0) {
    errors.push("plan.policy.capacityAllocation.buckets must be a non-empty array");
    return errors;
  }

  const ids: string[] = [];
  let total = 0;
  for (let idx = 0; idx < buckets.length; idx += 1) {
    const bucket = buckets[idx];
    if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) {
      errors.push(`plan.policy.capacityAllocation.buckets[${idx}] must be an object`);
      continue;
    }
    const rec = bucket as Record<string, unknown>;
    const bucketId = rec.id;
    if (typeof bucketId !== "string" || bucketId.trim().length === 0) {
      errors.push(`plan.policy.capacityAllocation.buckets[${idx}].id must be a non-empty string`);
    } else {
      ids.push(bucketId);
    }
    const target = rec.target;
    if (!isNumber(target)) {
      errors.push(
        `plan.policy.capacityAllocation.buckets[${idx}].target must be a number; got ${String(target)}`,
      );
    } else if (Number(target) < 0 || Number(target) > 1) {
      errors.push(
        `plan.policy.capacityAllocation.buckets[${idx}].target must be between 0.0 and 1.0; got ${String(target)}`,
      );
    } else {
      total += Number(target);
    }
  }

  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort();
  if (duplicates.length > 0) {
    errors.push(
      `plan.policy.capacityAllocation.buckets ids must be unique; duplicates: ${JSON.stringify(duplicates)}`,
    );
  }

  if (ids.length > 0 && Math.abs(total - 1.0) > CAPACITY_TARGET_SUM_TOLERANCE) {
    errors.push(
      `plan.policy.capacityAllocation.buckets targets must sum to 1.0; got ${total.toFixed(6)}`,
    );
  }

  const defaultBucket = value.defaultBucket;
  if (defaultBucket !== undefined && defaultBucket !== null) {
    if (typeof defaultBucket !== "string") {
      errors.push("plan.policy.capacityAllocation.defaultBucket must be a string");
    } else if (!ids.includes(defaultBucket)) {
      errors.push(
        `plan.policy.capacityAllocation.defaultBucket '${defaultBucket}' must match a declared bucket id`,
      );
    }
  }
  return errors;
}

/** Validate a plan.policy.capacityAllocation payload. */
export function validateCapacityAllocation(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [
      `plan.policy.capacityAllocation must be an object; got ${typeof value} (${String(value)})`,
    ];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];

  const unit = rec.unit ?? DEFAULT_CAPACITY_UNIT;
  if (typeof unit !== "string" || !CAPACITY_UNITS.has(unit)) {
    errors.push(
      `plan.policy.capacityAllocation.unit must be one of ${JSON.stringify([...CAPACITY_UNITS].sort())}; got ${String(unit)}`,
    );
  }

  const enforcement = rec.enforcement ?? DEFAULT_CAPACITY_ENFORCEMENT;
  if (typeof enforcement !== "string" || !CAPACITY_ENFORCEMENTS.has(enforcement)) {
    errors.push(
      `plan.policy.capacityAllocation.enforcement must be one of ${JSON.stringify([...CAPACITY_ENFORCEMENTS].sort())}; got ${String(enforcement)}`,
    );
  }

  if (!("window" in rec)) {
    errors.push(
      "plan.policy.capacityAllocation.window is required (trailing accounting window in days)",
    );
  } else if (!isPositiveInt(rec.window)) {
    errors.push(
      `plan.policy.capacityAllocation.window must be a positive integer (days); got ${String(rec.window)}`,
    );
  }

  if ("minSampleSize" in rec) {
    const mss = rec.minSampleSize;
    if (typeof mss !== "number" || !Number.isInteger(mss) || mss < 0) {
      errors.push(
        `plan.policy.capacityAllocation.minSampleSize must be a non-negative integer; got ${String(mss)}`,
      );
    }
  }

  if ("defaultEpicEstimate" in rec && !isPositiveInt(rec.defaultEpicEstimate)) {
    errors.push(
      `plan.policy.capacityAllocation.defaultEpicEstimate must be a positive integer; got ${String(rec.defaultEpicEstimate)}`,
    );
  }

  if ("epicStalenessDays" in rec && !isPositiveInt(rec.epicStalenessDays)) {
    errors.push(
      `plan.policy.capacityAllocation.epicStalenessDays must be a positive integer; got ${String(rec.epicStalenessDays)}`,
    );
  }

  errors.push(...validateCapacityBuckets(rec));
  return errors;
}

function getPolicyBlock(data: Record<string, unknown>): Record<string, unknown> {
  const plan = data.plan;
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    const policy = (plan as Record<string, unknown>).policy;
    if (typeof policy === "object" && policy !== null && !Array.isArray(policy)) {
      return policy as Record<string, unknown>;
    }
  }
  return {};
}

/** Resolve plan.policy.capacityAllocation from PROJECT-DEFINITION. */
export function resolveCapacityAllocation(projectRoot: string): CapacityAllocation {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return defaultCapacityAllocation("default", err);
  }

  const policyBlock = getPolicyBlock(data);
  if (!("capacityAllocation" in policyBlock)) {
    return defaultCapacityAllocation("default");
  }

  const raw = policyBlock.capacityAllocation;
  const validationErrors = validateCapacityAllocation(raw);
  if (
    validationErrors.length > 0 ||
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return defaultCapacityAllocation(
      "default-on-error",
      validationErrors[0] ?? "capacityAllocation must be an object",
    );
  }

  const rec = raw as Record<string, unknown>;
  const bucketsRaw = rec.buckets;
  const buckets: CapacityBucket[] = [];
  if (Array.isArray(bucketsRaw)) {
    for (const bucket of bucketsRaw) {
      if (typeof bucket === "object" && bucket !== null && !Array.isArray(bucket)) {
        const b = bucket as Record<string, unknown>;
        if (typeof b.id === "string" && isNumber(b.target)) {
          buckets.push({ bucket_id: b.id, target: Number(b.target) });
        }
      }
    }
  }

  const defaultBucket: string = typeof rec.defaultBucket === "string" ? rec.defaultBucket : "";

  return {
    unit: typeof rec.unit === "string" ? rec.unit : DEFAULT_CAPACITY_UNIT,
    window_days: Number(rec.window),
    enforcement:
      typeof rec.enforcement === "string" ? rec.enforcement : DEFAULT_CAPACITY_ENFORCEMENT,
    min_sample_size:
      typeof rec.minSampleSize === "number" && Number.isInteger(rec.minSampleSize)
        ? rec.minSampleSize
        : DEFAULT_CAPACITY_MIN_SAMPLE_SIZE,
    buckets,
    default_bucket: defaultBucket,
    default_epic_estimate:
      typeof rec.defaultEpicEstimate === "number" && Number.isInteger(rec.defaultEpicEstimate)
        ? rec.defaultEpicEstimate
        : DEFAULT_EPIC_ESTIMATE,
    epic_staleness_days:
      typeof rec.epicStalenessDays === "number" && Number.isInteger(rec.epicStalenessDays)
        ? rec.epicStalenessDays
        : DEFAULT_EPIC_STALENESS_DAYS,
    source: "typed",
    error: null,
    configured: buckets.length > 0,
  };
}

export interface BucketMatcher {
  readonly bucket_id: string;
  readonly labels: ReadonlySet<string>;
}

/** Return ordered matchers + default_bucket from PROJECT-DEFINITION raw match.labels. */
export function loadBucketMatchers(projectRoot: string): {
  matchers: BucketMatcher[];
  default_bucket: string;
} {
  const [data] = loadProjectDefinition(projectRoot);
  const matchers: BucketMatcher[] = [];
  if (data === null) {
    return { matchers, default_bucket: "" };
  }

  const policyBlock = getPolicyBlock(data);
  const cap = policyBlock.capacityAllocation;
  if (typeof cap !== "object" || cap === null || Array.isArray(cap)) {
    return { matchers, default_bucket: "" };
  }

  const rec = cap as Record<string, unknown>;
  const buckets = rec.buckets;
  if (Array.isArray(buckets)) {
    for (const bucket of buckets) {
      if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) {
        continue;
      }
      const b = bucket as Record<string, unknown>;
      const bucketId = b.id;
      if (typeof bucketId !== "string" || bucketId.trim().length === 0) {
        continue;
      }
      matchers.push({
        bucket_id: bucketId.trim(),
        labels: new Set(matchLabels(b.match)),
      });
    }
  }

  const defaultBucket = rec.defaultBucket;
  return {
    matchers,
    default_bucket: typeof defaultBucket === "string" ? defaultBucket : "",
  };
}

function matchLabels(match: unknown): string[] {
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    return [];
  }
  const labels = (match as Record<string, unknown>).labels;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
    return [];
  }
  const anyOf = (labels as Record<string, unknown>)["any-of"];
  if (!Array.isArray(anyOf)) {
    return [];
  }
  return anyOf.filter((x): x is string => typeof x === "string" && x.length > 0);
}

export const SOURCE_MATCH = "match";
export const SOURCE_DEFAULT = "default";

/** Return (bucket_id, source) for an issue's label set. */
export function classifyBucket(
  issueLabels: ReadonlySet<string>,
  matchers: readonly BucketMatcher[],
  defaultBucket: string,
): [string, string] {
  for (const matcher of matchers) {
    for (const label of matcher.labels) {
      if (issueLabels.has(label)) {
        return [matcher.bucket_id, SOURCE_MATCH];
      }
    }
  }
  return [defaultBucket, SOURCE_DEFAULT];
}
