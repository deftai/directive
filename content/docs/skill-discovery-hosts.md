# Multi-host skill discovery (#75)

Directive deposits **thin skill discovery pointers** so agent hosts that do not
scan `.agents/skills/` still auto-load the same consumer skill inventory.

## Canonical vs additional paths

| Path | Role |
|------|------|
| `.agents/skills/` | **Canonical** consumer discovery (landed with #94 / install `writeAgentsSkills`) |
| `.claude/skills/` | Claude Code |
| `.codex/skills/` | OpenAI Codex |
| `.github/skills/` | GitHub Copilot |
| `.cursor/skills/` | Cursor (when not fully covered by optional OpenPackage install) |

Additional host paths **mirror** the same thin `SKILL.md` inventory as
`.agents/skills/`. They do not fork independent skill bodies. Full skill text
lives under `.deft/core/skills/…` (or `.deft/core/SKILL.md` for the root
`deft` skill).

## Thin pointers only

Each deposited `SKILL.md` is a short frontmatter + `Read and follow: .deft/core/…`
line. Init/update **must not** copy full skill process docs into host skill dirs
(those rot on framework upgrade).

Windows: deposit uses ordinary file writes (contained projection). Elevated
symlinks are **not** required.

## When deposit runs

- `directive init` / greenfield scaffold — after `.agents/skills/`
- `directive update` / refresh — every refresh (idempotent rewrite of managed
  pointers when content drifts)

## Per-host opt-out

Typed policy: `plan.policy.hostSkillDiscovery`

```json
{
  "plan": {
    "policy": {
      "hostSkillDiscovery": {
        "claude": true,
        "cursor": true,
        "codex": true,
        "github": false
      }
    }
  }
}
```

- Default: all four residual hosts **enabled**
- Inspect: `deft policy:show --field=hostSkillDiscovery`
- Opt-out skips deposit for that host only (does not remove unrelated user files)

Distinct from `plan.policy.hostHooks` (hook JSON deposit, #2752).

## Relationship to #55 slash registration

| | **#75 skill discovery** | **#55 slash / commands** |
|--|-------------------------|---------------------------|
| Artifact | Host **skill** dirs (`…/skills/`) | Host **command/prompt** files (`…/commands/`, `…/prompts/`) |
| Product set | Existing consumer skill inventory | Locked product slash set (L2) |
| Content | Thin skill pointer `SKILL.md` | Thin command wrapper (~40–100 tok) |
| Deposit | This doc / `skill-discovery-deposit` | Epic children #3052–#3055 |

Do **not** treat slash completion as closing skill-path residual, or skill
deposit as registering slash commands.

## Relationship to OpenPackage

OpenPackage (#2462 / #2370) is an optional tiered pack install for some hosts.
It does **not** replace init/update multi-host skill discovery for the residual
matrix above. Close #75 only when residual host paths are deposited (or
explicitly opted out), not solely because OpenPackage exists.

## Implementation pointers

- Layouts + policy: `packages/core/src/init-deposit/skill-discovery-hosts.ts`
- Deposit: `packages/core/src/init-deposit/skill-discovery-deposit.ts`
- Shared inventory with `.agents/skills/`: `CONSUMER_SKILL_DISCOVERY_INVENTORY`
