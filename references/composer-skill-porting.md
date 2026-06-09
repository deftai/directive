# Composer Skill Porting — Warp to Composer

Reference for skill authors porting Warp-tuned playbooks into Composer-friendly
skills (Grok Build / Cursor-style single-session agents). Issue:
[#1518](https://github.com/deftai/directive/issues/1518).

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [skills/deft-directive-write-skill/SKILL.md](../skills/deft-directive-write-skill/SKILL.md) | [scm/github.md](../scm/github.md)

---

## Why This Document Exists

Warp skills often assume multi-agent orchestration: worktrees per task, long
scorecards pasted into chat, and human-readable tables as the source of truth.
Composer agents load skills via YAML `description` and trigger phrases, respect a
strict markdown rule stack (USER.md → AGENTS.md → SKILL.md), and default to
short chat plus file/issue ceremony.

Without adaptation, ported skills fight project `AGENTS.md`, spawn unnecessary
worktrees, or fire the wrong playbook because triggers overlap. This reference
captures the reusable authoring rules so Warp intent survives the harness change.

---

## Thin SKILL.md + references/ Split

! Keep `SKILL.md` under ~150 lines — ordered steps, hard stops, and pointers only.

⊗ Put scorecard templates, 40-line tables, triage playbooks, or output schemas
inside `SKILL.md`. Move them to `references/*.md` and link from the skill.

| Content type | Location |
| --- | --- |
| Triggers, prerequisites, step order | `SKILL.md` |
| Canonical output schema, FP appendix rules | `references/canonical-output.md` |
| Warp parity (what Warp still does that Composer skips) | `references/warp-parity.md` |
| Long triage or pipeline docs | `references/triage-*.md` |

~ Ship one Composer skill plus `references/` docs. Maintain Warp alignment in a
single parity reference instead of duplicating two full `SKILL.md` files.

---

## Negative Triggers in Description

The `description` field is the only surface Composer uses to decide whether to
load a skill. Near-miss phrases cause wrong-playbook misfires.

! Include explicit negative triggers in the `description` paragraph:

```yaml
description: >
  Runs the recall loop and posts Block A/B to the tracking issue.
  Use when the user says "run recall" or "recall loop".
  Do NOT trigger on "run tests" alone or generic "check CI".
```

! Name Composer variants distinctly (`…-composer`, `/my-workflow-composer`) when
a Warp skill with a similar name still exists.

⊗ Rely on vague positive triggers alone — overlapping phrases (`run tests` vs
`recall loop`) need a `Do NOT trigger on …` line.

---

## Fast Path vs Isolation

Warp playbooks often assume per-task worktrees and merge choreography. Composer
defaults to a single checkout.

! Lead every ported skill with a **Fast path (default)** table near the top:

| When | What |
| --- | --- |
| Default | Work on the main checkout (or single active branch) |
| Skip worktree steps | Unless merge lock, parallel fixtures, or user requests isolation |
| Still mandatory before commit | Script gates with exit codes (tests, ship-check, coupling) |

? Document full Warp isolation steps in `references/warp-parity.md` — one page,
gated as optional (`use when lock busy`, `use when user asks for parallel fixtures`).

⊗ Force colleagues to read 200 lines before learning the default is no worktree.

---

## Short Chat Expectations

Composer projects commonly enforce operator voice in `AGENTS.md`:

- Shortest useful answer; lead with the claim.
- No multi-line code fences in assistant chat (paths in prose are fine).
- Long structured output belongs in vBRIEF, issues, or reference docs.

### Warp habit → Composer adaptation

| Warp habit | Composer markdown |
| --- | --- |
| Paste full scorecard tables in chat | One-line claim + stable metrics in chat |
| User skims chat and says "go" | Run status script; attach tables to tracking issue |
| "Show the user the table below" in a step | "Run `<script>`; post output via `--body-file`" |

~ Every milestone step should name a script or file target, not a prose table to
recall from memory.

---

## Windows-Safe GitHub Body Files

Skills that create or comment on GitHub issues MUST NOT use inline multi-line
`--body` strings — they break on PowerShell 5.1 quoting, nested quotes, and
newlines.

! Prefer `--body-file` for any body longer than one line. Write temp files to the
OS temp directory, not the worktree. See [scm/github.md](../scm/github.md)
Standing gh CLI Rules.

| Unsafe Warp example | Composer-safe pattern |
| --- | --- |
| `gh issue create --body "…nested quotes…"` | Write body to temp `.md`; `gh … --body-file $path` |
| `cmd1 && cmd2` on PowerShell 5.1 | `cmd1; cmd2` or separate invocations |
| Inline heredocs in shell | Temp file under `$env:TEMP` or `%TEMP%` |

! Add one row to the Fast path table when the skill shells out on Windows:
`Shell: PowerShell 5.1; gh bodies via --body-file`.

---

## Authorization Wording

Warp playbooks sometimes infer implement intent from lifecycle words or partial
`git status`. Composer + Deft intent gates require explicit action verbs.

! Add a short instruction-parsing block or point at project `AGENTS.md`:

- Explicit verbs: `implement`, `ship`, `run agents`, `build`.
- ⊗ Treat checklist presence or broad approval (`sounds good`) as permission to commit.

---

## Migration Checklist

Copy when porting a Warp skill to Composer:

- [ ] New `name` and `description` with `Do NOT trigger on …` lines
- [ ] Fast path table (default checkout, shell notes)
- [ ] Split long content into `references/` (output schema, triage, parity)
- [ ] Replace "paste scorecard in chat" with script + issue body
- [ ] Align with project `AGENTS.md` operator voice
- [ ] `--body-file` for GitHub bodies on Windows-sensitive paths
- [ ] `references/warp-parity.md` for optional Warp-only steps
