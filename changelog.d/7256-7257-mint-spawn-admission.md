### Fixed

- Spawn with a linked worktree `cwd` now reads active scope and the one-PR mint pair from that dest root, so a dest mint admits dest-cwd builders without a second primary mint (#7257).
- `scope:record-approved-scope --manifest` may write several distinct `planId` records into one shared `worktree_path` in a single typed mint; plan ids stay unique (#7256).
