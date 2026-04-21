# Widget API SPECIFICATION

This is a synthetic pre-cutover specification used as the input fixture for
the #498 golden-file migration test. It exercises the structural sections
that the migrator's reconciler and ingester surface: PascalCase and
space-separated ## headings, FR-N traces, Depends-on lines, and per-task
status markers.

## Problem Statement

Operators managing widget inventories need a deterministic HTTP surface so
dashboards, CLIs, and workflow tools can CRUD widgets without guessing
server-side shapes. The hand-rolled state currently lives in spreadsheets.

## Goals

- CRUD widgets via HTTP
- List widgets by owner
- Offer a typed CLI client

## User Stories

As an operator, I want to add a widget so downstream consumers see it
within a single second.

As a consumer, I want to list widgets I own so I can review my inventory
without direct database access.

## Requirements

- FR-1: POST /widgets creates a widget (returns 201 + widget body)
- FR-2: GET /widgets/{id} returns 200 or 404
- FR-3: GET /widgets?owner=X returns widgets for owner X
- FR-4: CLI `widgets add` wraps FR-1

## Non-Functional Requirements

- NFR-1: p95 latency < 200ms for FR-1 / FR-2
- NFR-2: structured logging with request-id correlation
- NFR-3: stdlib-only dependencies (zero runtime deps)

## Success Metrics

- 95% of FR-1 requests succeed within NFR-1
- 0 unhandled 5xx errors in 30-day rolling window

## Architecture

Small monolith: single FastAPI process, SQLite-backed repository, thin CLI
that shells out to the same module. No worker queue; no cache.

## Testing Strategy

Pytest with subprocess integration tests for the CLI; direct httpx calls
for FR-1 / FR-2; golden fixtures for the list-by-owner response shape.

## Implementation Plan

- **`t1.1`** Scaffold FastAPI app [done]
  Depends on: none
- **`t1.2`** Implement FR-1 (POST /widgets)
  Depends on: t1.1
- **`t1.3`** Implement FR-2 (GET /widgets/{id})
  Depends on: t1.1
- **`t2.1`** Implement FR-3 (GET /widgets?owner=X)
  Depends on: t1.2, t1.3
- **`t3.1`** Implement FR-4 (CLI widgets add)
  Depends on: t1.2
