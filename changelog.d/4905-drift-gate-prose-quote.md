section: Fixed
- `verify:xbrief-drift` no longer fails a canonical brief whose prose only quotes the legacy `x-vbrief` prefix (narratives, ingested comments, contract text, escaped quotes). It now flags only a JSON string value that starts with the prefix, such as a reference `type`, which still fails. Pre-commit keeps running the gate with `--staged` and no allow-list (#4905).
