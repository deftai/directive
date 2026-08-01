# No in-band signaling / absence is not a decision (#1695)

Coding-standards pattern: do not overload one field (or its
presence/absence) to carry two orthogonal facts. Separate **value** from
**decision-provenance**. Triggered by the wipCap onboarding contradiction
(#1694).

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Load when:** modeling a config/policy field, or any onboarding /
decision / lifecycle state that might be inferred from whether a value
is present.

**⚠️ See also**:
- [../coding/coding.md](../coding/coding.md) — always-loaded Design
  Principles floor (`**State & Data Modeling (#1695)**`)
- [../coding/coding.md](../coding/coding.md) — resolver `source`
  provenance (typed | default | default-on-error) for *value*-provenance

## The pattern

**In-band signaling** smuggles control or metadata through the data
channel. **Out-of-band signaling** gives the control signal its own
field.

The cautionary prior art is the blue-box / 2600 Hz tone: phone systems
shared the control signal with the voice channel, so a tone on the data
path could seize trunk control. The same footgun appears under several
names:

- Overloaded NULL / sentinel values (SQL NULL meaning "unknown" *and*
  "not applicable" *and* "use default")
- Connascence of Meaning (Page-Jones) — components silently agreeing
  what a magic value or absence *means*
- "Make illegal states unrepresentable" — an ambiguous
  "absent-but-decided vs absent-and-undecided" state should not be
  expressible in one field
- Single Responsibility applied to data — one field, one reason to
  change

- ! MUST encode exactly one fact per field
- ! MUST record decision / onboarding / lifecycle state in an explicit
  out-of-band marker when a workflow needs to know a human chose
- ⊗ MUST NOT infer decision-state from whether a value field is present
- ⊗ MUST NOT treat field absence as "incomplete" when omission is a
  deliberate valid default

## The orthogonality test

Ask: can fact A and fact B vary independently?

| Fact A (value) | Fact B (decided?) | Independent? |
| --- | --- | --- |
| value == default | decided = true (accepted default) | yes |
| value == default | decided = false (never considered) | yes |
| value == override | decided = true | yes |
| value == override | decided = false | usually illegal |

If two facts can vary independently, they MUST live in separate slots.
If one fact strictly implies the other, sharing a slot is fine:

- **True `Optional<T>`** — absence means "no value" and there is no
  second "was this considered?" question
- **Tombstones** — a dedicated deleted/absent sentinel that only means
  lifecycle, not a configured value
- **Value-provenance `source`** — once a resolved value exists, source
  ∈ {typed, default, default-on-error} is a property *of that resolve*,
  not a second independent human decision

Worked examples:

1. **WIP cap onboarding (#1694)** — `plan.policy.wipCap` value vs "did
   the operator consider a cap?" Independent; use
   `x-directive/onboarding.wipCapDecided`.
2. **Feature flag default** — `enabled: false` may mean "deliberately
   off" or "never configured." If product needs the distinction, store
   an explicit decided marker.
3. **Optional timeout** — absence of `timeoutMs` means "use library
   default" and no workflow asks whether a human considered it. One
   fact; one field is fine.

## Three kinds of provenance in directive

Directive already separates two of three facts for policy resolution:

| Kind | What it answers | Modeled? |
| --- | --- | --- |
| **Effective value** | What int/string do we use right now? | yes (the field or default) |
| **Value-provenance** | Override vs framework default vs error-fallback? | yes (`source` on resolvers / `PolicyField`) |
| **Decision-provenance** | Did a human choose this (including accepting default)? | **must be modeled out-of-band** |

- ! MUST generalize the `source` discipline to decision-provenance:
  never fake "operator decided" from field presence
- ! MUST leave value fields to mean exactly one thing (e.g.
  `plan.policy.wipCap` = deliberate non-default override only)
- ~ SHOULD keep decision markers under an `x-directive/` namespaced
  block when the value lives on PROJECT-DEFINITION

## Canonical worked example — wipCap onboarding (#1694)

**Before:** `_classify_onboarding` / `classifyOnboarding` treated
absent `plan.policy.wipCap` as incomplete onboarding. Accepting the
framework default (omit-by-design, #1186 D1 / #1250) left the field
absent forever, so the nudge never cleared. Setting a non-default
cleared the nudge but broke `test_policy_omits_wip_cap`. The nudge was
structurally unsatisfiable on deft's own repo.

**Root cause:** one field carried two orthogonal facts — configured
value *and* decision-made.

**After (#1694 direction 2):**

- `plan.policy.wipCap` (or `x-directive/policy.wipCap`) means only a
  deliberate non-default override
- `plan["x-directive/onboarding"].wipCapDecided` records that the
  operator considered WIP cap (including accepting the default)
- `writeWipCapDecision` / `writeWipCap` (default path) set the marker
  without materializing the value field
- `classifyOnboarding` reads decision-provenance, not field presence

Greenfield consumers still get prompted until they run
`deft triage:welcome --onboard` (or otherwise record the decision).
Deft's own repo commits the marker with `acceptedDefault: true` and
stays omit-by-design green.
