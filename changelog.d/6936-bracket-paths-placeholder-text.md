section: Fixed
- `swarm:readiness`, `scope:decompose` and the scope-provenance fence now treat a `file_scope` path with brackets, such as the Next.js route `web/src/app/crm/pipeline/[id]/page.tsx`, as a concrete path: only `*` and `?` are glob characters, as in the matcher, so `[id]` matches only that literal file (#6936).
- Readiness no longer reads a file name or domain term as placeholder text: `placeholder`, `todo` and `tbd` count only as a whole line, a leading label (`TODO:`), a template token (`<placeholder>`) or a standalone `tbd`, never inside a path (#6929).
