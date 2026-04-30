---
name: deft-directive-interview
description: >
  Deterministic structured Q&A interview loop. Use when any skill needs to
  gather structured input from the user through a series of focused questions
  with numbered options, stated defaults, and a confirmation gate before
  artifact generation. Interview output targets vBRIEF narratives — not PRD.md.
---

# Deft Directive Interview

Deterministic interview loop that any skill can invoke to gather structured user input.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- Another skill needs to gather structured input from the user (e.g. deft-directive-setup Phase 1/Phase 2)
- User says "interview loop", "q&a loop", or "run interview loop"
- A workflow requires a series of focused questions with explicit defaults and confirmation before proceeding

## Interview Loop

### Rule 1: One Question Per Turn

! Ask ONE focused question per step. After the user answers, send the NEXT question in a new message. Repeat until all questions for the current interview are answered.

- ⊗ Include two or more questions in the same message under any circumstances
- ⊗ List upcoming questions -- only show the current one
- ⊗ Combine the current question with a summary of previous answers unless explicitly at the confirmation gate

### Rule 2: Numbered Options with Stated Default

! Every question MUST present numbered answer options. Exactly one option MUST be marked as the default using the `[default: N]` notation inline.

Example:
```
Which deployment platform?

  0. Discuss with agent (pause interview to talk it through)
  ─────────────────────────────────────────────────────────
  1. Cross-platform (Linux / macOS / Windows)
  2. Web / Cloud [default: 2]
  3. Embedded / low-resource
  4. Other / I don't know

Enter confirm / b back / 0 discuss
```

- ! The default MUST be stated inline with the option (e.g. `[default: 2]`), not in a separate line or footnote
- ! If no option is objectively better, pick the most common choice and mark it as default
- ! Option `0. Discuss with agent` MUST appear in slot 0 at the top of the options block, visually separated from the numbered answer options (e.g. by a horizontal rule or blank line) so it is not confused with `Other / I don't know`
- ! A persistent one-line legend MUST appear directly under the options block on every question (see Rule 11)

#### Always-Structured Rendering (Option A)

! EVERY user-facing question MUST render via the structured question tool: click-commit on hosts that have one (e.g. Warp `ask_user_question`); plain-text with typed response otherwise. The agent MUST NOT emit a user-facing question as conversational prose regardless of whether the final answer content is enumerable or freeform. This is the Option A always-structured rendering rule (#478).

! Freeform answer collection, when needed, MUST be a two-step flow:

1. Structured-tool call with options such as `[Draft for me (I'll propose content) / Write my own / Defer / Discuss / Back]`.
2. If the user picks "Write my own", a follow-up plain-text prompt collects the freeform content. The prompt itself is a non-question status message ("Type your answer below.") -- the enumerable path choice has already been captured by the structured tool.

! The ONLY permissible plain-text-to-user emissions are:

1. The Rule 6 Confirmation Gate (typed plain-text commit, see Rule 6's Click-Commit Hosts subsection).
2. Agent-initiated status updates that do NOT ask the user to choose anything (e.g. "Files written. Next I'll read X.").

- ⊗ Emit a user-facing question outside a structured-tool call because the answer content is prose, because a preamble is long, because the question "feels conversational," or because the prior question was plain-text. None of those are valid reasons.
- ⊗ Present a user-facing choice as plain-text prose when a structured question tool is available on the host.

#### Click-Commit Rendering

! When the host's structured question tool is single-shot / click-commit (the tool returns the user's selection atomically with no separate Enter step -- e.g. Warp `ask_user_question`), Rules 8, 9, and 10 MUST be rendered as explicit clickable options in the options list on every applicable question. The `Enter confirm / b back / 0 discuss` keystroke legend from Rule 11 is a plain-text-mode affordance only.

Click-commit options block shape:

```
[ Back -- revisit step N-1 ]
[ Discuss with agent (pause interview) ]
----------------------------------------
[ Answer option 1 ]
[ Answer option 2 [default] ]
[ Answer option 3 ]
[ Other / I don't know ]
```

- ! `Back` MUST appear on every question EXCEPT the first (nothing to go back to). Picking `Back` returns to question N-1 with its previously captured answer displayed.
- ! `Discuss with agent` MUST appear on every question. Picking it enters Rule 10 freeform mode; the agent MUST re-render the same question after the discussion resolves.
- ! Answer options MUST render with the default marker (e.g. `[default]` appended to the option label) since the `[default: N]` inline notation is not rendered by most click-commit tools.
- ⊗ Omit `Back` on any question except the first.
- ⊗ Omit `Discuss with agent` on any question.
- ⊗ Treat a click-commit tool's returned selection as a Rule-8 confirmed commit. Click-commit tools do NOT satisfy Rule 8 -- there is no keyboard Enter step, so the click is both selection and commit. The Rule 6 Confirmation Gate (rendered as plain-text typed commit on click-commit hosts) provides the only typed-commit step in the flow.

#### Preamble Placement

~ Explanatory preamble (context, consequences, what-happens-next) MAY appear as plain markdown ABOVE the structured-tool call. The question itself -- the sentence that asks for a decision -- MUST be encoded in the structured tool's `question` field, and the enumerable options MUST be encoded in the tool's `options` field.

- ⊗ Render a user-facing question as plain-text because you wanted to include preamble -- preamble belongs above the tool call, not instead of it.

### Rule 3: Explicit "Other / I Don't Know" Escape

! Every question MUST include an escape option. The last numbered option MUST be either:
- "Other (please specify)" -- for open-ended alternatives
- "I don't know" -- when the user may lack context to answer
- "Other / I don't know" -- combined form (preferred)

- ! The `Other / I don't know` escape is SEPARATE from the slot-0 `Discuss with agent` option (Rule 10). The two options MUST both be present and MUST NOT be merged into a single entry
- ⊗ Present a question with no escape option -- the user must always have a way out
- ⊗ Use the `Other / I don't know` entry as the discuss/freeform escape -- slot 0 `Discuss with agent` is the discuss escape (Rule 10)
- ~ When the user selects the escape option, follow up with a brief open-ended prompt to capture their input or acknowledge the gap

### Rule 4: Depth Gate

! Keep asking until no material ambiguity remains before artifact generation. The interview is NOT complete until the calling skill's required inputs are all captured with sufficient specificity to generate the target artifact.

- ! If an answer introduces new ambiguity (e.g. user selects "Other" and describes something that requires follow-up), ask clarifying questions before moving on
- ! Do not truncate the interview to save time -- completeness takes priority over brevity
- ~ The calling skill defines what "sufficient specificity" means by providing a list of required fields in the handoff contract

### Rule 5: Default Acceptance

! When a question has a stated default, the user may accept it with any of the following responses:
- Bare enter / empty response
- "yes", "y", "ok", "default", "keep"

! When the user types the default option number (e.g. "2"), this is treated as a numeric selection — Rule 8 applies (echo selection, wait for confirmation). It is NOT treated as a bare acceptance like "yes" or Enter.

! Do NOT re-ask the question when the user accepts the default via a non-numeric response. Record the default value and proceed to the next question.

- ⊗ Re-ask a question because the user's acceptance was "too brief" -- any of the listed responses is a valid acceptance
- ⊗ Interpret an empty response as a refusal or skip

### Rule 6: Confirmation Gate

! After ALL questions are answered (depth gate satisfied), display a summary of ALL captured answers in a clearly formatted list and require explicit yes/no confirmation before proceeding.

Format:
```
Here are the values I captured:

- **Field 1**: value
- **Field 2**: value
- **Field 3**: value
...

Confirm these values? (yes / no)
```

- ! Accept only explicit affirmative responses (`yes`, `confirmed`, `approve`) -- reject vague responses (`proceed`, `do it`, `go ahead`)
- ~ Note: The confirmation gate is intentionally stricter than Rule 5 (default-acceptance). Rule 5 accepts casual responses like `ok` for individual question defaults because the cost of a wrong default is low (one field, correctable at the confirmation gate). The confirmation gate guards the entire artifact -- accepting `ok` here risks generating artifacts from auto-filled or misunderstood values. This asymmetry is by design.
- ! If the user says `no`: ask which values to correct, re-ask those specific questions only (do not restart the full interview), then re-display the updated summary and re-confirm
- ! If any value appears to be auto-generated filler (repeated default text, placeholder strings, or values that echo the question prompt), warn the user explicitly before confirming
- ⊗ Proceed to artifact generation without displaying the summary and receiving explicit confirmation

#### Click-Commit Hosts: Plain-Text Confirmation Gate

! When the host's structured question tool is click-commit, the Confirmation Gate MUST be rendered as plain-text requiring a typed response (`yes` / `no` / `back` / `discuss`). It MUST NOT be rendered via the click-commit structured tool.

- ! Accept only explicit affirmative tokens (`yes`, `confirmed`, `approve`) per the existing Rule 6 strictness. Reject click-level tokens and vague responses (`ok`, `proceed`, `do it`).
- ! The typed commit provides the Enter-confirm semantic that Rule 8 was written to guarantee. This is the only place in the click-commit flow where a true commit step exists.
- ⊗ Render the Confirmation Gate via a click-commit structured tool -- this removes the last safeguard against misclicks on the final answer.

#### Mode Restore After the Gate

! After the Rule 6 Confirmation Gate commits (user typed an affirmative token), the plain-text rendering mode is RELEASED. The next user-facing question MUST return to structured-tool rendering (click-commit on hosts that have one; plain-text with typed response otherwise, per Rule 2's Always-Structured Rendering). The plain-text gate does NOT establish a sticky mode for subsequent prompts.

- ⊗ Render the next user-facing question as plain-text conversational prose because the Rule 6 Gate was just in plain-text mode.

### Rule 7: Structured Handoff Contract

! When the interview is complete (confirmation gate passed), the skill exits with an **answers map** -- a structured key-value representation of all captured answers that the calling skill uses to generate artifacts.

The answers map format:
```json
{
  "field_1": "captured value",
  "field_2": "captured value",
  "field_3": ["list", "if", "multi-select"],
  ...
}
```

- ! The calling skill defines the expected keys in its invocation of deft-directive-interview
- ! The answers map MUST contain a value for every required key defined by the calling skill
- ! Optional keys may be omitted if the user did not provide input and no default was applicable
- ~ The calling skill is responsible for validating the answers map against its own schema and requesting re-interview for any missing or invalid fields

## Output Targets

Interview output writes to `specification.vbrief.json` `plan.narratives` — the vBRIEF draft is the sole authoritative output. PRD.md is never generated. All vBRIEFs target the canonical v0.6 schema (`vbrief/schemas/vbrief-core.schema.json`, strict `const: "0.6"`); see [`../../conventions/references.md`](../../conventions/references.md).

When the interview captures origin provenance (e.g. the user links to a GitHub issue or Jira ticket), include a `references` entry in the canonical form documented in [`../../conventions/references.md`](../../conventions/references.md):

```json
"references": [
  {
    "uri": "https://github.com/{owner}/{repo}/issues/{N}",
    "type": "x-vbrief/github-issue",
    "title": "Issue #{N}: {issue title}"
  }
]
```

### Full Path Output

! On the Full path, the interview populates `specification.vbrief.json` `plan.narratives` with `vBRIEFInfo.version: "0.6"`, `status: draft`, and rich keys:

- `ProblemStatement`: What problem this project solves
- `Goals`: High-level project goals
- `UserStories`: User stories in standard format
- `Requirements`: Structured requirements (FR-N: functional, NFR-N: non-functional)
- `SuccessMetrics`: Measurable success criteria
- `Architecture`: System design and technical architecture
- `Overview`: Brief project summary

! All narrative values MUST be plain strings — never objects or arrays.

! The human approval gate reviews the vBRIEF draft narratives directly — reviewing the narratives IS the approval step. On approval, update `status` to `approved` and generate downstream scope vBRIEFs.

### Light Path Output

! On the Light path, the interview populates `specification.vbrief.json` with `status: draft` and slim narratives:

- `Overview`: Brief project summary
- `Architecture`: System design description

! On approval, update `status` to `approved`. Scope vBRIEFs are then created in `vbrief/proposed/` for each identified work item.

### PRD.md (deprecated — never authoritative)

PRD.md is not generated as part of the interview workflow on either path. The `specification.vbrief.json` vBRIEF draft is the sole source of truth.

- ? If stakeholders require a traditional PRD document, run `task prd:render` to export a read-only `PRD.md` from `plan.narratives`
- ! PRD.md is never authoritative — `specification.vbrief.json` is the source of truth
- ⊗ Generate an authoritative PRD.md during the interview process
- ⊗ Treat PRD.md as a source of truth — it is a generated export artifact

## Invocation Contract

deft-directive-interview supports two usage modes:

### Embedded Mode

The calling skill references deft-directive-interview rules inline (e.g. "this phase follows the deterministic interview loop defined in `skills/deft-directive-interview/SKILL.md`") and applies the rules directly within its own question sequence. No formal contract object is needed -- the calling skill embeds the question definitions and field requirements in its own SKILL.md. This is the current approach used by `skills/deft-directive-setup/SKILL.md` Phase 1 and Phase 2.

### Delegation Mode

The calling skill explicitly invokes deft-directive-interview as a sub-skill and passes a formal contract object. When using delegation mode, the calling skill MUST provide:

1. **Required fields**: list of field names that must be captured (the depth gate uses this to determine completeness)
2. **Question definitions**: for each field, the question text, numbered options (if applicable), and default value
3. **Optional fields**: list of field names that may be skipped

The calling skill MAY provide:
- **Context preamble**: a brief description of why these questions are being asked (shown to the user before the first question)
- **Validation rules**: constraints on acceptable values for specific fields

### Rule 8: Deterministic Selection Confirmation

! After the user enters a number to select an option, the agent MUST echo the selected option text and wait for explicit confirmation before advancing to the next question. The confirm-after-number-press step is MANDATORY -- number entry alone MUST NOT advance the interview.

Example:
```
Which deployment platform?

  0. Discuss with agent (pause interview to talk it through)
  ────────────────────────────────────────────────────────
  1. Cross-platform (Linux / macOS / Windows)
  2. Web / Cloud [default: 2]
  3. Embedded / low-resource
  4. Other / I don't know

Enter confirm / b back / 0 discuss

> User: 1

You selected: **1. Cross-platform (Linux / macOS / Windows)**
Press Enter to confirm, type a different number to change, or `b` to go back.
```

- ! Show the selected option text (with its number) after each number entry -- the user must see what was selected
- ! Wait for Enter / explicit confirmation before advancing -- do NOT auto-advance on number press, under any circumstances
- ! If the user types a different number instead of confirming, switch to that option and re-confirm (echo the new selection and wait for Enter again)
- ! Accept `b`, `back`, or `prev` at the confirm prompt as a shortcut to back-navigation (Rule 9) without first requiring confirmation of the selection
- ⊗ Auto-advance to the next question immediately after the user presses a number key
- ⊗ Skip the echo step -- even when the selection "seems obvious" the agent MUST display the selected option text back to the user before advancing

### Rule 9: Backward Navigation

! The agent MUST support backward navigation during the interview. At any question (including at the confirm-after-number prompt from Rule 8), the user may type `back`, `prev`, or `b` to return to the previous question and change their answer.

- ! When the user navigates back, re-display the previous question with the previously selected answer shown
- ! The user may change the answer or confirm the existing one
- ! The back-navigation affordance MUST be visible on every question via the persistent one-line legend (Rule 11) -- not only announced once at the start of the interview
- ~ The agent SHOULD additionally inform the user of backward navigation availability at the start of the interview (e.g. "Type 'b' / 'back' at any question to revisit the previous answer")
- ⊗ Refuse to let the user revisit previous answers during the interview
- ⊗ Hide the back-navigation affordance -- the legend under each question MUST name the `b` key explicitly

### Rule 10: Freeform Conversation Escape (Slot 0 -- Discuss with agent)

! Every deterministic question MUST include an option `0` that pauses the structured flow and opens a freeform conversation with the agent. Option 0 is the self-describing **Discuss with agent** escape hatch and is DISTINCT from `Other / I don't know` (Rule 3).

- ! Option 0 label: `0. Discuss with agent` (a short self-describing clarifier such as `(pause interview to talk it through)` MAY follow on the same line)
- ! Option 0 MUST render in slot 0 at the top of the options block, visually separated from the numbered answer options (e.g. by a horizontal rule or blank line) so it is not confused with slot `Other / I don't know`
- ! The slot-0 label MUST be self-describing -- do NOT use generic labels like `Other..`, `Escape`, or `Pause` without the `Discuss with agent` phrasing
- ! When the user selects 0, the agent enters a freeform conversation mode where the user can ask clarifying questions, request more context about the options, or explain nuance
- ! The agent MUST explicitly resume the deterministic flow when the conversation is resolved: re-display the same question (with the full options block and legend) and wait for a numbered answer
- ⊗ Continue the deterministic flow while in freeform conversation mode
- ⊗ Omit option 0 from any deterministic question
- ⊗ Place option 0 at the bottom of the options block or inline with numbered answers -- slot 0 MUST be first, visually separated
- ⊗ Merge slot-0 `Discuss with agent` with `Other / I don't know` -- they are distinct affordances

### Rule 11: Persistent Legend Under Each Question

! Every deterministic question MUST surface the confirm / back / discuss affordances on every question (not only at the start of the interview). The way those affordances are surfaced depends on the host's rendering mode -- see Rule 2's Click-Commit Rendering and Always-Structured Rendering subsections.

Canonical legend text (plain-text mode):

```
Enter confirm / b back / 0 discuss
```

#### Plain-Text Rendering Mode

! In plain-text rendering mode, the keystroke legend above MUST be rendered directly under the options block on every deterministic question, including re-displayed questions after back-navigation (Rule 9) or freeform resume (Rule 10).

- ! The legend MUST be present under every deterministic question in plain-text mode
- ! The legend MUST name all three affordances: `Enter` (confirm selection -- Rule 8), `b` (back -- Rule 9), `0` (discuss -- Rule 10)
- ~ The legend SHOULD appear as a single line directly below the options block, separated by a blank line
- ? Additional hints (e.g. `c cancel`) MAY be appended with `/` separators, but the three canonical affordances MUST always be present
- ⊗ Omit the legend from any plain-text-mode deterministic question -- every question MUST carry it
- ⊗ Replace the canonical affordance labels with non-self-describing abbreviations (e.g. `↵`, `←`) without also spelling them out

#### Click-Commit Rendering Mode

! In click-commit rendering mode, the confirm / back / discuss affordances are rendered as clickable options in the options list per Rule 2's Click-Commit Rendering subsection:

- `Back -- revisit step N-1` renders as a clickable option on every question except the first
- `Discuss with agent (pause interview)` renders as a clickable option on every question
- Commit is implicit in the click-commit return; the Rule 6 plain-text Confirmation Gate is the only typed-commit step before file writes

! The keystroke legend MAY be omitted in click-commit rendering because the host tool does not accept keystroke input. The affordances themselves MUST still be present as clickable options (not omitted).

- ⊗ Omit `Back` (except on the first question) or `Discuss with agent` from any click-commit rendering -- the affordances survive the mode change even though the keystroke legend does not

## IP Risk Probe (#738)

! When the interview captures the project description (and any
research-phase notes), the agent MUST run the IP-risk heuristic from
[`references/ip-risk.md`](../../references/ip-risk.md) -- canonical
implementation `scripts/ip_risk.py:detect_ip_terms` -- before generating
the SPECIFICATION.

The heuristic is permissive on purpose: recognizable IP names (Magic:
The Gathering, Pokemon, etc.), fictional-universe terms (Hogwarts,
Tatooine), branded characters (Mickey Mouse, Spider-Man), sports leagues
(NFL, NBA), and trademarked products (iPhone, Xbox) all trigger a hit.

! When `detect_ip_terms` returns at least one hit:

1. ! Ask the explicit monetization-intent question (canonical wording in
   `references/ip-risk.md` `## Question Script`). The user MUST choose
   between **personal use only** and **commercial use** -- defaulting to
   `commercial` when intent is unclear, because the stricter checklist is
   the wrong-side-of-safe choice.
2. ! Emit the plain-English risk summary from
   `scripts/ip_risk.py:plain_risk_summary(hits, intent)` into the
   interview output AND into an `IPRisk` narrative on the
   `specification.vbrief.json` draft. The summary opens with `not legal
   advice`, names the detected categories, and (for commercial intent)
   states explicitly that lawyer consultation is **not optional output**
   from this interview.
3. ! Inject the three protection scope items from
   `scripts/ip_risk.py:ip_risk_scope_items(intent)` into the spec
   vBRIEF's `plan.items` array (disclaimer stub `IP-1`, API-only-asset
   policy `IP-2`, hosting policy `IP-3`). The items flow naturally into
   the rendered SPECIFICATION.md via the existing
   `scripts/spec_render.py` pipeline -- no spec_render.py modification
   is required.
4. ! For commercial intent, the lawyer-consultation recommendation is
   non-optional output -- the interview MUST surface it before the
   confirmation gate.

- ⊗ Skip the IP-risk probe when the project description references
  third-party intellectual property -- the heuristic is the gate
  whether or not the agent thinks the project is "obviously fine".
- ⊗ Treat the absence of detected terms as proof that the project is
  IP-free -- the heuristic only knows about the curated lists in
  `scripts/ip_risk.py`. When the description is vague, the agent SHOULD
  ask directly "is this based on a game / film / sports league /
  brand?".
- ⊗ Provide legal advice. Deft is not a law firm -- the only
  recommendation it makes is **consult a lawyer**.

## Plain-English UX (#740)

! Every user-facing question, summary, and output line in this skill
MUST follow the rules in
[`references/plain-english-ux.md`](../../references/plain-english-ux.md):

1. ! Every technical question MUST carry a one-line plain-English
   context note as preamble above the structured-tool call. The
   preamble explains the *consequence* of the choice in non-technical
   terms.
2. ! Every acronym MUST be defined inline on first use within a skill
   session: `PRD (Product Requirements Document)`, `NFR (Non-Functional
   Requirement)`, `FR (Functional Requirement)`, `SPEC (Specification)`,
   `API (Application Programming Interface)`, `DB (Database)`, `CI
   (Continuous Integration)`, `MVP (Minimum Viable Product)`. Subsequent
   uses MAY drop the expansion.
3. ! When a skill recommends a framework, library, language, or tool,
   the recommendation MUST either explain the rationale in plain-English
   terms the user actually cares about (cost, speed, hiring, hosting
   compatibility, etc.) OR remove the rationale entirely and present it
   as an overridable default. ⊗ Drop a framework name with a one-word
   `industry-standard` / `modern` / `scalable` justification.

- ⊗ Drop a technical question on the user without a plain-English
  context note above it.
- ⊗ Use an acronym for the first time without inlining `(full
  expansion)`.
- ⊗ Treat "the user can ask their other AI to translate" as an
  acceptable mitigation for jargon.

## Approval Menus After PRD and SPEC Review (#740, refs #767)

! After every PRD review AND every SPECIFICATION review, the agent MUST
present an explicit numbered approval menu using the canonical shapes
from `references/plain-english-ux.md` `## Rule 4`. The menu replaces
ambiguous buttons like `Accept / Refine / Edit` with action-shaped
labels.

Canonical PRD-review menu:

```
What would you like to do with the PRD (Product Requirements Document)?

  1. Approve and continue (lock the PRD, generate the SPECIFICATION)
  2. Suggest changes (you describe what to change; the agent rewrites)
  3. Edit yourself (you edit the PRD directly; the agent waits)
  4. Discuss
  5. Back

Enter confirm / b back / 0 discuss
```

Canonical SPECIFICATION-review menu:

```
What would you like to do with the SPECIFICATION?

  1. Approve and continue (lock the SPEC, proceed to implementation)
  2. Suggest changes (you describe what to change; the agent rewrites)
  3. Edit yourself (you edit the SPEC directly; the agent waits)
  4. Discuss
  5. Back

Enter confirm / b back / 0 discuss
```

! Every numbered approval menu MUST follow the #767 deterministic-
question framework rule: the **final two numbered options MUST be
`Discuss` and `Back`**, in that order. This is consistent with this
skill's Rule 9 (back-navigation) and Rule 10 (slot-0 discuss-with-agent
escape) and provides a uniform exit path on every menu. The framework
rule itself is being landed by Agent 1 in #767; once
`contracts/deterministic-questions.md` exists, this skill MUST defer to
it for the canonical wording.

- ⊗ Add a numbered approval menu where Discuss and Back are not the
  final two options.
- ⊗ Use plain `Accept / Refine / Edit` buttons without explanatory
  parentheticals.

## Diff-View Preface on PRD / SPEC Review (#740)

! When a PRD or SPECIFICATION review surfaces a red/green diff, the
agent MUST emit a one-line non-alarming preface ABOVE the diff that
sets expectations -- red lines are removals, green lines are additions,
NOT errors. Canonical preface:

```
Here's what changed since the previous draft. Red lines were removed,
green lines were added. Nothing here is broken -- this is a normal
review.
```

? Alternatively, the agent MAY hide the diff entirely on the first
review pass and present a plain-English summary of changes instead;
show the diff only on the second pass or when the user explicitly asks
for it.

- ⊗ Show a red/green diff at first review without a non-alarming
  preface.

## Anti-Patterns

- ⊗ Ask multiple questions in a single message -- one question per turn, always
- ⊗ Proceed to artifact generation without the confirmation gate -- all captured answers must be displayed and explicitly confirmed
- ⊗ Omit the default marker from any question -- every question must have a `[default: N]` option
- ⊗ Omit the "Other / I don't know" escape from any question -- every question must have an escape option
- ⊗ Omit option 0 (freeform conversation escape) from any deterministic question
- ⊗ Re-ask a question after the user accepted the default -- move on immediately
- ⊗ Skip the depth gate and generate artifacts with known ambiguity remaining
- ⊗ Exit the interview without producing a structured answers map for the calling skill
- ⊗ Combine interview questions with artifact generation in the same message
- ⊗ Generate an authoritative PRD.md — interview output targets `specification.vbrief.json` narratives only
- ⊗ Treat PRD.md as a source of truth — it is a read-only export via `task prd:render`
- ⊗ Auto-advance to the next question on number press without echoing the selection and waiting for confirmation
- ⊗ Refuse backward navigation during the interview -- the user must be able to revisit previous answers
- ⊗ Render a deterministic question without the persistent `Enter confirm / b back / 0 discuss` legend directly below the options block **in plain-text rendering mode** (Rule 11 Plain-Text Rendering Mode) -- in click-commit rendering mode the keystroke legend MAY be omitted per Rule 11 Click-Commit Rendering Mode, provided `Back` and `Discuss with agent` still render as clickable options
- ⊗ Use `Pause`, `Escape`, `Other..`, or any non-self-describing label for slot 0 -- the label MUST be `Discuss with agent` (Rule 10)
- ⊗ Place slot-0 `Discuss with agent` at the bottom of the options block or merge it with `Other / I don't know` -- slot 0 MUST be first and visually distinct (Rule 10)
- ⊗ Emit a user-facing question as conversational prose outside the structured tool because the answer content is prose, because the preamble is long, because the question "feels conversational," or because the prior question was plain-text (Rule 2 Always-Structured Rendering, #478)
- ⊗ Omit `Back` or `Discuss with agent` as clickable options in click-commit rendering (Rule 2 Click-Commit Rendering, #477)
- ⊗ Treat a click-commit tool's atomic return as a Rule-8-compliant confirmed commit (Rule 2 Click-Commit Rendering, #477)
- ⊗ Render the Rule 6 Confirmation Gate via a click-commit structured tool on a click-commit host -- the gate MUST be plain-text with a typed `yes` commit (Rule 6 Click-Commit Hosts, #477)
- ⊗ Render the next user-facing question as plain-text conversational prose because the Rule 6 Gate was just rendered in plain-text -- plain-text mode is released after the typed commit (Rule 6 Mode Restore, #478)
- ⊗ Render a user-facing question as plain-text because you wanted to include a long preamble -- preamble belongs above the tool call, not instead of it (Rule 2 Preamble Placement, #478)
