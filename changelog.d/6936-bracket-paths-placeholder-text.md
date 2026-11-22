section: Fixed
- `swarm:readiness`, `scope:decompose` and the scope-provenance fence now accept Next.js dynamic-route paths (`[id]`) in `file_scope` as concrete paths. Brackets match literally; only `*` and `?` are glob characters (#6936).
- Readiness no longer reads a file name or domain term as placeholder text: `placeholder`, `todo` and `tbd` count only as a whole line, a leading label, a template token or a standalone `tbd` (#6929).
