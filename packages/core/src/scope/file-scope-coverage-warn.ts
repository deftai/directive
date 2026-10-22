/**
 * Advisory in-brief file_scope coverage warn (#5736 Prefer-A Recut-1).
 * Warn-only: never writes file_scope; never lifts paths from issue/comment prose (#3835).
 * Coverage is durable fields already on the brief artifact (intended_placement.files,
 * acceptance clause artifact_path, item x-directive/artifact_path).
 */

export type FileScopeCoverageWarnInput = {
  readonly brief: unknown;
};

export type FileScopeCoverageWarnResult = {
  readonly ok: true;
  readonly warnings: readonly string[];
  readonly covered: readonly string[];
  readonly uncovered: readonly string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function collectDurableNamedPaths(brief: unknown): string[] {
  const root = asRecord(brief);
  if (root === null) return [];
  const plan = asRecord(root.plan);
  if (plan === null) return [];
  const out = new Set<string>();

  const metadata = asRecord(plan.metadata);
  if (metadata !== null) {
    const intended = asRecord(metadata.intended_placement);
    if (intended !== null) {
      for (const p of asStringList(intended.files)) out.add(p.replace(/\\/g, "/"));
    }
    const moduleBoundary = metadata.intended_placement
      ? asRecord(metadata.intended_placement)?.module_boundary
      : undefined;
    if (typeof moduleBoundary === "string" && moduleBoundary.trim().length > 0) {
      out.add(moduleBoundary.replace(/\\/g, "/"));
    }
  }

  const acceptance = asRecord(plan.acceptance);
  if (acceptance !== null && Array.isArray(acceptance.clauses)) {
    for (const clause of acceptance.clauses) {
      const c = asRecord(clause);
      if (c === null) continue;
      if (typeof c.artifact_path === "string" && c.artifact_path.trim().length > 0) {
        out.add(c.artifact_path.replace(/\\/g, "/"));
      }
    }
  }

  if (Array.isArray(plan.items)) {
    for (const item of plan.items) {
      const it = asRecord(item);
      if (it === null) continue;
      const artifact = it["x-directive/artifact_path"];
      if (typeof artifact === "string" && artifact.trim().length > 0) {
        out.add(artifact.replace(/\\/g, "/"));
      }
    }
  }

  return [...out].sort();
}

function collectFileScope(brief: unknown): string[] {
  const root = asRecord(brief);
  if (root === null) return [];
  const plan = asRecord(root.plan);
  if (plan === null) return [];
  const metadata = asRecord(plan.metadata);
  if (metadata === null) return [];
  const swarm = asRecord(metadata.swarm);
  if (swarm === null) return [];
  return asStringList(swarm.file_scope).map((p) => p.replace(/\\/g, "/"));
}

/**
 * Warn when durable brief-named paths are not covered by swarm.file_scope.
 * Never mutates the brief. Never reads issue/comment prose.
 */
export function evaluateFileScopeCoverageWarn(
  input: FileScopeCoverageWarnInput,
): FileScopeCoverageWarnResult {
  const named = collectDurableNamedPaths(input.brief);
  const fileScope = collectFileScope(input.brief);
  const scopeSet = new Set(fileScope);
  const uncovered = named.filter((p) => !scopeSet.has(p));
  const covered = named.filter((p) => scopeSet.has(p));
  const warnings =
    uncovered.length === 0
      ? []
      : [
          `advisory file_scope coverage warn (#5736): durable brief paths not in swarm.file_scope: ${uncovered.join(", ")}. Warn-only; do not write file_scope from this signal.`,
        ];
  return { ok: true, warnings, covered, uncovered };
}
