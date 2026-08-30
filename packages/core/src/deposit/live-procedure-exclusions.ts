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
  {
    path: "languages/python.md",
    kind: "example",
    reason: "Python language pack names consumer application files, not deposit helpers.",
  },
  {
    path: "languages/kotlin.md",
    kind: "example",
    reason: "Kotlin stdlib `run` scoping function is not the deposit Python launcher.",
  },
  {
    path: "deployments/aws/via-lambda.md",
    kind: "example",
    reason: "AWS Lambda sample `src/app.py` is a consumer application, not a deposit helper.",
  },
  {
    path: "deployments/fly-io/via-dockerfile.md",
    kind: "example",
    reason: "Fly.io sample `app.py` / `manage.py` are consumer application files.",
  },
  {
    path: "coding/toolchain.md",
    kind: "example",
    reason: "Cites framework test paths that pin the toolchain contract; not a live helper.",
  },
  {
    path: "coding/testing.md",
    kind: "example",
    reason: "Documents `_test.py` naming for consumer Python tests, not a deposit helper.",
  },
  {
    path: "contracts/deterministic-questions.md",
    kind: "example",
    reason: "Cites the contract's own test path; not a live consumer helper.",
  },
  {
    path: "conventions/task-caching.md",
    kind: "example",
    reason: "Cites framework tests that pin task-caching; not a live helper.",
  },
  {
    path: "events/README.md",
    kind: "history",
    reason: "Maintainer event-registry history naming retired Python writers and their tests.",
  },
  {
    path: "templates/agents-entry.placeholders.md",
    kind: "example",
    reason: "Cites the agents-entry contract test; not a live helper.",
  },
  {
    path: "templates/swarm-greptile-poller-prompt.md",
    kind: "example",
    reason: "Cites the poller-template contract test; not a live helper.",
  },
  {
    path: "verification/plan-checking.md",
    kind: "example",
    reason: "Swarm-spec example names `tests/test_auth.py` as consumer test layout.",
  },
  {
    path: "swarm/swarm.md",
    kind: "example",
    reason: "Swarm-spec example names `src/auth.py` / `tests/test_auth.py` as consumer files.",
  },
  {
    path: "skills/deft-directive-setup/SKILL.md",
    kind: "example",
    reason: "Setup skill Python example names `src/ui.py` as a consumer application file.",
  },
];

const EXCLUSION_PATHS = new Set(LIVE_PROCEDURE_EXCLUSIONS.map((entry) => entry.path));

export function isDeclaredLiveProcedureExclusion(relativePath: string): boolean {
  return EXCLUSION_PATHS.has(relativePath.replace(/\\/g, "/"));
}
