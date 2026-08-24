# ADR-006: parent adjudicating artifacts need independent clearance

**Status**: accepted — successor lean 5388344109 on #3651, synthesis accepted 5388421874.

**Date**: 2026-08-24

**Related**: #3651 (this decision), ADR-005 (judgment gate; omission has no failure mode in prose), #3434 (design-critique motion), #3640 (all-accept auto-stamp), #3156 (gate integrity), #3265 (thin fail-closed).

## TL;DR

A parent artifact that adjudicates a critic finding is an **arbitration surface**. When it introduces a load-bearing premise, it records a substantiation token. That token does not clear the premise. Only a later `role: critic` artifact that targets the marker can clear it. Unresolved markers block verified-synthesis bind.

`content/contracts/design-critique.md` is the sole normative protocol. This ADR records the principle and the refusals. It does not restate the operative MUST and transition lines.

## Context

ADR-005 mechanized recording and refused mechanized judgment. It bound the Stop 5 verified-claims table. It did not bind the parent artifacts that decide what that table contains: the disagreement map, walk decisions, and the successor lean.

In the #3648 arc, parent-introduced premises changed classification and next-build contract. Primary-source citation did not make those readings independent. A later critic caught one such reading only after the parent marked it and named it as an audit target (#3651 n=1 on the mechanism).

#3640 auto-stamps on a total all-`accept-into-contract` map. Audit status is orthogonal to that disposition word. An amend logged as `accept-into-contract` can empty the disagreement set while parent premises stay unaudited.

## Decision

1. **Substantiation at the point of use.** A `role: parent` artifact that introduces a load-bearing premise while adjudicating records dispatch SHA, source pointer, and measured-versus-asserted. This records the premise. It does not decide whether the reading is true.
2. **Independence clearance.** A premise that changes classification, residual, or next-build contract stays unaudited until a later `role: critic` artifact targets its marker.
3. **Unresolved markers block bind.** Auto-stamp and bind path 1 require an all-accept map **AND zero unresolved audit markers**.

Detection lives in `evaluateParentAudit`. A missing token, a silently cleared marker, a parent self-clear, or an envelope that omits a named audit target fails closed.

## Deliberately does not (load-bearing refusals — do not "improve" these away)

1. **Parent adjudicating artifacts are arbitration surfaces.** Do not treat the successor lean, walk, or disposition map as mere notes outside verification.
2. **Primary-source citation is not independent clearance.** The parent citing repository source does not clear the marker. A provenance test would have emitted nothing on the observed errors.
3. **The parent cannot self-clear.** A `role: parent` artifact does not clear its own marker. Mixed-basis laundering is also refused: one independently reproduced premise does not clear an unaudited load-bearing one.

## Consequences

- Walk comments stay slim. A token plus pointer is enough there. The substantiation lives on the parent artifact or its linked successor lean.
- The brief envelope names unresolved marker ids as `audit-targets` (ids only, or `none`). It does not carry parent rationale.
- Content-contract tests pin the contract MUSTs. `evaluateParentAudit` pins the omission failure modes. A string pin of the rule text is not enough.
