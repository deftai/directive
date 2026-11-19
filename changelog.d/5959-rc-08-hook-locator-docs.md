section: Changed
- OVPR docs revision **v261119**: hooks find Directive's hook file from any subfolder or worktree through a no-shell Node locator that stops at the top of the Git checkout; the payload's project root is that checkout top, never the nearest `package.json` (AC9.1, AC9.4).
