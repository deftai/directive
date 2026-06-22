# Plain-English UX Guidelines for Skill Authors

Reference document for skill authors writing user-facing prompts in interview,
PRD review, and SPECIFICATION review skills. Issue:
[#740](https://github.com/deftai/directive/issues/740).

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [skills/deft-directive-interview/SKILL.md](../skills/deft-directive-interview/SKILL.md) | [strategies/interview.md](../strategies/interview.md)

---

## Why This Document Exists

The #151 playtester only completed the planning flow because they had a
second AI translating jargon, decoding ambiguous approval actions, and
explaining red/green diff views. Defects clustered into three buckets:

1. **Jargon without explanations** -- frontend, backend, DB, auth,
   deployment, PRD, Next.js -- shipped raw at users with no plain-English
   context note.
2. **Unclear approval actions** -- "Accept / Refine / Edit" buttons did
   not say what would actually happen on each choice.
3. **Alarming red/green diff view at PRD/SPEC review** -- the diff looked
   like an error report; the user had to ask their other AI whether
   anything was wrong.

This reference codifies the rules that fix all three buckets and the
patterns skill authors should follow going forward.

---

## Rule 1 -- Plain-English Context Note on Every Technical Question

! Every technical question MUST carry a one-line plain-English context
note that explains what the answer affects in non-technical terms.

The context note appears as preamble ABOVE the structured-tool call (per
the interview SKILL Rule 2 Preamble Placement subsection). It does NOT
replace the structured question -- both the preamble AND the structured
options are required.

### Anti-pattern

```
Which deployment platform?

  1. Linux server
  2. Web hosting (cloud)
  3. Embedded
```

### Correct

```
Where will this app actually run for users? This decides whether you
need a server you maintain, a cloud account someone else manages, or
a tiny computer that ships with the product.

  0. Discuss with agent
  ────────────────────
  1. Server you maintain (Linux machine, you handle updates)
  2. Cloud you rent (a hosting service runs it; you pay monthly)
     [default: 2]
  3. Tiny dedicated device (ships inside hardware -- e.g. a thermostat)
  4. Other / I don't know
  5. Discuss
  6. Back

Enter confirm / b back / 0 discuss
```

The plain-English preamble explains the *consequence* of the choice.
The numbered options use plain-English labels with the technical term
in parenthesis (or omit it entirely when the technical term is not load-
bearing).

---

## Rule 2 -- Acronyms Defined Inline on First Use

! Every acronym MUST be defined inline the first time it appears in a
user-facing message within a skill session. The definition format is
`ACRONYM (full expansion)`. Subsequent uses MAY use the acronym alone.

Common acronyms in Deft's interview surface and their canonical
expansions:

- **PRD** (Product Requirements Document) -- "what to build" doc reviewed
  before implementation.
- **NFR** (Non-Functional Requirement) -- a performance / security /
  scalability rule rather than a feature.
- **FR** (Functional Requirement) -- a numbered behavior the spec MUST
  implement.
- **SPEC** (Specification) -- the implementation plan derived from the
  PRD.
- **API** (Application Programming Interface) -- the way two pieces of
  software talk to each other.
- **DB** (Database) -- where the app's data is stored.
- **CI** (Continuous Integration) -- the automated checks that run on
  every change.
- **MVP** (Minimum Viable Product) -- the smallest version of the
  product worth shipping.

### Anti-pattern

```
After PRD review, we'll generate the SPEC and run CI before merging.
```

### Correct

```
After PRD (Product Requirements Document) review, we'll generate the
SPEC (Specification) and run CI (Continuous Integration -- the automated
checks) before merging.
```

After this first sentence, the agent MAY use the acronyms unadorned for
the rest of the session.

---

## Rule 3 -- Framework Justifications Explained or Removed

! When a skill recommends a framework, library, language, or tool, the
recommendation MUST either:

- **Explain why** in plain-English terms the user actually cares about
  (cost, speed, hiring, hosting compatibility, etc.); OR
- **Remove the justification** entirely and present it as a default the
  user can override.

⊗ Drop a framework name with a one-word "modern" or "industry-standard"
justification. That phrasing is jargon-flavoured advertising and the
user has no way to evaluate it.

### Anti-pattern

```
Recommended: Next.js (industry-standard, modern).
```

### Correct (explained)

```
Recommended: Next.js -- a popular toolkit for building websites that
need both pages and live data. Picking it now means more example code
on the internet and easier hiring later.
```

### Correct (removed)

```
Default: Next.js. Pick "Other" below if you want a different web
framework and we'll capture your reason in the spec.
```

---

## Rule 4 -- Numbered Approval Menu After PRD and SPEC Review

! After every PRD review AND every SPECIFICATION review, the agent MUST
present an explicit numbered approval menu. The menu replaces ambiguous
buttons like "Accept / Refine / Edit" with action-shaped labels that
state what will happen.

### Canonical Menu Shape (PRD review)

```
What would you like to do with the PRD?

  1. Approve and continue (lock the PRD, generate the SPECIFICATION)
  2. Suggest changes (you describe what to change; the agent rewrites)
  3. Edit yourself (you edit the PRD directly; the agent waits)
  4. Discuss
  5. Back

Enter confirm / b back / 0 discuss
```

### Canonical Menu Shape (SPECIFICATION review)

```
What would you like to do with the SPECIFICATION?

  1. Approve and continue (lock the SPEC, proceed to implementation)
  2. Suggest changes (you describe what to change; the agent rewrites)
  3. Edit yourself (you edit the SPEC directly; the agent waits)
  4. Discuss
  5. Back

Enter confirm / b back / 0 discuss
```

### Discuss + Back Are the Final Two Options (#767 framework rule)

! Every numbered approval menu MUST follow the #767 deterministic-
question framework rule: the final two numbered options MUST be
`Discuss` and `Back`, in that order. This is consistent with the
interview SKILL's Rule 9 (back-navigation) and Rule 10 (slot-0
discuss-with-agent escape) and provides a uniform exit path on every
menu the user sees.

! When `contracts/deterministic-questions.md` lands (Agent 1, #767),
this reference doc and the canonical menu shapes MUST be re-read against
that contract; any inconsistency is fixed by editing this doc, not the
contract.

⊗ Add a numbered approval menu where Discuss and Back are not the
final two options. ⊗ Use plain "Accept / Refine / Edit" buttons without
explanatory parentheticals.

---

## Rule 5 -- Diff-View Preface (Non-Alarming)

! When a PRD or SPECIFICATION review surfaces a red/green diff (e.g. via
`git diff` or any structured-diff renderer), the agent MUST emit a one-
line non-alarming preface ABOVE the diff. The preface MUST set
expectations that red lines are removals and green lines are additions
in the new version, NOT errors.

? Alternatively, hide the diff entirely on the FIRST review pass and
present a plain-English summary of changes; only show the diff on the
second pass or when the user explicitly asks for it.

### Canonical Preface

```
Here's what changed since the previous draft. Red lines were removed,
green lines were added. Nothing here is broken -- this is a normal
review.
```

### Anti-pattern

```
[diff output starts immediately with no preface]
```

The user sees red and green and reads it as an error report; this is
exactly the #151 #11 playtest defect.

---

## Rule 6 -- Audience Test

! Before shipping a question or output line in a user-facing skill, run
the **audience test**: read the line aloud and ask "would a non-technical
person understand the *consequence* of this choice?". If the answer is
no, rewrite or add a context note.

The audience test is not a heuristic the agent runs at runtime -- it is
a content-review rule for skill authors at edit time.

---

## Anti-Patterns

- ⊗ Drop a technical question on the user without a plain-English
  context note above it.
- ⊗ Use an acronym for the first time without inlining `(full
  expansion)`.
- ⊗ Recommend a framework with one-word jargon-flavoured justification
  ("industry-standard", "modern", "scalable").
- ⊗ Present an approval menu without explicit numbered actions whose
  labels state what will happen.
- ⊗ Place Discuss / Back anywhere except as the final two numbered
  options of an approval menu (per #767).
- ⊗ Show a red/green diff at first review without a non-alarming
  preface.
- ⊗ Treat "the user can ask their other AI to translate" as an
  acceptable mitigation for jargon. The user's other AI is not a Deft
  surface and is not a reliable communication channel.
