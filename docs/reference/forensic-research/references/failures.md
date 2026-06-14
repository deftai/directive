# Known skill failures (regression patterns)

Document real runs where agents violated discipline. Add traps in your domain pack so repeats are structurally blocked.

See `examples/slizard/failures.md` for detailed SLizard war stories.

---

## Compliance failures (any project)

| Failure | Detection |
|---------|-----------|
| No investigation dir | No `.tmp/investigations/<id>/` after "conclusion" |
| Config from code/docs | Cited source instead of runtime env/secrets |
| Architecture storytelling | Explained how system *can* work, not what *did* happen |
| Waves 3–4 skipped | `wavesCompleted` lacks 3 or 4; early causal chat |
| `freshPullGap` sub-agent | Trap-runner cites docs without `evidence/` refs |
| Concurrency without proof | Stated saturation without lifecycle/metric evidence |
| Tautology close | §2 only restates duration or timeout |
| Missing §2b | Mechanism inferred without observability gap callout |
