# System-Of-Record Architecture Gate

The system-of-record gate prevents stateful work from landing on the wrong
persistence boundary. Before implementation, any story that introduces or
modifies durable or security-sensitive state must declare the design record at
the **canonical nested home** (`plan.architecture.systemOfRecord`, #1492):

```json
{
  "plan": {
    "architecture": {
      "systemOfRecord": {
        "disposition": "covered",
        "stateSurfaces": [
          {
            "name": "Workspace",
            "classification": "durable_product_state",
            "owner": "application database",
            "approvedStorage": "postgres",
            "forbiddenStorage": ["json_file", "browser_storage", "in_memory"],
            "migrationRequired": true,
            "auditRequired": true,
            "concurrencyRequired": true,
            "permissionBoundary": "workspace membership",
            "concurrencySemantics": "optimistic concurrency with version checks",
            "transactionBoundary": "single database transaction per mutation",
            "recoverySemantics": "recover from database backups and migrations",
            "conflictDetection": "version column conflict",
            "deleteSemantics": "soft delete with audit event",
            "migrationPath": "add workspaces table and indexes"
          }
        ],
        "referenceApplications": []
      }
    }
  }
}
```

Typed on Directive `xbrief-core-0.8` (`$defs/Architecture.systemOfRecord`) and
mirrored under vBRIEF `$defs/Architecture` for the #1595 `codeStructure`
precedent. Upstream xBRIEF/vBRIEF remains non-blocking.

Top-level `architecture.systemOfRecord` is deprecated. Nested wins; both-present
is a selection error (exit 2). Top-level-only is never authoritative success.

## Applicability (disposition)

Story-mode uses an author-asserted statefulness signal — not path×file_scope
intersection and not silent diff-scanner derivation:

- **Undeclared** (no `plan.architecture.systemOfRecord`): stays undeclared; story
  mode passes with an undeclared advisory. Not implicit `not_applicable`.
- **`plan.architecture.stateful: true`** without a record: required — missing
  record fails as a violation.
- Disposition vocabulary reuses project-invariant coverage (#3425):
  `covered` | `deferred` | `behavioral_delta` | `not_applicable` (snake_case).
- **`not_applicable`**: requires a nonblank `reason` (or `dispositionReason` /
  `provenance.reason`) and must not carry declared `stateSurfaces`.
- **`covered` / `behavioral_delta` / surfaces without disposition**: existing
  surface checks.
- **`deferred`**: explicit draft/incomplete (exit 3). Empty or partial
  `stateSurfaces` are unfinished design — never fake `approvedStorage`, and
  never use `not_applicable` as a draft stand-in.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Pass (including undeclared or valid `not_applicable`) |
| 1 | Architecture violation |
| 2 | Gate misconfigured / selection error (both homes, legacy top-level, bad args, pin miss) |
| 3 | Draft / incomplete (`disposition: deferred`) |

## Commands (advisory / opt-in pre-1.0)

Run the story-time preflight before stateful implementation. `--story-path` is
optional: when omitted, story mode defaults through scanned actives + pin
(`resolveSoftMissingAcTargets` / `multiple-eligible` / `pin-miss`) — not a
parallel SOR-local active-scope selector.

```bash
task architecture:sor-preflight -- --story-path <path>
task architecture:sor-preflight
```

Run the diff-time check before PR handoff when persistence-sensitive files
changed. Diff-mode `changedStoryRecords` selection stays **advisory** for 1.0
(explicit carve-out; silent mis-bind false-pass is a separate issue).

```bash
task verify:architecture-sor -- --base-ref origin/main --story-path <path>
```

Use the repository's actual base ref when it is not `origin/main`.

Pre-1.0 keeps these gates advisory/opt-in. Fail-closed story-mode in
build/swarm, Tier-1 PreToolUse composition, and consumer `agents-entry` MUST
propagation are out of this Bound.

Implement-time authoring census (primary checkout): 11 nested records under
`xbrief/completed/`; zero active/proposed; zero live top-level-only homes.

## Classifications

- `durable_product_state`: authoritative application state. Must use approved durable storage and declare owner, permissions, migration, concurrency, transaction, recovery, conflict, and delete semantics.
- `auth_session_state`: identity or session state. Must use approved auth/session mechanisms, not local config or process memory.
- `authorization_state`: roles, memberships, grants, and permissions. Must be durable, permissioned, and auditable.
- `audit_event_state`: append-only or traceable event/history state.
- `external_integration_state`: state owned by or synchronized with an external provider. Declare ownership, sync/recovery semantics, and permission boundaries.
- `canonical_artifact`: source-controlled or user-authored artifact read as evidence, not mutable app persistence.
- `cache`: rebuildable, non-authoritative derived state. Must include invalidation rules.
- `projection`: derived read model from another source. Declare `sourceOfTruth`; do not mutate the projection directly.
- `import_export_artifact`: temporary transfer artifact, not live state.
- `dev_only_fixture`: test/local-only data excluded from production runtime. Must declare a production guard.
- `ephemeral_ui_state`: temporary view state only; browser or process memory is acceptable only when not authoritative.

## Local Storage Rule

Files and browser storage are allowed for canonical artifacts, guarded fixtures,
import/export files, invalidated caches, and ephemeral UI state. They are not
allowed for mutable product records, selected workspace/project/account truth,
identity/session truth, memberships, workflow/job authority, audit records, or
anything that must survive concurrent users, restarts, deployments, or recovery.

One-sentence rule: no implementation may introduce or modify stateful behavior
until it declares and passes the correct system of record for that state.
