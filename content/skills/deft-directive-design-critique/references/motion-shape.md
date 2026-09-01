# Design critique — motion shape

Orientation only. Normative rules: [`contracts/design-critique.md`](../../../contracts/design-critique.md).

## Same-round critics

- Parallel, not sequential. Each critic in a round reads one fixed input ceiling set before any sibling dispatch.
- A sibling's post is out of envelope for every other sibling in that round — they cannot read each other through the issue thread.
- Serial dispatch (critic B after critic A posts) destroys isolation even when bind guards still pass.

## Who adjudicates

| Step | Actor | Action |
|------|-------|--------|
| After same-round siblings are posted | Parent | Post successor lean with proposed per-heading takes |
| Before bind/stamp | Operator | Confirm or amend that lean |
| Next envelope | Operator (or parent after operator verb) | Fill brief template and dispatch |

Comment-lead chips (model then role) govern comment signing — see brief template and Stop 3.
