# ADR-002: Forge-provider Azure DevOps adoption gate (pre-/post-1.0)

**Status**: proposed — filed from maintainer review of epic #2651; not an authorization to implement.

**Date**: 2026-07-21

**Related**: #2651 (epic), children #2715–#2733, #881, #1145, #1119, #935, #9, #445

## TL;DR

Epic #2651 proposes a **forge-layer rewrite** of Directive’s SCM nervous system (extract GitHub behind a provider contract, then add Azure Boards + Repos). That is not an Azure add-on.

**Proposed decision:** do **not** implement #2651 or its children until explicit maintainer buy-in. Default posture for the 1.0.0 train: **defer** this program past 1.0.0 unless a recorded adoption decision changes that. Children #2715–#2733 are labeled `status:blocked` and body-gated accordingly; the AFK slice is planning only.

## Context

- Spike-backed RFC on #2651 describes end-to-end Azure DevOps Services support via an internal `ForgeProvider` contract.
- Nineteen AFK children (#2715–#2733) already name concrete file scopes and say (before the hold) that Wave 1 can start immediately.
- Wave 1 extracts shipped GitHub behavior before any Azure adapter lands — blast radius includes cache, triage, intake, reconciliation, PR readiness/watch/wait, swarm auth, references, and the SCM boundary verifier.
- Existing GitHub consumers are promised behavioral parity, but still pay the refactor risk.
- Related open work (#881 `scm:*` namespace, #1145 verb-boundary scaffold, #935 SCM-adapter placeholder) overlaps the abstraction choice; relationship is not locked.
- Live Azure org round-trip was not part of the spike; acceptance still requires gated live tests (#2733).

## Decision (proposed)

1. **Adoption is a product decision, not a child-dispatch decision.** Filing or slicing children does not authorize Wave 1.
2. **Default for 1.0.0:** keep #2651 out of the 1.0 release train unless maintainers explicitly adopt it (this ADR moves to `accepted` with a dated adoption note, or a superseding ADR records a different schedule).
3. **Operational hold (already applied):** all children #2715–#2733 carry `status:blocked` (+ `design` / `rfc`) and a `## Blocked by` hold pointing at #2651 adoption and this ADR. Wave dependencies remain secondary under that hold.
4. **Before any `accepted` adoption,** lock the open questions below (or explicitly defer them with named follow-ups). Do not start F1/#2715 while they remain illustrative.

## Consequences

### If this proposed posture holds (defer past 1.0)

- GitHub-first operator workflows stay on the current `gh` / #1145 scaffold through 1.0.
- Azure customers remain out of scope for first-class Boards/Repos lifecycle until a later release train.
- Children stay visible as a design slice but must not enter `pending`/`active` implementation without lifting `status:blocked` after ADR acceptance.

### If maintainers later accept adoption (pre- or post-1.0)

- Wave 1 still lands first: provider contracts + GitHub extraction + boundary tests, with GitHub parity as the exit gate.
- Greptile/SLizard remain optional GitHub capabilities; Azure readiness must define its own merge-ready semantics.
- Public `scm:*` names may remain for compatibility; internal forge contracts become the real provider boundary (relationship to #881 must be stated in the acceptance update).
- Capability matrix, auth defaults, and lossy label/state mappings ship as documented product surface, not silent guesses.

### What this ADR does not authorize

- Starting any #2715–#2733 implementation work.
- Treating the illustrative TypeScript contract in #2651 as frozen API.
- Claiming Azure DevOps Server, Pipelines, Artifacts, or third-party Azure review-bot parity.

## Open questions (must lock before Status → accepted)

1. **Schedule:** adopt before 1.0, after 1.0, or park indefinitely?
2. **Abstraction home:** internal `ForgeProvider` vs agent-facing `#881 scm:*` — supersede, subsume, or parallel?
3. **Merge-ready on Azure:** what replaces CLEAN / NEW_P0_P1 / ERRORED when Greptile/SLizard are absent?
4. **Label/tag and process-state defaults:** who configures lossy mappings; what ships as defaults?
5. **Cross-project Boards vs Repos:** first-class in v1 or defer?
6. **Auth product default:** Entra vs CLI vs PAT for interactive, headless swarm, and CI?
7. **Closing-keyword / protected-work semantics** on explicit Azure work-item links.
8. **Umbrella current-shape** equivalent on Boards (#1152 is GitHub-comment shaped).
9. **Preview API** allow-list for “first class” policy/comment operations.
10. **Live validation:** disposable Azure org/project/repo + CI secrets before claiming first-class.

## Alternatives considered

- **Implement Wave 1 now “for cleanliness” without Azure.** Rejected under the proposed posture: still imposes forge/cache/identity churn on every GitHub consumer without an adopted product destination.
- **Azure shim beside `gh` without GitHub extraction.** Rejected by #2651’s own architecture (and correctly so for long-term dual-forge), but that rejection is expensive; it needs buy-in, not silent AFK start.
- **Close children until ADR accepted.** Optional later hygiene; `status:blocked` + body hold is the minimum enforceable stop for AFK dispatch.
- **Label-only hold without ADR.** Insufficient: labels stop dispatch; they do not record the schedule/abstraction tradeoff for 1.0 planning.

## References

- #2651 — feat(scm): first-class Azure DevOps support (Boards + Repos)
- #2715–#2733 — sliced children (held)
- #881 — `scm:*` task namespace (platform-abstract)
- #1145 — source-agnostic verb boundary scaffold (shipped)
- #1119 — cache-as-operator-working-set tracker hygiene
- #935 — beta readiness / SCM-adapter placeholder
- #9 / #445 — non-GitHub trackers / VCS-agnostic interface
- Maintainer review comment on #2651 (workflow impact, baked-in bets, undecided assumptions)
- `docs/decisions/ADR-001.md` — ADR format precedent
- `content/languages/markdown.md` — ADR convention
