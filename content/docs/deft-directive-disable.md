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
| **Doctor** | Status **disabled (test kill-switch)**; **not** the #2926 flag+deposit dirty path; prints full recovery (file gone + new session) and one SessionStart registration line per host from that host's SessionStart check. |
| **Agent** | Always-on AGENTS contract: stop further Directive process load; echo recovery. |
| **CLI** (`session:start`, ritual paths) | Disabled + recovery; no ritual write / no half-DD automation. |
| **Host hooks** | SessionStart / PreToolUse / compact skip ritual and enforcement. |
| **Git hooks** | Deposited `.githooks/_directive-run.sh` skips CLI spawn (exit 0 + recovery) when the flag is local/untracked (#5543 / #3039). Tracked flag does **not** disable. |

Deposit (`.deft/core`) **may remain**. Init/update are not blocked by this flag alone (unlike permanent opt-out).

## Recovery (hysteresis)

Directive is **fully operational** only when:

1. **`.deft-directive-disable` is absent**, and
2. A **new agent session** has been started after the file was removed

Canonical recovery message:

```text
Directive is DISABLED for this project via root `.deft-directive-disable` (test/local kill-switch).
Deposit may still be present; enforcement (hooks, session ritual, automation) will not run.
The flag is present: stop Directive process load (AGENTS.md Temporary test kill-switch #3039).

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

## Agent self-serve ban (always-on, grant-gated) (#3186 / #6136)

Operators plant and remove this flag **outside** an agent session (or with a prior human-origin grant covering **settings**). PreToolUse **always** denies agent Write / Edit / Shell that creates or renames-to `.deft-directive-disable` (and permanent opt-out `.no-deft-directive`) without that grant — not only under active UAT. Shell write reissue checks the protected basename **before** skipping out-of-tree dests, so a plant outside the repo tree cannot fail-open. Agents must not self-serve the kill-switch to bypass Write / push / PR / merge gates.

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
- ⊗ `DEFT_DISABLED=1` env (optional later)

## Related

- [no-deft-directive.md](./no-deft-directive.md) — permanent opt-out
- [getting-started.md](./getting-started.md) — install and first project
- `session:start`, `doctor`, host hooks (SessionStart / PreToolUse / compact)
