section: Fixed
- A post-merge completion PR that holds only what `scope:complete` wrote (the brief move, its spec-drift row and the project definition's open-scope rows for that brief) passes the merge gate again, and `swarm:finalize-cohort` commits the project definition with the move. Refs #6764.
