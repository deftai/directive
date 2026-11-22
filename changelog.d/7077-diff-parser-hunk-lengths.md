section: Fixed
- fix(forward-coverage): `parseUnifiedDiffAddedLines` tracks hunk lengths, so an added line starting with `++ ` no longer hides later added lines from `verify:forward-coverage` and class 2 of `verify:class-checks`; presentation coverage passes class 2 the added lines of its own snapshots (#7077).
