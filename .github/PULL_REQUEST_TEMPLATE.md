## Summary

<!-- Brief description of what this PR does and why -->

## Related Issues

<!-- Active story (running brief in xbrief/active/): do not use Closes #N; the
     brief completes after merge and finalize closes the issue. Write Refs #N plus
     exactly one story line on its own line (#6316):
       deft-story: N        on the PR that completes the story
       deft-story-part: N   on any other product PR of the story
     task pr:check-closing-keywords -- --body-file <path> --write-story-line [--part]
     writes the line. Use Closes #N only for an issue with no active story, when
     its full DoD is met. -->

## Documentation impact

<!-- Closed enum. Rationale is quoted data and is never a gate input.
     change_class: add | change | withdraw | none
     surfaces: none OR comma-separated command:<id> | skill-trigger:<id> | help:<id> | docs-site:<page>
     `no user-doc impact` is refused when a registered command, skill, help key,
     or public docs-site page is added or removed. Same-PR rule: content/coding/docs.md (#447). -->

change_class: none
surfaces: none
rationale: "Replace this quoted sentence with the actual documentation-impact rationale."

## Checklist

- [ ] `/deft:change <name>` — proposed and explicitly confirmed (`yes`/`confirmed`/`approve`) before implementation (or N/A for <3 file changes; for solo projects, N/A only if not cross-cutting, architectural, or high-risk). Detector: `verify:scope-provenance` / `verify:intent-constraint`.
- [ ] `CHANGELOG.md` — added an entry under `[Unreleased]`, or a `changelog.d/<issue>-<slug>.md` fragment, as `plan.policy.changelog.mode` allows (or N/A for test-only / CI-only changes). A story that adds an entry lists its own fragment path in `file_scope`. Detector: `verify:changelog-unreleased` on `check:framework-source`.

## Post-Merge

After squash merge, confirm referenced issues actually closed via REST (`gh api repos/<owner>/<repo>/issues/<N>`). Squash merges can silently fail to process closing keywords (#167). If still open, close manually.

Repo-scoped ruleset enrollment for required context `Merge gate (task check)` is operator-owned (see `content/scm/github.md`). Validate the artifact-only skip path before flipping. Do not empty-PUT GitHub rulesets.
