section: Changed
- `directive upgrade` on an old-layout project now lists the files Git reports as modified or untracked under `.deft/core` (the first 20, then a count) before it removes that folder, so you can save them first. It adds no prompt and no refusal. Closes #6002.
- `task upgrade` and `task uninstall` now describe themselves as retired and name `directive upgrade` / `directive uninstall`. Refs #6022.
