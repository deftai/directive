section: Fixed
- Begin waits briefly for the story-binding store lock, rolls back a just-created attempt if the wait fails, repair-admits an orphan active attempt that still lacks a binding and has no worker, and splits DENY_DUPLICATE_ACTIVE hints into binding-repair / pre-cancel / inspect (#7274).
