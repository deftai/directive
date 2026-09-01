# Grok Build subscription-only setup

Agent-facing playbook for a new maintainer. Paste this file (or issue [#4035](https://github.com/deftai/directive/issues/4035)) and say: follow this playbook. The human completes browser logins when the agent stops.

This is **host auth**, not Directive `session:start` and not product work in `deftai/directive`.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `⊗`=MUST NOT.

---

## Goal

Grok Build is the parent on SuperGrok (`grok login` / grok.com). Claude Code and Codex run only through their CLIs on subscriptions. Console API keys may still exist at User scope for other tools. Grok must not use those keys.

## Target shape

Verified 2026-08-31 on win32 (Grok 4.6 parent). Org names differ per maintainer. The auth *methods* must match.

| Surface | Required auth | Must not use |
|---|---|---|
| Grok Build parent | grok.com / `auth.x.ai` OIDC session (`grok login`) | `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY`, Console BYOK `[model.*]` |
| Claude Code CLI | `claude.ai` team subscription (`claude auth login --claudeai`) | `ANTHROPIC_API_KEY` / `apiKeySource=ANTHROPIC_API_KEY` |
| Codex CLI | ChatGPT (`codex login status` → ChatGPT) | `OPENAI_API_KEY` |

Grok catalog (`grok models`) is only `grok-4.6` / `grok-4.5`. Default is `grok-4.6`.

User-scope `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` may remain for non-Grok tools. Leave them set.

## Hard stops

The agent MUST NOT:

- implement product code while running this playbook
- unset User-scope or Machine-scope `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY`
- run `claude logout`, `codex logout`, or `grok logout`
- add or restore BYOK `[model.*]` blocks in `~/.grok/config.toml` (opus / sonnet / fable / gpt-5.6 Console ids)
- print secret values (print only `set=$true` / `set=$false`)
- invent `~/.config/deft` on Windows (#2544)

Config is read at Grok session start. After any `config.toml` edit, start a **new** Grok session. Mid-session children will not pick up `shell_environment_policy`.

Close stdin on CLI spawns: Windows `cmd /c "… <nul"`; Unix `… </dev/null`.

## Playbook

### 1. Grok Build

Install the Grok CLI. Put it on PATH.

Human (browser): `grok login` (grok.com / SpaceXAI OAuth at `auth.x.ai`).

Confirm: `grok models` prints `You are logged in with grok.com.` and lists only `grok-4.6` / `grok-4.5`.

### 2. `~/.grok/config.toml`

Path: `~/.grok/config.toml` (Windows: `%USERPROFILE%\.grok\config.toml`).

Set:

```toml
[models]
default = "grok-4.6"
default_reasoning_effort = "high"
web_search = "grok-4.6"

# Grok Build must not meter Anthropic/OpenAI/xAI Console API.
# Claude/Codex go through their CLIs (subscription).
# User/Machine env keys stay for other tools; Grok shells do not inherit them.
[shell_environment_policy]
exclude = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
]
```

Remove every `[model.<id>]` table that points at Anthropic or OpenAI Console (typical leftovers: `opus-5-high-fast`, `sonnet-5`, `fable-5`, `gpt-5.6-*`). Do not add new ones.

Do not copy unrelated `[ui]` personal settings from another maintainer.

Then start a **new** Grok session before the probes.

### 3. Claude Code CLI

Install current Claude Code. On Windows a working layout is `~\.local\bin\claude.exe` plus shims (`~\.local\bin` and `%AppData%\npm` on PATH).

Human (browser): `claude auth login --claudeai`. Use the team org the operator names.

Confirm: `claude auth status` shows `loggedIn=true`, `authMethod=claude.ai`, `subscriptionType=team`, and **no** `apiKeySource=ANTHROPIC_API_KEY`.

### 4. Codex CLI

Install Codex. On Windows the hashed binary may live under `%LOCALAPPDATA%\OpenAI\Codex\bin\`; keep a `codex` shim on PATH.

Human (browser): `codex login` (ChatGPT).

Confirm: `codex login status` prints `Logged in using ChatGPT`.

### 5. PATH

User PATH includes `~/.local/bin` (Windows: `%USERPROFILE%\.local\bin`) so Grok children find `claude` and `codex` without extra env surgery.

## Verification (report pass/fail with evidence)

Run from a **Grok** `run_terminal_command` child after the new session. Close stdin. Never print key values.

1. **Catalog.** `grok models` → only `grok-4.6` / `grok-4.5`. Fail if opus / sonnet / fable / gpt-5.6 appear in *this* catalog (Codex may still say `gpt-5.6-*` as *its* ChatGPT model; that is not Grok BYOK).

2. **Env policy.** This process may still have User keys. Print only `set=$true/$false` for User / Machine / Process scope of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY`. The Grok child Process-scope for `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` MUST be `$false`. Fail if the child still has them — policy did not apply (old session, or config not loaded). Do not delete User keys.

3. **Claude from Grok, no extra unset.** `claude auth status` as above. Then:

   `claude -p "Do not use tools. Reply with the single word: pong" --output-format text`

   Fail on an API-key warning or not-logged-in.

4. **Codex from Grok.** `codex login status` → ChatGPT. Then:

   `codex exec --ephemeral --skip-git-repo-check --sandbox read-only "Do not use tools. Reply with the single word: pong"`

   Fail if it demands `OPENAI_API_KEY`.

5. **Grok itself.** The session model is `grok-4.6` (or `grok-4.5`), not a Claude id. `XAI_API_KEY` unset. Auth is grok.com session (`grok models` / `~/.grok/auth.json` `auth_mode=oidc` at `auth.x.ai`). Do not dump tokens from `auth.json`.

**Pass.** All five true. Grok Build is subscription-only: xAI login + Claude team + Codex ChatGPT. Keys may remain in User env for non-Grok tools.

**Fail.** Child shells still inherit `ANTHROPIC_API_KEY` (old session / policy not loaded) or Claude reports `apiKeySource=ANTHROPIC_API_KEY`. Do not delete User keys. Report and stop.

## Out of scope

- [#4027](https://github.com/deftai/directive/issues/4027) — N≥3 design-critique lean-timing. This playbook is host auth. Do not launch a 3-panel unless the operator asks.
- [#2520](https://github.com/deftai/directive/issues/2520) — multi-engine least-privilege *pattern*. Related theme, different artifact.
- Unsetting User keys that other tools still need.
- Product code in `deftai/directive`.

## Related Grok docs (local, after install)

- `~/.grok/docs/user-guide/02-authentication.md` — grok.com session vs `XAI_API_KEY` fallback
- `~/.grok/docs/user-guide/05-configuration.md` — `config.toml` precedence
- `~/.grok/docs/user-guide/11-custom-models.md` — BYOK `[model.*]` (do not add these)
- `~/.grok/docs/user-guide/18-sandbox.md` — `[shell_environment_policy]`
