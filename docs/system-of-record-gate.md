# System-Of-Record Architecture Gate

The system-of-record gate prevents stateful work from landing on the wrong
persistence boundary. Before implementation, any story that introduces or
modifies durable or security-sensitive state must declare:

```json
{
  "architecture": {
    "systemOfRecord": {
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
```

Run the story-time preflight before stateful implementation:

```bash
task architecture:sor-preflight -- --story-path <path>
```

Run the diff-time check before PR handoff when persistence-sensitive files
changed:

```bash
task verify:architecture-sor -- --base-ref origin/main --story-path <path>
```

Use the repository's actual base ref when it is not `origin/main`.

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
