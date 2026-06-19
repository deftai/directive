/** Shared parity fixture inputs for intake golden-diff (#1784). */

export const SAMPLE_ISSUE_BODY = [
  "## Summary",
  "Add widget support to the dashboard.",
  "",
  "## Acceptance Criteria",
  "- [ ] Widget renders in the sidebar",
  "- [ ] Widget exposes a click handler",
  "- [x] Spec doc updated",
].join("\n");

export const SAMPLE_ISSUE = {
  number: 500,
  title: "Widget support",
  url: "https://github.com/owner/repo/issues/500",
  body: SAMPLE_ISSUE_BODY,
  labels: [{ name: "enhancement" }],
} as const;

export const SAMPLE_VBRIEF = {
  plan: {
    title: "Emit me",
    narratives: { Description: "Hello world" },
  },
} as const;

export const PARITY_SCENARIO_NAMES = [
  "issue-ingest-build-vbrief",
  "issue-ingest-cross-refs",
  "issue-emit-render-body",
  "reconcile-classify",
  "candidates-validate-reject",
  "github-auth-invalid-mode",
] as const;

export type ParityScenarioName = (typeof PARITY_SCENARIO_NAMES)[number];
