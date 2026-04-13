---
name: deft-interview
description: >
  Deterministic structured Q&A interview loop. Use when any skill needs to
  gather structured input from the user through a series of focused questions
  with numbered options, stated defaults, and a confirmation gate before
  artifact generation.
---

# Deft Interview

Deterministic interview loop that any skill can invoke to gather structured user input.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- Another skill needs to gather structured input from the user (e.g. deft-setup Phase 1/Phase 2)
- User says "interview", "ask questions", or "structured interview"
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
- The default option number (e.g. "2")

! Do NOT re-ask the question when the user accepts the default. Record the default value and proceed to the next question.

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

- ! The calling skill defines the expected keys in its invocation of deft-interview
- ! The answers map MUST contain a value for every required key defined by the calling skill
- ! Optional keys may be omitted if the user did not provide input and no default was applicable
- ~ The calling skill is responsible for validating the answers map against its own schema and requesting re-interview for any missing or invalid fields

## Invocation Contract

deft-interview supports two usage modes:

### Embedded Mode

The calling skill references deft-interview rules inline (e.g. "this phase follows the deterministic interview loop defined in `skills/deft-interview/SKILL.md`") and applies the rules directly within its own question sequence. No formal contract object is needed -- the calling skill embeds the question definitions and field requirements in its own SKILL.md. This is the current approach used by `skills/deft-setup/SKILL.md` Phase 1 and Phase 2.

### Delegation Mode

The calling skill explicitly invokes deft-interview as a sub-skill and passes a formal contract object. When using delegation mode, the calling skill MUST provide:

1. **Required fields**: list of field names that must be captured (the depth gate uses this to determine completeness)
2. **Question definitions**: for each field, the question text, numbered options (if applicable), and default value
3. **Optional fields**: list of field names that may be skipped

The calling skill MAY provide:
- **Context preamble**: a brief description of why these questions are being asked (shown to the user before the first question)
- **Validation rules**: constraints on acceptable values for specific fields

## Anti-Patterns

- ⊗ Ask multiple questions in a single message -- one question per turn, always
- ⊗ Proceed to artifact generation without the confirmation gate -- all captured answers must be displayed and explicitly confirmed
- ⊗ Omit the default marker from any question -- every question must have a `[default: N]` option
- ⊗ Omit the "Other / I don't know" escape from any question -- every question must have an escape option
- ⊗ Re-ask a question after the user accepted the default -- move on immediately
- ⊗ Skip the depth gate and generate artifacts with known ambiguity remaining
- ⊗ Exit the interview without producing a structured answers map for the calling skill
- ⊗ Combine interview questions with artifact generation in the same message
