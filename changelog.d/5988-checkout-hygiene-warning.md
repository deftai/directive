section: Added
- `scope:complete` now warns on stderr when a clone has more than 25 live linked worktrees (Directive's primary-checkout write checks slow down as they grow, #5920) or more than 100 local branches, and names the manual cleanup. Warn only: no exit code change, no refusal, no cleanup. Refs #5988.
