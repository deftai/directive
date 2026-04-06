## Summary

<!-- Brief description of what this PR does and why -->

## Related Issues

<!-- Use closing keywords so GitHub auto-closes issues on merge:
     Closes #42, Fixes #51
     Place "Closes #N" in this section AND in the PR title/squash commit subject
     for maximum reliability. -->

## Checklist

- [ ] `/deft:change <name>` — proposed and explicitly confirmed (`yes`/`confirmed`/`approve`) before implementation (or N/A for <3 file changes; for solo projects, N/A only if not cross-cutting, architectural, or high-risk)
- [ ] `CHANGELOG.md` — added entry under `[Unreleased]` (or N/A for test-only / CI-only changes)
- [ ] `ROADMAP.md` — updated if this closes a tracked issue (or N/A)
- [ ] Tests pass locally

## Post-Merge

- [ ] **Verify issue auto-close**: After squash merge, confirm referenced issues actually closed — `gh issue view <N> --json state --jq .state`. Squash merges can silently fail to process closing keywords (#167). If still open, close manually: `gh issue close <N> --comment "Closed by #<PR> (squash merge — auto-close did not trigger)"`
- [ ] Enable branch protection on `master` requiring CI status check (one-time setup, see #57)
