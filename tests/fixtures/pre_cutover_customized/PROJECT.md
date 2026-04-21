# Widget Service Project Guidelines

Custom project rules for the Widget API -- hand-authored, no auto-generated
markers. Exercises the migrator's user-customization detection path.

## Tech Stack

Python 3.12, FastAPI, SQLite, httpx, typer. stdlib-only for runtime;
pytest + pytest-cov for tests.

## Project-Specific Rules

- All new endpoints MUST include an integration test
- SQLite schema migrations live under `migrations/` and MUST be idempotent
- No worker queues until we outgrow SQLite; re-evaluate at 10k widgets

## Branching

- `master` is the integration branch
- Feature branches use `feat/<issue>-<slug>` naming
- Squash-merge only; no force-push to `master`
