# Consumer check contract (`verify:consumer-check-contract`)

Refs: #3145 · Related: #3070 consumer gate integrity, #1519 check:consumer

## Problem

A consumer could omit Directive enforcement gates from its `check` task and CI while local and CI success still looked green. Composition was not machine-checked.

## Contract

`task verify:consumer-check-contract` requires these gates to be defined under `tasks/verify.yml` and composed into consumer/framework check aggregates:

- `verify:test-boundary`
- `verify:scope-provenance`
- `verify:consumer-check-contract`

It fails with a concrete repair path when definitions or explicit check deps omit them. CI workflows that neither invoke the gates nor a composing entrypoint (`task check` / `deft check`) produce **warnings** by default (migration).

## Repair path

1. Restore deposit Taskfiles: `deft update` (includes `tasks/verify.yml`)
2. Ensure `check:consumer` / `check:framework-source` deps list the three gates (framework source already ships this wiring)
3. Prefer CI that runs `task check` or `deft check` rather than a partial custom graph

## Relation to #3070

`consumer-gate-integrity` proves Taskfile includes resolve. This gate proves the **required enforcement set** is present and composed — not merely that a random verify task exists.
