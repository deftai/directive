# OpenPackage distribution (maintainer)

Cross-harness tiered skill packaging for Deft Directive consumer content ([#2462](https://github.com/deftai/directive/issues/2462), epic [#2369](https://github.com/deftai/directive/issues/2369)).

| Path | Role |
| --- | --- |
| `deft-tiers.json` | Machine-readable tier → skill mapping (source of truth) |
| `deft-directive-skills/` | OpenPackage package (`openpackage.yml`, `skills/`, thin `AGENTS.md`) |
| `sync-skills.mjs` | Copy `content/skills/` into the package before `opkg install` |
| `measure-daily-core-frontmatter.mjs` | Spike acceptance: daily-core Cursor frontmatter ≤ 2080 B |

Spike background: [`docs/analysis/2026-07-13-2370-packaging-cross-harness-spike.md`](../../docs/analysis/2026-07-13-2370-packaging-cross-harness-spike.md).
