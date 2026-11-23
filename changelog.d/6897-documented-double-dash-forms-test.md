section: Added
- test(cli): a new test checks every documented `deft <verb> -- ` form in AGENTS.md, the agents-entry template, the agent preamble and the swarm and review-cycle skills. It runs each form through the real router and parser with and without the `--` and requires the same result; a missing or stale probe entry fails (#6897).
