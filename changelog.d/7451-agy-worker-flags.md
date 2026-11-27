section: Fixed
- fix(hooks): the agy worker launch forms `agy -i`, `--prompt-interactive` and `--dangerously-skip-permissions` were not classified as launcher argv, so they skipped the dest gate; they are now denied without a dest worktree like `agy -p` (#7451).
