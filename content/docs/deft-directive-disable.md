# Temporary kill-switch: the kill record

Use the **kill record** to turn Directive **enforcement** off for local testing (A/B, ceremony vs loop) **without** permanent project opt-out and **without** deleting the deposit.

Trackers: [#3039](https://github.com/deftai/directive/issues/3039) (kill-switch), [#6740](https://github.com/deftai/directive/issues/6740) (kill record).

**Not** permanent opt-out — that is [`.no-deft-directive`](./no-deft-directive.md) (#2926).

## Turn it off and on

A person runs these at a terminal:

```text
deft kill-switch:on --confirm     # enforcement off for this checkout
deft kill-switch:off --confirm    # enforcement back on (no mint)
```

Then start a **new agent session** either way.

- `kill-switch:on` runs the kept terminal mint: it refuses shells with agent or CI markers, non-interactive callers and an active UAT lease, and asks for the typed phrase. It then writes the record atomically.
- `kill-switch:off` removes only the record. It needs `--confirm` and no mint, because turning enforcement back on tightens (#5980).

## The record

```text
.deft/authz/kill-switch.disable
```

- **Location:** the payload root's grant store. A linked worktree uses its own root, never the main clone's.
- **Content:** plain lines. Two of them decide:
  - `schema=deft.kill-switch.v1`
  - `gitDir=` followed by what `git rev-parse --absolute-git-dir` prints in this checkout
- `mintedAt=` and `mintedVia=` are display only.

A record counts only when it is a regular file (not a link) that contains both lines exactly, as whole lines. Every CR is removed before matching. Anything else (a malformed, linked or copied record, or one from another checkout) leaves enforcement on, with one warning.

## A bare flag turns nothing off

Earlier versions turned enforcement off when a root `.deft-directive-disable` file was present. Current readers ignore that file. Presence alone means nothing.

When the bare flag is present and there is no valid record, every hook event, `doctor` and `session:start` print one warning that names the file and `deft kill-switch:on --confirm`. Enforcement stays on. There is no automatic record for an existing flag.

Older deposits still read the bare flag. Run `directive upgrade` or `directive install --repair` to get the current readers. `doctor` reports a host-hook call without the `--kill-switch-reader v1` flag and a checkout-local `.githooks/_directive-run.sh` without the `# directive-kill-switch-reader: v1` marker. The flag and the marker are compatibility information only, never authority.

## Distinct from permanent opt-out

| File | Intent |
|------|--------|
| [`.no-deft-directive`](./no-deft-directive.md) | Permanent: project does not use Directive. Flag + deposit is **inconsistent**. |
| `.deft/authz/kill-switch.disable` | Temporary: testing kill-switch. **Deposit OK**. |

## Behavior

| Surface | When a valid record is present |
|---------|-------------------------------|
| **Doctor** | Status **disabled (test kill-switch)**; prints the record's `mintedVia` and `mintedAt`, full recovery (record gone + new session) and one SessionStart registration line per host. |
| **Agent** | Always-on AGENTS contract: stop further Directive process load; echo recovery. |
| **CLI** (`session:start`, ritual paths) | Disabled + recovery; no ritual write / no half-DD automation. `session:start` prints the record's `mintedVia` and `mintedAt`. |
| **Launcher** | `deft <command>` stops with a one-line notice before it starts the runtime, except install, upgrade, uninstall, doctor, the kill record verbs, `--version` and `--help`. |
| **Host hooks** | The deposited outer hook (`node:fs` plus `git`) and the runtime hook dispatch skip ritual and enforcement. |
| **Git hooks** | Deposited `.githooks/_directive-run.sh` checks the record with shell tests, `git` and `grep -qxF` before it looks for the runtime or `node`, then skips the CLI spawn (exit 0) (#5543 / #3039 / #6740). |

Deposit (`.deft/core`) **may remain**. Init/update are not blocked by the record.

## Recovery (hysteresis)

Directive is **fully operational** only when:

1. The **record is gone** (`deft kill-switch:off --confirm`), and
2. A **new agent session** has been started after that.

Canonical recovery message:

```text
Directive is DISABLED for this checkout by the kill record `.deft/authz/kill-switch.disable` (test/local kill-switch, #6740).
Deposit may still be present; enforcement (hooks, session ritual, automation) will not run.
The record is valid: stop Directive process load (AGENTS.md Temporary test kill-switch #3039).
A bare root `.deft-directive-disable` file turns nothing off; only the record does.

To fully re-enable Directive:
  1. Remove the record:  deft kill-switch:off --confirm   (no mint needed)
  2. Start a NEW agent session (reload AGENTS / host skills / hooks)
Until both are done, Directive is not fully operational.
```

## Precedence

1. Valid kill record → test kill-switch (deposit OK; recovery = `kill-switch:off` + new session)
2. `.no-deft-directive` → permanent opt-out (#2926)
3. Else normal Directive

If the record and the opt-out flag are both present: one combined message; permanent install semantics still apply for init/update.

## Honest limits

The off switch is as strong as the grant store and the kept mint, no stronger. It is hardening, not proof that a human turned Directive off.

- The mint refuses shells with agent or CI markers and non-interactive callers. A pseudo-terminal with those markers unset passes it.
- Store-guard holes (#6292, #6981, #7034, #7036, paths built at run time, programmatic writes) let a process write a record, as they let it forge the settings grant that already authorizes a plant.
- The `gitDir=` binding isolates checkouts against copies. It does not prove freshness or who wrote the record.
- Named limits: restoring saved record bytes after `kill-switch:off`, and one checkout used from both Git for Windows and WSL git (one mint each).

Directive reports when it is off: doctor, `session:start` and the hooks say so.

## Agent self-serve ban (always-on, grant-gated) (#3186 / #6136)

The #6136 plant guard stays in force, unchanged. PreToolUse **always** denies agent Write / Edit / Shell that creates or renames-to `.deft-directive-disable` (and permanent opt-out `.no-deft-directive`) without a prior human-origin grant covering **settings** — not only under active UAT. Shell write reissue checks the protected basename **before** skipping out-of-tree dests, so a plant outside the repo tree cannot fail-open. Agents must not self-serve the kill-switch to bypass Write / push / PR / merge gates.

### Shell mention rule (#6681 / #6941)

A shell command whose text names either flag file is refused unless one of the rules below lets it through. The rule reads the command text; it is a guardrail over the commands the gate reads, not a security boundary.

| Rule | What passes | Limit |
|---|---|---|
| Plain reads | Every segment is a plain read: `cat`, `grep`, `rg`, `head`, `ls`, `diff`, … and `cut`, `tr`, `nl`, `jq`, `sort`, `git grep`, and `sed` line-range prints. | No output redirect, substitution or process substitution. `sed` passes only when every option is exactly `-n`, `--quiet`, `--silent`, `-e`, `--expression`, `-r`, `-z`, `-u` or `-s`, and every script (and the first operand) is `N`, `N,M`, `$` or `N,$` followed by `p`. |
| Unsafe options | A reader with a write or run option is not a plain read: `sort` (`-o`, `--output`, `--compress-program`, Windows `/o`), `git grep` (`-o`/`-O`, `--open-files-in-pager`, `--textconv`), `rg` (`--pre`, `--hostname-bin`), `file` (`-c`, `--compile`), `less` (`-o`, `-k`, `--log-file`, `--lesskey-file`), `more` (`-o`). | Every word is read, after `--` too. A short option matches its letter anywhere in a single-dash word (`-uo<file>`); a long option matches any abbreviation down to one letter (`--o=<file>`). Some harmless spellings are refused on purpose. |
| Trusted split | The guard splits a line at `;`, `&`, `\|` and line breaks. | When one of those characters is quoted, escaped (backslash or `^`) or decoded from `$'...'` / `\xHH`, no segment counts as a plain read (`grep 'a\|b' f \| sort` beside a flag name is refused). |
| `xargs` | `xargs` feeding a flag-free reader (`cat`, `grep`, `head`, `cut`, `jq`, …). | Only `-0`, `--null`, `-r`, `--no-run-if-empty`, `-t`, `--verbose`, `-n N` / `-nN` and `--max-args N` / `--max-args=N` may come before the program. Any other option, cluster or abbreviation (`--arg-file`, `-a`, `-0r`, `--nu`, `--`) is refused. `sort`, `sed`, `git`, `file`, `less`, `more` and `rg` never pass behind `xargs`. |
| Heredoc data | A quoted heredoc (`<<'EOF'`) that `cat` (one `>` or `>>` redirect) or `tee` (optional `-a`) writes to literal paths: its body is data, not a mention. | Only when it is the only command in the call: no pipe, `;`, `&&`, `\|\|`, `&` or second line, no `$`, backtick, quote, glob, `<(` / `>(`, and no destination that names a flag. The delimiter must be spelled plainly as `'WORD'` or `"WORD"`; `$"EOF"`, `$'EOF'` and mixed quoting are read as today. An unquoted heredoc body is always read. |

Names built at run time (variables, `sed`, `base64`) are not detected: a known limit.

These rules, the protected-store write rule and the commit-target gate run on every shell tool: `Bash`, Cursor's `Shell`, Codex `shell`, Grok's `run_terminal_command` and `monitor`, and Claude Code's `PowerShell` and `Monitor` (#6981). They read PowerShell text as shell text. PowerShell-only forms are tracked in #7050: file-writing cmdlets and their aliases, program runners, `-EncodedCommand`, backtick escapes, location control and script-block commits. After upgrading, run `directive install --repair` so each host's hook matcher names the new tools; until then existing deposits read as drifted.

To edit a scratch file whose text names a flag, use the Edit or Write tool. Those tools check the target's name, not its contents; other write checks still apply. A shell refusal of this rule says so too.

Related: `policy:allow-bot-merge`, `policy:allow-direct-commits`, and `policy:disable-directive` (peers) are settings under UAT and require a human grant.

## Non-goals (v1)

- ⊗ Auto-delete `.deft/` or uninstall deposit
- ⊗ Replace or weaken `.no-deft-directive`
- ⊗ Rewrite AGENTS to a stub on disable
- ⊗ Org-remote kill switch
- ⊗ Nested monorepo package roots
- ⊗ Auto-mint a record for an existing bare flag

## Related

- [no-deft-directive.md](./no-deft-directive.md) — permanent opt-out
- [getting-started.md](./getting-started.md) — install and first project
- `session:start`, `doctor`, host hooks (SessionStart / PreToolUse / compact)
