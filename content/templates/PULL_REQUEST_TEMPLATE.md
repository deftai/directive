## Summary

<!-- One-paragraph description of what this PR does and why. -->

## Changes

<!-- Bulleted list of key changes. -->

## vBRIEF References

<!-- If this PR implements scope vBRIEFs, list them (path relative to repo root):
- `vbrief/active/YYYY-MM-DD-slug.vbrief.json`
- `vbrief/pending/YYYY-MM-DD-slug.vbrief.json`
-->

## Documentation impact

<!-- Closed enum. Rationale is quoted data and is never a gate input.
     change_class: add | change | withdraw | none
     surfaces: none OR comma-separated command:<id> | skill-trigger:<id> | help:<id> | docs-site:<page>
     `no user-doc impact` is refused when a registered command, skill, help key,
     or public docs-site page is added or removed. Same-PR rule: coding/docs.md (#447). -->

change_class: none
surfaces: none
rationale: "Replace this quoted sentence with the actual documentation-impact rationale."

## Checklist

- [ ] Prefer `deft check`; else `task deft:check` on an include-only consumer. One gate, not two runs (validate + lint + test; see `coding/testing.md`)
- [ ] Changelog entry covering these changes: a line under `CHANGELOG.md` `[Unreleased]`, or a `changelog.d/<issue>-<slug>.md` fragment, as `plan.policy.changelog.mode` allows; a story that adds an entry lists its own fragment path in `file_scope`
- [ ] All affected vBRIEFs pass `task vbrief:validate`
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) format
- [ ] No secrets or `.env` content in the diff
- [ ] `.premigrate.*` files are gitignored (if this PR followed a `task migrate:vbrief` run)
- [ ] New source files (`scripts/`, `src/`, `cmd/`, `*.py`, `*.go`) have corresponding tests in this PR

## Related Issues

<!-- Active story (running brief in xbrief/active/): do not use Closes #N; the
brief completes after merge and finalize closes the issue. Write Refs #N plus
exactly one story line on its own line (#6316):
  deft-story: N        on the PR that completes the story
  deft-story-part: N   on any other product PR of the story
task pr:check-closing-keywords -- --body-file <path> --write-story-line [--part]
writes the line. Use Closes #N only for an issue with no active story, when its
full DoD is met. Relates to #M for context.
-->

## Testing

<!-- How was this verified? Commands run, platforms covered, edge cases exercised. -->
