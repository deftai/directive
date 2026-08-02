# Opt out with `.no-deft-directive`

Some projects should not use Deft Directive. Use a **root file flag** so tools and agents stop offering install, session ritual, and setup.

Tracker: [#2926](https://github.com/deftai/directive/issues/2926).

## Filename and location

```text
.no-deft-directive
```

- **Exact name:** lowercase `.no-deft-directive`
- **Location:** project / workspace **root only** (the root the agent or CLI opened)
- **Content:** empty file or a short `#` comment. Presence is the flag. No schema.

~ Commit the flag. Opt-out is a project decision other clones should see.

## Behavior

| Condition | Behavior |
|-----------|----------|
| Flag **present** | Directive **off** for this project. Do not install. Do not run session ritual (CLI `session:start` **and** installed host SessionStart hooks). Do not offer setup. |
| Flag **absent**, no deposit | Tools **may** ask whether to install. On decline, create the flag. On enable, install and do **not** create the flag. |
| Operator stops using DD | Create `.no-deft-directive`. Do **not** auto-delete an existing deposit. |
| Operator starts using DD | Remove the flag, then run `directive init` or `directive update` so install is present. |

One-line message when tools honor the flag:

```text
Directive disabled via `.no-deft-directive`
```

## Inconsistent state (flag + deposit)

If **both** `.no-deft-directive` and a deposit (`.deft/core`) exist:

- **Doctor:** **warns** and exits dirty (exit 1)
- **`session:start`:** short-circuits with the disabled message plus the inconsistency warning (exit 1)
- **Host SessionStart hooks:** skip ritual bookkeeping (allow with `session-start-disabled`); never write `.deft/last-session.json` under opt-out
- **`init` / `update`:** **fail closed** (no scaffold/refresh)

**Product choice (v1):** warn in doctor; fail closed on mutating install paths (`warn-and-fail-closed`).

Fix by either:

1. Removing the flag if the project should use Directive, or
2. Removing the deposit if opt-out is intentional (explicit cleanup only — tools do not delete `.deft/` when creating the flag)

## Local flag wins (v1)

The root flag **wins locally** over ambient trusted-org / product-signal force-on. Org defaults must not override a committed opt-out without an explicit product decision beyond v1.

## CLI helpers (optional)

```bash
directive policy:disable-directive [--project-root .] [--note "reason"]
directive policy:enable-directive [--project-root .]
```

- `disable-directive` creates the flag (optional `--note` becomes a `#` comment)
- `enable-directive` removes the flag and tells you to ensure install

Presence detection is the core contract. CLI helpers are convenience only.

## Setup skill contract

When `deft-directive-setup` runs:

1. ! Check for root `.no-deft-directive` **before** any install or interview phase
2. ! If present → stop with `Directive disabled via \`.no-deft-directive\``
3. ? If absent and no deposit → ask the human whether to use Directive
4. ! On decline → create `.no-deft-directive` and stop
5. ! On enable / “start using DD” → remove the flag and ensure install

## Non-goals / follow-ups

- ⊗ Auto-delete `.deft/` when creating the flag
- ⊗ Org-wide ban (this is per-project filesystem only)
- ⊗ Nested monorepo package roots (v1 is workspace root only; multi-package monorepo rules are a follow-up)
- ⊗ Host personality / who may approve gates

## Related

- [deft-directive-disable.md](./deft-directive-disable.md) — **temporary** test/local kill-switch (deposit OK; not this flag)
- [getting-started.md](./getting-started.md) — install and first project
- [product-signal.md](./product-signal.md) — optional partner signal (defaults off; flag still wins locally)
- `session:start`, `doctor`, `directive init`, `directive update`
