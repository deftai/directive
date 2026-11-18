section: Fixed
- `swarm:finalize-cohort` no longer refuses its own lifecycle commit with an R7 "unrelated xBRIEF path" error when the sweep runs in a temporary checkout; unrelated xBRIEF paths are still refused. Refs #6601.
- `swarm:finalize-cohort` productPullRequest stamp refusals now say whether the brief is already bound to another PR (naming it) or could not be read or written. Refs #6601.
