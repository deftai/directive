/**
 * C3 live-procedure exclusion declaration (#3602 / #3899).
 *
 * History, examples, and prohibitions are skipped by this list, not by
 * matching prose patterns. A file that names a deleted Python script in
 * order to forbid treating it as a live path must appear here as
 * `prohibition` or C3 will mis-fire.
 */

export type LiveProcedureExclusionKind = "history" | "example" | "prohibition";

export interface LiveProcedureExclusion {
  /** POSIX path relative to a flattened consumer deposit root. */
  readonly path: string;
  readonly kind: LiveProcedureExclusionKind;
  readonly reason: string;
}

export const LIVE_PROCEDURE_EXCLUSIONS: readonly LiveProcedureExclusion[] = [
  {
    path: "scm/github.md",
    kind: "prohibition",
    reason:
      "Names deleted Python scripts to forbid treating them as live implementation paths (#2022).",
  },
  {
    path: "UPGRADING.md",
    kind: "history",
    reason: "Migration history of Python helpers on pinned pre-Python-free releases.",
  },
  {
    path: "deployments/aws/via-elastic-beanstalk.md",
    kind: "example",
    reason: "Consumer AWS sample `scripts/create_admin.py` is not a deposit helper.",
  },
  {
    path: "conventions/machine-generated-banner.md",
    kind: "history",
    reason:
      "Registry of historical Python writers that produced the banner; not a live consumer procedure.",
  },
  {
    path: "docs/BROWNFIELD.md",
    kind: "history",
    reason: "Brownfield migration history of the Python migrator on pinned releases.",
  },
];

const EXCLUSION_PATHS = new Set(LIVE_PROCEDURE_EXCLUSIONS.map((entry) => entry.path));

export function isDeclaredLiveProcedureExclusion(relativePath: string): boolean {
  return EXCLUSION_PATHS.has(relativePath.replace(/\\/g, "/"));
}
