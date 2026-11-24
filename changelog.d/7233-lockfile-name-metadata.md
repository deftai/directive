section: Fixed
- A `directive upgrade` in a linked worktree is no longer refused by scope-cover when npm only rewrote the lockfile's top-level folder name. A name the app declares in the lockfile still counts as the app's own change (#7233).
