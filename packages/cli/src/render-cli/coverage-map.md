# Wave 8.5 s6 coverage map — pack/spec/render/codebase CLI tests

Python pytest file → vitest spec / disposition. Refs #1838 #1530.

| Python test | Disposition | TS target |
| --- | --- | --- |
| `tests/cli/test_capacity_backfill.py` | **deft-ts spec** | `packages/cli/src/render-cli/capacity-cli.test.ts` (+ `packages/core/src/capacity/backfill.test.ts` module) |
| `tests/cli/test_capacity_show.py` | **deft-ts spec** | `packages/cli/src/render-cli/capacity-cli.test.ts` (+ `packages/core/src/capacity/show.test.ts` module) |
| `tests/cli/test_codebase_default_extractor.py` | **deft-ts spec** | `packages/cli/src/render-cli/codebase-cli.test.ts` (+ `packages/core/src/codebase/provider.test.ts` extractor cases) |
| `tests/cli/test_codebase_projection_registry.py` | **deft-ts spec** | `packages/cli/src/render-cli/codebase-cli.test.ts` (+ `packages/core/src/codebase/projection-registry.test.ts` existing-coverage) |
| `tests/cli/test_codebase_provider.py` | **deft-ts spec** | `packages/cli/src/render-cli/codebase-cli.test.ts` (+ `packages/core/src/codebase/provider.test.ts` existing-coverage) |
| `tests/cli/test_framework_commands.py` | **deft-ts spec** | `packages/cli/src/render-cli/render-surfaces-cli.test.ts` (+ `packages/core/src/render/render.test.ts` framework-commands) |
| `tests/cli/test_framework_doctor.py` | **deft-ts spec** | `packages/cli/src/render-cli/render-surfaces-cli.test.ts` (+ `packages/core/src/doctor/*.test.ts` existing-coverage) |
| `tests/cli/test_framework_doctor_prose.py` | existing-coverage | `packages/core/src/doctor/*.test.ts` (command-surface / fail-detail prose) |
| `tests/cli/test_pack_migrate_patterns.py` | existing-coverage | Python-only migrate oracles via `deft-ts pack-migrate-patterns` (Wave 9 retire with script delete) |
| `tests/cli/test_pack_migrate_rules.py` | existing-coverage | Python-only migrate oracles via `deft-ts pack-migrate-rules` |
| `tests/cli/test_pack_migrate_strategies.py` | existing-coverage | Python-only migrate oracles via `deft-ts pack-migrate-strategies` |
| `tests/cli/test_pack_migrate_swarm_spec.py` | existing-coverage | Python-only migrate oracles via `deft-ts pack-migrate-swarm-spec` |
| `tests/cli/test_pack_render.py` | **deft-ts spec** | `packages/cli/src/render-cli/pack-cli.test.ts` (+ `packages/core/src/packs/pack-render.test.ts` existing-coverage) |
| `tests/cli/test_packs_slice.py` | **deft-ts spec** | `packages/cli/src/render-cli/pack-cli.test.ts` (+ `packages/core/src/packs/packs-slice.test.ts` existing-coverage) |
| `tests/cli/test_project.py` | existing-coverage | Interactive `run.py cmd_project` — no deft-ts verb; `packages/core/src/vbrief-build/*.test.ts` covers generation paths |
| `tests/cli/test_project_context.py` | existing-coverage | `packages/core/src/slice/project-context.test.ts` |
| `tests/cli/test_project_render.py` | existing-coverage | `packages/core/src/render/render.test.ts` (`renderProjectDefinition`) |
| `tests/cli/test_project_user_defaults.py` | existing-coverage | `packages/core/src/vbrief-build/project-definition-io.test.ts` |
| `tests/cli/test_roadmap_render.py` | **deft-ts spec** | `packages/cli/src/render-cli/render-surfaces-cli.test.ts` (+ `packages/core/src/render/render.test.ts` roadmap) |
| `tests/cli/test_spec.py` | existing-coverage | `packages/core/src/render/render.test.ts` (`validateSpec`, `renderSpec`) |
| `tests/cli/test_spec_render.py` | existing-coverage | `packages/core/src/render/render.test.ts` + `packages/cli/src/render-parity.ts` PARITY_CASES |
| `tests/cli/test_spec_sizing.py` | existing-coverage | Interactive `run.py cmd_spec` — `packages/core/src/vbrief-build/speckit.test.ts` / routing tests |

## Notes

- All Python files stay in-tree (additive wave); Wave 9 deletes pytest after bake.
- New specs invoke `node packages/cli/dist/bin.js <verb>` via `render-cli/deft-ts-runner.ts`.
- `task ts:check-lane` is the acceptance gate for this story.
