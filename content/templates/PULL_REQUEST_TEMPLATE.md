## Summary

<!-- One-paragraph description of what this PR does and why. -->

## Changes

<!-- Bulleted list of key changes. -->

## vBRIEF References

<!-- If this PR implements scope vBRIEFs, list them (path relative to repo root):
- `vbrief/active/YYYY-MM-DD-slug.vbrief.json`
- `vbrief/pending/YYYY-MM-DD-slug.vbrief.json`
-->

## Checklist

- [ ] `task check` passes locally (validate + lint + test; see `coding/testing.md`)
- [ ] `CHANGELOG.md` has an `[Unreleased]` entry covering these changes
- [ ] All affected vBRIEFs pass `task vbrief:validate`
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) format
- [ ] No secrets or `.env` content in the diff
- [ ] `.premigrate.*` files are gitignored (if this PR followed a `task migrate:vbrief` run)
- [ ] New source files (`scripts/`, `src/`, `cmd/`, `*.py`, `*.go`) have corresponding tests in this PR

## Related Issues

<!-- Use closing keywords so GitHub auto-closes on squash merge:
Closes #N
Relates to #M
-->

## Testing

<!-- How was this verified? Commands run, platforms covered, edge cases exercised. -->
