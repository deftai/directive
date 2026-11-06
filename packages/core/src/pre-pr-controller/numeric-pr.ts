import type { RunGhFn } from "../pr-merge-readiness/types.js";

/**
 * Resolve a numeric PR number without parsing opaque GraphQL `node_id` (#6071).
 * Order: explicit option → GITHUB_PR_NUMBER env → commits/<sha>/pulls REST.
 * ⊗ Digits from `prNodeId` (e.g. PR_kwDO…123) — those are not PR numbers.
 */
export function resolveNumericPrNumber(input: {
  readonly explicit?: number | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly repo: string;
  readonly headSha: string;
  readonly runGh?: RunGhFn;
  /** Ignored on purpose — opaque GraphQL ids are never numeric PR sources. */
  readonly prNodeId?: string | null;
}): number | null {
  void input.prNodeId;
  if (typeof input.explicit === "number" && Number.isFinite(input.explicit) && input.explicit > 0) {
    return Math.trunc(input.explicit);
  }
  const envRaw = (input.env ?? process.env).GITHUB_PR_NUMBER?.trim() ?? "";
  if (/^\d+$/.test(envRaw)) {
    const n = Number(envRaw);
    if (n > 0) return n;
  }
  const sha = input.headSha.trim();
  if (sha.length === 0 || input.runGh === undefined) return null;
  const rc = input.runGh(["gh", "api", `repos/${input.repo}/commits/${sha}/pulls`]);
  if (rc.returncode !== 0 || !rc.stdout.trim()) return null;
  try {
    const payload = JSON.parse(rc.stdout) as unknown;
    if (!Array.isArray(payload) || payload.length === 0) return null;
    const first = payload[0];
    if (first === null || typeof first !== "object" || Array.isArray(first)) return null;
    const num = (first as Record<string, unknown>).number;
    return typeof num === "number" && Number.isFinite(num) && num > 0 ? Math.trunc(num) : null;
  } catch {
    return null;
  }
}
