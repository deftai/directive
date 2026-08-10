# ADR-003: Nuclear-family A2A topology (bounded agent-messaging graph)

**Status**: accepted — docs/rule posture for Directive swarm and local agent-to-agent messaging (#3155); decision input to #2705.

**Date**: 2026-08-09

**Related**: #3155 (this deliverable), #2705 (A2A client posture ADR — remainder deferred), #2706 / #2707 (A2A follow-ons), #3158 (retained addressable children — pair; runtime out of scope here), #3179 (parent epic; bounded multi-agent graphs), #480 (compositional-fragment defense), #515 (swarm knobs taxonomy — messaging-graph as named knob lives there).

## TL;DR

Directive agent-to-agent messaging uses a **nuclear-family** graph only: **parent, siblings (same cohort / same parent), and children**. Open mesh across arbitrary sessions or cohorts is forbidden. This lands as accepted swarm + security doctrine *before* more A2A surface ships.

The **full outbound A2A client posture ADR** (client-only v1, Agent Cards trust model, auth separation, artifact import, concept map) remains **deferred on #2705** — this ADR does not close that issue; it only locks the bounded-graph decision #2705 / #2706 / #2707 must not contradict.

## Context

- Directive is building A2A-related surfaces (#2705 family) and already defends compositional-fragment attacks in swarm mode (#480).
- Without a named graph bound, "agents everywhere" becomes the default temptation as retained children (#3158) and remote A2A clients land.
- Prime Agent practice: shortest useful graph for security and chaos control.
- #3179 product shape includes **bounded multi-agent graphs**.
- A comment on #3155 once narrowed residual scope toward security/#2705 only; the **issue body** (cleanup pass: body is scope ceiling) still requires named topology in swarm canon plus security rationale plus ADR posture.

## Decision

1. **Nuclear-family topology is accepted** for Directive-local swarm and any local A2A messaging that inherits swarm doctrine:
   - Allowed edges: parent ↔ child, sibling ↔ sibling (same parent/cohort only).
   - Cross-cohort / cross-session coordination goes through a shared parent or durable parent-owned artifacts (issues, PRs, xBRIEF, decision log) — not peer mesh links.
2. **Open mesh is forbidden** as default product topology ("agents everywhere").
3. **Retained children (#3158) do not relax the bound** — long-lived edges still stay nuclear-family.
4. **Compositional-fragment defense still applies** on allowed edges — topology bounds *who* may talk; #480 bounds *how* aggregated content is trusted.
5. **#2705 remainder deferred with reason:** client-only posture, Agent Card trust ladder, credential separation, artifact import rules, and A2A concept map stay on #2705 because they are wire/protocol product decisions independent of the local graph bound. Encoding the graph bound first is cheaper than retrofitting after open-mesh habits form. #2705 MUST treat this ADR as a non-negotiable decision input when written; it MUST NOT re-open open-mesh as default.

## Consequences

### Enables

- Swarm orchestrators and skill authors share one named rule for dispatch graph design.
- #3158 retained-child semantics can document messaging without inventing topology.
- #2706 / #2707 spikes inherit a graph ceiling before implementation.

### Requires

- Rule body in `content/swarm/swarm.md` `## Communication Topology (#3155)` (projection of `packs/swarm-spec/swarm-spec-pack-0.1.json`).
- Security rationale in `content/meta/security.md` `## Unbounded A2A graphs (#3155)`.
- Future A2A docs/ADRs cite this ADR; do not silently contradict it.

### Does not authorize

- Full A2A protocol implementation.
- Retained-child runtime (#3158).
- Publishing workers as public A2A Server Agent Cards.
- Closing #2705 without its remaining client-posture acceptance criteria.

## Alternatives considered

- **Open mesh with per-edge policy later.** Rejected: unbounded graphs multiply attack surface before policy exists; retrofit cost is high.
- **Parent-only star (no sibling edges).** Rejected as too strict for cohort coordination already practiced in swarm (sibling attribution, compositional-fragment audit across workers); nuclear family keeps siblings under one parent.
- **Defer topology until #2705 ADR ships.** Rejected: #3158 and swarm growth need the bound now; #2705 remainder is orthogonal wire posture.
- **Document only in #515 knob list.** Rejected for security residual: issue body requires swarm canon + security rationale + ADR posture, not only a design-space inventory entry.

## References

- Rule: `content/swarm/swarm.md` `## Communication Topology (#3155)`
- Security: `content/meta/security.md` `## Unbounded A2A graphs (#3155)`
- Issues: #3155, #2705, #3158, #3179, #480, #515
- Protocol background (non-normative for this ADR): https://a2a-protocol.org/latest/
