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
| Before bind/stamp | Operator | Confirm or amend that lean. Under yolo, a bind-capable first all-accept lean carries honest pain cites and does not wait on that turn (Yolo leftover-pain). |
| Next envelope | Operator (or parent after operator verb) | Fill brief template and dispatch. After a bind-capable lean under yolo, not operator next-envelope; the parent fills a pain-audit brief while a Dual-stop numbered or reserved slot remains; if both are spent, raise the cap or halt. |

Comment-lead chips (model then role) govern comment signing — see brief template and Stop 3.

## Handback acceptance (#3979)

Before a child completion claim may count as a posted same-round sibling, run `evaluatePanelSeatDelivery` / `evaluatePanelSeatDeliveryFromThread` (consumes `acceptDispatchPostcondition`). Parent/host thread reads bind; child claimed comment ids and probes do not. Failed verification is dispatch-failure, not success. Unknown reads never accept. Shape-2 tool counts are complementary only. Does not close #3850's held behavioural panel-completeness half — it only makes unverified handbacks uncountable. Unbounded fan-out host gates stay deferred.
