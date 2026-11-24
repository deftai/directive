section: Fixed
- Exact-word `commit` detection (including `-c`/`eval`/`env -S` payloads) and `git -C <absolute>` as sole chdir authority so lifecycle `$BIN` / path substring / prior `cd` no longer false-refuse named commits; opaque `$GIT commit` wrappers stay refused (#7273).
