# Hooks fixture corpus (#2950)

Shared **host × OS × tool** golden cases for PreToolUse classification.

## Coupled surface (TPA thrash cluster)

Hooks classification and permission decisions form a **coupled surface**. When you change host payload handling or write-path gates, plan these three together — do not land a primary-only drive-by:

1. `packages/core/src/hooks/dispatcher.ts` (orchestration + policy)
2. `packages/core/src/hooks/dispatcher.test.ts` (core policy cases)
3. `packages/cli/src/hook-dispatch.test.ts` (CLI stdin / host adapter)

Pure parse/classify lives under `packages/core/src/hooks/classify/`. Prefer:

1. **Add or update a fixture** here for the new host edge case.
2. Fix the pure classifier (`classify/`) when the bug is identity/path shape.
3. Fix the dispatcher only for policy / ritual / scope / permission emission.
4. Keep CLI tests thin over `parseHookStdin` + `decideHook` + `renderHostDecision`.

New host edge bugs should land as a fixture first, then the classifier (or policy) fix.

## Layout

```
fixtures/
  cases.ts          # typed corpus + helpers
  cursor/
    win32/          # Windows-flavored path spellings
    posix/          # POSIX path spellings
```

Each case records: `id`, `host`, `os`, `tool`, `regression` (issue tags), `raw` or `payload`, and expected classification fields.
