section: Fixed
- `verify:class-checks` skips itself on `merge_group` runs, like its sibling checks, so a pure scope-mint PR queued behind a product PR no longer fails class 4 on the combined queue diff. It runs on the PR head instead; the skip notices for the two change-set checks now give that reason (#7147).
