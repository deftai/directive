# Deterministic Questions Contract
Canonical rule for every structured `ask_user_question` prompt and every numbered-menu prompt rendered in skill prose. Lives once here so individual skills can `!` cross-reference instead of duplicating the rule body. Surfaced by #767 after the 2026-04-30 swarm-planning session where users typed `discuss (user-provided)` to break out of a deterministic question and `wait` at a hard gate -- both honored by convention only.
Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.
**See also**: [main.md](../main.md) | [glossary.md](../glossary.md) (deterministic mode entry) | [skills/deft-directive-interview/SKILL.md](../skills/deft-directive-interview/SKILL.md) (canonical interview loop) | [vbrief/completed/2026-04-20-431-deterministic-questions-rc2-defects.vbrief.json](../vbrief/completed/2026-04-20-431-deterministic-questions-rc2-defects.vbrief.json) (RC2 prior art)
## Prior art reviewed (#431)
The RC2 work in #431 (closed; "Deterministic questions (RC2): confirm step, back nav, escape hatch distinct from Other") established three load-bearing properties this contract preserves rather than reimplements:
1. **Back navigation is a first-class numbered option** -- not a sub-choice of `Other`, not a free-text escape. The agent renders `Back` as the final option in the numbered list and returns to the prior question / decision point on selection.
2. **Escape hatch distinct from Other** -- `Other` collects free-text answers that fit the same question shape; the escape hatch is a SEPARATE option that exits the deterministic flow entirely.
3. **Confirmation step before destructive write** -- post-interview confirmation gates (e.g. `skills/deft-directive-setup/SKILL.md` Post-Interview Confirmation Gate) are independent of the option list and ride on top of every deterministic flow.
This contract EXTENDS that surface by promoting `Discuss` to a peer of `Back` (both are now mandatory final options) and by codifying the Discuss-pause semantic verbatim. It does NOT introduce a separate `Other` option; this contract is purely about adding `Discuss` + `Back` as canonical numbered options. The pre-#767 surface (back navigation, confirm step, Other-vs-escape distinction) remains intact.
## The rule
- ! Every structured `ask_user_question` prompt (single-select OR multi-select) and every numbered-menu prompt rendered in skill prose MUST include `Discuss` and `Back` as the final two numbered options, in that order. The numbering is local to the prompt (it does not need to be the literal "N-1" / "N" -- it just needs to be the last two entries presented to the user).
- ! `Discuss` MUST be a top-level numbered option, NOT a sub-choice of any `Other` / `Custom` option. Honoring #431's escape-hatch principle.
- ! `Back` MUST return to the prior question or decision point. Selecting `Back` from the very first question of a flow returns to the calling skill's entry-point (or surfaces "Nothing earlier to go back to" and re-asks the current question).
- ⊗ Render a deterministic numbered menu without `Discuss` and `Back` as the final two options.
- ⊗ Combine `Discuss` and `Other` into one option. They serve different roles -- `Other` widens the question's answer space; `Discuss` exits the question entirely.
- ⊗ Render `Discuss` or `Back` only in some skills -- the rule is universal across every deterministic-mode skill.
## Discuss-pause semantic (verbatim)
Documented here as the single normative source so skill prose, tests, and downstream tooling all read the same words.
- ! When the user selects `Discuss`, the agent MUST pause IMMEDIATELY.
- ! The agent MUST halt the in-progress sequence -- no further tool calls beyond acknowledging the pause.
- ! The agent MUST prompt: `What would you like to discuss?`
- ! The agent MUST resume ONLY when the user explicitly signals readiness. The accepted explicit-resume signals are:
    1. The user re-asks the original question (paraphrasing is allowed; the user must reference the question that was paused).
    2. The user says `resume` or `continue` (case-insensitive, optionally followed by punctuation).
    3. The user re-issues the prior selection (e.g. picks one of the numbered options again).
- ⊗ Implicit resumption -- the agent MUST NOT auto-resume after a Discuss pause based on time elapsed, topic drift, or its own inference of "the user seems ready". Implicit resumption is forbidden.
- ⊗ Continue executing the in-progress sequence after the user selects `Discuss`. Halting is unconditional.
- ⊗ Make additional tool calls during a Discuss pause beyond the single acknowledgment + the resume prompt.
- ~ The agent MAY ask focused clarification questions during the discussion -- those are part of the discussion, not the original deterministic flow.
- ~ When the user resumes, the agent SHOULD re-render the original numbered menu before accepting a selection so the user can see the same context they were on when they paused.
## Back semantic
- ! When the user selects `Back`, the agent MUST treat the prior question as un-answered and re-render its numbered menu.
- ! The agent MUST preserve any earlier captured values (the user is rewinding by one step, not aborting the flow).
- ⊗ Treat `Back` as a Discuss pause -- `Back` is structural rewind; `Discuss` is structural exit.
## Cross-references in skills
Each affected skill carries a `!` cross-reference pointing here, mirroring the Rule Authority [AXIOM] block in `main.md` ("deterministic > Taskfile > vBRIEF > RFC2119 > prose; prose is fallback only when no stronger encoding applies"):
- `skills/deft-directive-swarm/SKILL.md`
- `skills/deft-directive-setup/SKILL.md`
- `skills/deft-directive-refinement/SKILL.md`
- `skills/deft-directive-pre-pr/SKILL.md`
- `skills/deft-directive-review-cycle/SKILL.md`
- `skills/deft-directive-release/SKILL.md`
The `interview` and `build` skills are deliberately not edited under #767 (Agents 2 / 3 own those surfaces); the cross-reference will land there in their PRs and read this contract.
## Test surface
`tests/content/test_deterministic_questions.py` scans skill prose for documented numbered menus and asserts that `Discuss` and `Back` are the final two options. The test also asserts that this contract file exists, contains the verbatim Discuss-pause semantic, and is cross-referenced from each affected skill.
