section: Fixed
- Claude Code hooks now run from any subfolder or worktree. The hook entry finds the top of the Git checkout the agent is in and runs that checkout's own Directive, so a `cd` into a workspace package or a Claude worktree no longer skips the check; automatic setup rewrites the old entries (#5959, #6594).
