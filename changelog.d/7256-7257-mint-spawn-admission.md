section: Fixed
- Spawn with a linked worktree cwd now reads active scope and the one-PR mint pair from that dest root, so a dest mint admits dest-cwd builders without a second primary mint (#7257).
- Dest spawn binding ignores the parent's DEFT_ACTIVE_SCOPE so a registered dest assignment is not refused as an env-pin conflict; worker writes still honor the pin (#7257).
- scope:record-approved-scope --manifest may write several distinct planId records into one shared worktree_path in a single typed mint; plan ids stay unique (#7256).
