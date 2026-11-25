section: Fixed
- release:run / `release run` no longer self-completes setup before readiness, and stamps that skip on child session:start/setup so tip cuts keep a clean tree through the cut; readiness also re-checks clean after dry-run and uses honest refuse wording (#7327).
