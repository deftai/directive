section: Fixed
- `pr:wait-mergeable-and-merge`: a PR that conflicts with its base is now reported as `base-conflict` (exit 1), with the base branch and the merge-or-rebase fix, instead of `absent-required` or `cap-reached`. The verb reads `pulls/<N>` once after those two monitor outcomes; any other merge state keeps today's report (#6467).
