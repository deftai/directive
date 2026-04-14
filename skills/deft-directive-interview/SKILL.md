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
1. Cross-platform (Linux / macOS / Windows)
2. Web / Cloud [default: 2]
3. Embedded / low-resource
4. Other / I don't know
0. Pause -- discuss this question with the agent
```

- ! The default MUST be stated inline with the option (e.g. `[default: 2]`), not in a separate line or footnote
- ! If no option is objectively better, pick the most common choice and mark it as default
- ~ Use structured question tools (AskQuestion, question picker, multi-choice UI) when available

### Rule 3: Explicit "Other / I Don't Know" Escape

! Every question MUST include an escape option. The last numbered option MUST be either:
- "Other (please specify)" -- for open-ended alternatives
- "I don't know" -- when the user may lack context to answer
- "Other / I don't know" -- combined form (preferred)

- ⊗ Present a question with no escape option -- the user must always have a way out
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

Interview output writes to `specification.vbrief.json` `plan.narratives` — the vBRIEF draft is the sole authoritative output. PRD.md is never generated.

### Full Path Output

! On the Full path, the interview populates `specification.vbrief.json` `plan.narratives` with `status: draft` and rich keys:

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

! After the user enters a number to select an option, the agent MUST echo the selected option text and wait for explicit confirmation before advancing to the next question.

Example:
```
Which deployment platform?
1. Cross-platform (Linux / macOS / Windows)
2. Web / Cloud [default: 2]
3. Embedded / low-resource
4. Other / I don't know
0. Pause -- discuss this question with the agent

> User: 1

You selected: **Cross-platform (Linux / macOS / Windows)**
Confirm? (Enter to confirm, or type a different number)
```

- ! Show the selected option text after each number entry -- the user must see what was selected
- ! Wait for Enter / confirmation before advancing -- do not auto-advance on number press
- ! If the user types a different number instead of confirming, switch to that option and re-confirm
- ⊗ Auto-advance to the next question immediately after the user presses a number key

### Rule 9: Backward Navigation

! The agent MUST support backward navigation during the interview. At any question, the user may type `back`, `prev`, or `b` to return to the previous question and change their answer.

- ! When the user navigates back, re-display the previous question with the previously selected answer shown
- ! The user may change the answer or confirm the existing one
- ~ The agent should inform the user of backward navigation availability at the start of the interview (e.g. "Type 'back' at any question to revisit the previous answer")
- ⊗ Refuse to let the user revisit previous answers during the interview

### Rule 10: Freeform Conversation Escape (Option 0)

! Every deterministic question MUST include an option `0` that pauses the structured flow and opens a freeform conversation with the agent.

- ! Option 0 text: `0. Pause -- discuss this question with the agent`
- ! When the user selects 0, the agent enters a freeform conversation mode where the user can ask clarifying questions, request more context about the options, or explain nuance
- ! The agent MUST explicitly resume the deterministic flow when the conversation is resolved: re-display the same question and wait for a numbered answer
- ⊗ Continue the deterministic flow while in freeform conversation mode
- ⊗ Omit option 0 from any deterministic question

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
