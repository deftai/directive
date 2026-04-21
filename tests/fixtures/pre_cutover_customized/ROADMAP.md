# Widget Service Roadmap

## Phase 1 -- Foundation

Fix the blocking setup gaps before any feature work.

- **#101** -- Scaffold FastAPI app with SQLite
- **#102** -- Add request-id logging middleware

## Phase 2 -- Core API

### Tier 1 -- CRUD

- **#201** -- POST /widgets: create a widget
- **#202** -- GET /widgets/{id}: fetch by id
- **#203** -- GET /widgets: list by owner

### Tier 2 -- CLI

- `t3.1` Implement widgets add CLI wrapping POST /widgets
- `t3.2` Implement widgets list CLI wrapping GET /widgets

## Phase 3 -- Operations

Items in this phase exercise the slug-safe ID sanitiser -- titles contain
spaces, slashes, `<id>` placeholders, and `@` prefixes that previously
leaked through as scope-registry ids and scope vBRIEF filenames.

- `task update-index -- --repo <id>` Builds the widget index for a repo
- `docker compose up -d` Document the supported compose workflow
- `@slizard dismiss` Dismiss a slizard escalation via CLI

## Completed

- ~~#50 -- Initial project scaffolding~~
- ~~#51 -- CI pipeline bootstrap~~
