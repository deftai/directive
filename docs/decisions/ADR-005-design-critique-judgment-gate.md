# ADR-005: design-critique Phase 1 is a judgment gate — mechanize the paperwork, never the judgment

**Status**: accepted — operator acceptance of the #3434 Phase-1 lock on 2026-08-20, recorded on that issue. The v1 vehicle was locked the same day via the discuss strategy (hybrid: contract doc as SoT + brief template + thin router skill — see `xbrief/proposed/2026-08-20-design-critique-v1-vehicle-context.xbrief.json`); Phases 2–5 defaults and the remaining critique amendment items stay open on #3434.

**Date**: 2026-08-20

**Related**: #3434 (this decision), #1419 (judgmentGates mechanism), #1423 (triage write-back format — marker home), #3156 (gate integrity), #3265 (thin fail-closed), #1140 (operator-driven-iteration gap), #3383 / #3462 / #3547 (exemplar arcs), #3570–#3572 (naive-orchestrator exemplar), `xbrief/proposed/2026-08-20-design-critique-v1-vehicle-context.xbrief.json` (v1 vehicle LockedDecisions).

## TL;DR

The design-critique gate never computes "is this triage mechanism-shaped." The triage author **stamps** that judgment as a machine-readable marker; a `plan.policy.judgmentGates` entry **matches** the marker syntactically; the engine **fails closed only on a missing clearance** — the recorded `design-critique: warranted | not warranted, because …` line — never on its content. Three pieces of declared data, no skill behavior, rolled out advise → observe → block per #1419.

## Context

Across four exemplar arcs and two controlled experiments, every logged process failure was a **recording failure, not a judgment failure**: judgments, when actually made, were mostly right; what failed was that they weren't made, weren't recorded, weren't attributable, or weren't checkable. The decisive evidence: a naive orchestrator given only "see #3434 for guidelines" (issues #3570–#3572, 2026-08-21) reconstructed the entire protocol from prose — triage insertion, id ceilings, method columns, endorsed-vs-measured evidence taxonomy, same-day adoption of the Pass-4 deltas — **except the gate**. No gate line was recorded, and the arc fired on a disposition-only triage (#3572) where the mandatory gate should not have tripped. Prose carries behavior; it cannot carry omission rules, because omission has no failure mode in prose.

Symmetrically, every attempt in these arcs to push a semantic judgment *into* a mechanism failed: #3383 rejected the semantic contradiction detector; the Pass-4 Arm-2 charter line died on a wording technicality; a "mechanism-shaped" classifier would be the same class — a fuzzy detector in a deterministic costume that either never fires or always fires.

## Decision

Phase 1 of the design-critique motion is three pieces of declared data:

1. **Marker (semantic judgment, stamped).** The triage author decides whether the lean is mechanism-shaped and stamps it: a body-text field in the triage write-back comment (#1423 format) **and** a mirrored issue label. The field is the authoritative artifact; the label is the gate-matchable, list-visible mirror (#1423's label-mirror pattern). A wrong stamp is possible; a recorded misclassification is an auditable lie, where the prior failure mode was invisible omission.
2. **Gate (deterministic trigger).** A `plan.policy.judgmentGates` entry (#1419) matching the marker via the existing predicate set (`labels`, `body-text`, `state` — already issue-shaped, `judgment-policy.ts:9`). Pure syntax.
3. **Clearance (recorded judgment).** The gate line — `design-critique: warranted | not warranted, because …` — posted on the triage thread. `verify:judgment-gates --enforce` fails closed when the gate fires and no clearance exists. The engine evaluates presence, shape, and authority — never content.

**Rollout**: #1419's advise → observe → block. The observe phase's fire rate and clearance rate are the instrumentation #3434 already requires; `--enforce` turns on only after they prove the marker is applied honestly.

**Voluntary critiques stay legal**: no marker → gate never fires → a critique is discretionary operator spend. The gate makes the mandatory case unskippable; it does not forbid the optional one.

## Deliberately does not (load-bearing refusals — do not "improve" these away)

1. **Does not compute the semantic classification.** The author stamps it. Every mechanized-semantics attempt in this arc failed (#3383 detector, Arm-2 charter wording); a classifier here would be the same class.
2. **Does not evaluate clearance content.** Presence, shape, authority only. Content evaluation converts the gate into a self-adjudicating reviewer (#3156).
3. **Does not mandate critique without the marker.** Profitable voluntary critiques (#3572's span-less-residual finding) are legal spend, not protocol violations — and not precedent for always-fire.
4. **Does not start at `--enforce`.** Advisory first; the observe phase exists so the fire rate is measured before it can block work.

## Parameters (decided with this ADR unless amended at acceptance)

| Parameter | Decision | Why |
|---|---|---|
| Marker vocabulary | Body-text field in the triage write-back + mirrored label | Field survives as artifact; label is what predicates match and lists show; #1423 owns the pairing |
| `--enforce` attach point | `scope:promote` | Earliest lifecycle chokepoint after triage; implement dispatch is too late — work is already scoped |
| Clearance authority | Model-recordable; human review at promote; `required_human_reviewers: 1` reserved for block tier post-observe | Matches propose-not-apply; keeps headless pipelines functional during advisory phase |

## Root causes (why this shape, condensed from the #3434 record)

1. Silent omission has no failure mode in prose — gates are absence-detectors by construction (naive-orchestrator run; #1140).
2. Semantic judgments in mechanisms become fuzzy detectors or dead letters — stamp, don't compute (#3383; Pass-4 Arm 2).
3. Correlated agreement was read as verification — the fixes that worked were recording obligations, not smarter judges (#3547 count artifact; method column).
4. Prose gates self-adjudicate by default — split author-stamp / policy-trigger / engine-enforced clearance / external authority (#3156).
5. Unmandated artifacts vanish — #3462's critic record was destroyed and survives only as paraphrase; the gate line is the smallest artifact making the fire/no-fire decision permanent.

Common root: operator vigilance was the load-bearing mechanism, and vigilance does not scale to naive orchestrators. Mechanizing the recording obligation worked everywhere it was tried; mechanizing the judgment failed everywhere it was tried.

## Consequences

- The gate is implementable without resolving the #3434 v1-vehicle question: all candidate vehicles (skill, composition doc, guidelines prose) consume the same three declared-data pieces.
- The triage write-back format (#1423) gains one field; `plan.policy.judgmentGates` gains one entry; no new subsystem.
- Future critics of this design should attack the parameters table and the refusals section — those are the surfaces where drift or "improvement" would re-open solved failure classes.
