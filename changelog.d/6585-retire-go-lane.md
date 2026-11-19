section: Changed
- CI: the no-op Go lane is removed (three jobs, its watchdog and arm wiring, its lane steps, its test assertions and doc lines), so every non-artifact-only run stops paying for a runner that tests nothing. Refs #6585.
