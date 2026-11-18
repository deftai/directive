section: Fixed
- Lifecycle: `xbrief:activate` (`vbrief:activate`) now runs the small-change lane gate and its #4768 ingress waiver through the same helper as `scope:activate`. It admits a thin lane brief that `scope:activate` admits, and it refuses a crossed, over-bound or incompletely escalated lane brief before any move, from `pending/` and from `active/` (#6264, #6204).
