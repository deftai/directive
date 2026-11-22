section: Fixed
- `deft pre-pr:run --project-root <dir>` now opens the private store under `<dir>` on every path (start, observe, evaluate, complete), so a run started in a worktree can be recorded from any cwd without `cd`. Relative `--reviewed-file` paths resolve against the same root; `--body-file` paths stay relative to the cwd. Without `--project-root`, nothing changes (#6902).
