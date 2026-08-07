# Temporary kill-switch: `.deft-directive-disable`

Use a **root file flag** to turn Directive **enforcement** off for local testing (A/B, DevHammer, ceremony vs loop) **without** permanent project opt-out and **without** deleting the deposit.

Tracker: [#3039](https://github.com/deftai/directive/issues/3039).

**Not** permanent opt-out — that is [`.no-deft-directive`](./no-deft-directive.md) (#2926).

## Filename and location

```text
.deft-directive-disable
```

- **Exact name:** lowercase `.deft-directive-disable`
- **Location:** project / workspace **root only**
- **Content:** empty file or a short `#` comment. Presence is the flag. No schema.
- **Git:** **Must be gitignored** (deposit baseline includes this entry). Committed / tracked flag is a misconfig: doctor **warns**, and enforcement is **not** disabled (repo-controlled content must not turn off hooks for clones).

## Distinct from permanent opt-out

| File | Intent |
|------|--------|
| [`.no-deft-directive`](./no-deft-directive.md) | Permanent: project does not use Directive. Flag + deposit is **inconsistent**. |
| `.deft-directive-disable` | Temporary: testing kill-switch. **Deposit OK**. |

## Behavior

| Surface | When flag present |
|---------|-------------------|
| **Doctor** | Status **disabled (test kill-switch)**; **not** the #2926 flag+deposit dirty path; prints full recovery (file gone + new session). |
| **Agent** | Always-on AGENTS contract: stop further Directive process load; echo recovery. |
| **CLI** (`session:start`, ritual paths) | Disabled + recovery; no ritual write / no half-DD automation. |
| **Host hooks** | SessionStart / PreToolUse / compact skip ritual and enforcement. |

Deposit (`.deft/core`) **may remain**. Init/update are not blocked by this flag alone (unlike permanent opt-out).

## Recovery (hysteresis)

Directive is **fully operational** only when:

1. **`.deft-directive-disable` is absent**, and
2. A **new agent session** has been started after the file was removed

Canonical recovery message:

```text
Directive is DISABLED for this project via root `.deft-directive-disable` (test/local kill-switch).
Deposit may still be present; enforcement (hooks, session ritual, automation) will not run.

To fully re-enable Directive:
  1. Delete the file:  rm .deft-directive-disable   (or equivalent)
  2. Start a NEW agent session (reload AGENTS / host skills / hooks)
Until both are done, Directive is not fully operational.
```

## Precedence

1. `.deft-directive-disable` → test kill-switch (deposit OK; recovery = delete + new session)
2. `.no-deft-directive` → permanent opt-out (#2926)
3. Else normal Directive

If **both** flags are present: one combined message; permanent install semantics still apply for init/update.

## Consumer note (A/B / DevHammer)

Typical arm for “without Directive enforcement”:

```bash
# Ensure ignore entry exists (init/update baseline)
# Then:
touch .deft-directive-disable
# Start a new agent session — enforcement off; deposit may stay.
```

Re-enable:

```bash
rm .deft-directive-disable
# Start a NEW agent session
```

## Agent self-serve ban under UAT (#3186)

Operators plant and remove this flag **outside** an agent session (or with a prior human-origin grant). Under **active UAT**, PreToolUse classifies Shell writes that create `.deft-directive-disable` (and permanent opt-out `.no-deft-directive`) as **settings** and **denies** them without a human grant — same posture as `authz:grant` (#3110). Agents must not self-serve the kill-switch to bypass Write / push / PR / merge gates.

Related: `policy:allow-bot-merge`, `policy:allow-direct-commits`, and `policy:disable-directive` (peers) are also settings under UAT and require a human grant.

## Non-goals (v1)

- ⊗ Auto-delete `.deft/` or uninstall deposit
- ⊗ Replace or weaken `.no-deft-directive`
- ⊗ Rewrite AGENTS to a stub on disable
- ⊗ Org-remote kill switch
- ⊗ Nested monorepo package roots
- ⊗ `DEFT_DISABLED=1` env (optional later)

## Related

- [no-deft-directive.md](./no-deft-directive.md) — permanent opt-out
- [getting-started.md](./getting-started.md) — install and first project
- `session:start`, `doctor`, host hooks (SessionStart / PreToolUse / compact)
