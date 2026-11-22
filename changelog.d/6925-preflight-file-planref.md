section: Fixed
- `xbrief:preflight` now resolves a `file://` planRef the way `xbrief:validate` does: the parent-lineage check drops the scheme through the same helper before its exact-path, absolute-path and traversal checks, so a story with `"planRef": "file://proposed/<epic>.xbrief.json"` no longer fails with `parent not found at .../xbrief/file:/proposed/...` (#6925).
