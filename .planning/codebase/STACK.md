# Historical Codebase Stack Note

Status: historical planning artifact.

This file is not the current technology inventory.

Current references:

- `README.md` for user-facing platform and installer requirements (OVPR npm / `directive`).
- `Taskfile.yml` and `tasks/*.yml` for the command graph.
- `.github/workflows/` and `.githooks/` for CI and local enforcement.
- `docs/ARCHITECTURE.md` and `docs/FILES.md` for the current module and file map.
- `go.mod` may remain as an archaeology husk; `cmd/deft-install/` is **deleted** (AC10.10) — do not teach it as current.

The old contents named obsolete version values and described Markdown as the
whole product. The current implementation is a Taskfile-first framework with
agent guidance, vBRIEF metadata, a TypeScript/Node engine, OVPR npm packages,
content packs, local cache/triage workflows, and CI/release automation. The Go
installer is deleted.
