section: Fixed
- fix(orphan-active): the pending lifecycle-PR scan of `verify:orphan-active` starts no new forge request once the run deadline (start time plus the existing budget) is reached, keeps every shipped verdict and prints a cut-short line, so many open PRs cannot drag it far past its budget (#6899).
