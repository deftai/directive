# Forensic Research — agent skill bundle

Structured **root-cause MODE** for coding agents: claim ledger, popularity traps, mandatory falsification, chat embargo until evidence closes. Not a log-pull cheat sheet — a discipline framework.

## Install (pick your harness)

Copy this entire `forensic-research/` folder to:

| Harness | Typical path |
|---------|----------------|
| **Grok Build** | `<your-project>/.grok/skills/forensic-research/` |
| **Warp** | `~/.agents/skills/forensic-research/` (or `%USERPROFILE%\.agents\skills\`) |
| **Cursor** | `<your-project>/.cursor/skills/forensic-research/` or team convention |
| **Codex** | Same as Cursor or `~/.agents/skills/` if your team uses that |

Register triggers in your skills index (if you have one): **forensic mode**, **root cause**, **investigate why**, **what caused**, **forensic research**.

## Before first use

1. **Gitignore** `.tmp/investigations/` in each project that uses this skill.
2. **Create a domain pack** — copy `references/domains/TEMPLATE.md` → `references/domains/<your-project>.md` and fill in:
   - Evidence adapters (where logs/metrics live)
   - Anchor id (trace id, request id, job id, …)
   - Popularity traps for your stack ("it's always the cache", "must be a race", …)
   - Starter logic tree branches
3. **Optional:** read `references/domains/code-debug.md` for a minimal local/CI example.
4. **Optional:** `examples/slizard/` shows a full production pack (Fly.io code review agent) — reference only unless you run that system.

## How to invoke

Say in natural language, e.g.:

- "Forensic mode — why did deploy X take 20 minutes and fail?"
- "Root cause: API timeout on checkout yesterday" (paste logs)
- "Stay in forensic" for follow-ups; **exit forensic** when done.

Agents should scaffold `.tmp/investigations/<id>/`, run waves 0–5, and only then summarize via `outcome.md`.

## What you get

- `SKILL.md` — entry point, iron laws
- `references/` — MODE, waves, validator, sub-agent prompts
- `templates/investigation.vbrief.json` — ledger scaffold
- `examples/slizard/` — SLizard-specific domain pack, code facts, failure regressions (not required for your project)

## Requirements

- Agent harness that can run **sub-agents** (Task tool or equivalent) for best results; solo mode works but is weaker.
- Shell access for evidence adapters defined in your domain pack.
- No Deft/SLizard dependency — ledger uses a thin JSON shape compatible with vBRIEF 0.6 fields.

## Version

Bundled from SLizard forensic-research skill, 2026-06-13. Generic core; SLizard material quarantined under `examples/slizard/`.
