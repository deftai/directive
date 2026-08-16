# Approved-scope provenance (`verify:scope-provenance`)

Refs: #3145 · #3205 · Related: #1310, #2944 human-origin grants, #516 file scope · generalizes under [gate-integrity.md](./gate-integrity.md) (#3156)

## Problem

An implementation PR could edit its own active xBRIEF to add new paths, after which one-way forward-coverage still passed. The modified xBRIEF became its own authorization source.

## Contract

At activation or operator approval, record an immutable **approved-scope digest** under:

```text
.deft/approved-scope/<plan-id>.json
```

Shape:

```json
{
  "schemaVersion": 1,
  "xbriefRelPath": "xbrief/active/….xbrief.json",
  "planId": "…",
  "approvedAt": "2026-08-06T00:00:00Z",
  "fileScope": ["packages/core/src/foo.ts"],
  "fileScopeDigest": "<sha256 of sorted paths>",
  "humanApproval": {
    "kind": "operator",
    "actor": "scott",
    "mintedAt": "2026-08-06T00:00:00Z",
    "mintedVia": "scope:record-approved-scope"
  }
}
```

`task verify:scope-provenance` compares the live active xBRIEF `plan.metadata.swarm.file_scope` to the digest when that xBRIEF is modified in the current change set.

| Outcome | Behavior |
| --- | --- |
| No expansion; base-visible human approval matches current scope | Pass |
| Expansion + independently renewed human stamp / re-recorded matching digest **already on the merge base** | Pass |
| Expansion without renewal | **Fail** — self-authorizing scope |
| Approval created or rewritten in the same change set as the active xBRIEF | **Fail** — same-PR self-auth |
| Agent-stamped or missing human approval with non-empty `file_scope` | **Fail** (or migration warn only for empty scope without digest) |
| Modified active xBRIEF, empty scope, no digest yet | **Warn** by default; `--enforce` fails closed |

Agent-shaped stamps (`kind: agent`, `actor: agent:…`) never count as renewal or first-adoption authority.

### Base-ref authority (#3205)

Authority comes from the approval record in the **merge base**, not from whether the active xBRIEF path existed there:

1. Read `<baseRef>:.deft/approved-scope/<plan-id>.json`
2. Validate schema, human stamp, plan id, path binding, and digest
3. Require the current record to be semantically unchanged from that base record
4. Permit `pending/` → `active/` (or later expansion) when the current xBRIEF scope matches that base-approved scope
5. Fail closed when the base record is absent, malformed, agent-authored, path/digest mismatched, or created/changed alongside the active xBRIEF

## Operator command: `scope:record-approved-scope`

Deposit a human-origin digest (first adoption or renewal). Mint on a real TTY, then commit the approval artifacts to the merge base (or a prior PR) before implement.

```bash
task scope:record-approved-scope -- xbrief/pending/story.xbrief.json --actor scott --confirm
# or after expansion review:
task scope:record-approved-scope -- xbrief/active/story.xbrief.json --actor scott --kind renewed-approval --confirm
```

`--actor` is **display only**. It never authorizes mint. `--actor Flynn` from an agent or CI shell cannot mint.

Mint uses the shared #3110 human-presence gate (same module as `authz`):

- Interactive TTY (stdin + stdout) and a controlling terminal (`/dev/tty` or `CONIN$`)
- Explicit `--confirm`
- Typed phrase `mint` on the controlling TTY
- Agent/CI env markers (`AUTHZ_AGENT_SHELL_ENV_MARKERS`) refuse fail-closed
- An active UAT lease refuses mint with no TTY / `--confirm` / phrase escape

No authz grant is written. `verify:scope-provenance` does not read `.deft/authz/grants`.

Flags:

| Flag | Required | Notes |
| --- | --- | --- |
| `<xbrief-path>` | yes | pending or active xBRIEF JSON |
| `--actor` | yes | display-only human identity (never authorization) |
| `--confirm` | yes | required; flag alone never authorizes mint |
| `--kind` | no | default `operator`; also `human`, `renewed-approval`, … |
| `--project-root` | no | defaults via Taskfile to consumer CWD |
| `--xbrief-rel-path` | no | override path binding; default maps `pending/` → `active/` |

Commit the written `.deft/approved-scope/<plan-id>.json` on the **merge base** (or a prior PR) before the implementation PR activates or expands the scoped xBRIEF.

### Wave 1 records are legacy under Wave 2 (#3384 / #3385)

Wave 1 mints write the current approved-scope record shape with a human-looking stamp. They do **not** write `xbriefBodyDigest` and they carry **no** `intentDigest`. Under Wave 2 (#3385) those records are **legacy**: later intent edits will warn, then fail; gated remint is the remediation. That is intended, not a bug.

## First-adoption flow (single consumer upgrade)

When the first non-empty `file_scope` story and the 0.97+/0.98 gate land together:

1. Author the pending xBRIEF with the intended `file_scope`
2. Run `task scope:record-approved-scope -- <pending-xbrief> --actor <you> --confirm`
3. **Commit and merge** the approval record (and preferably the pending xBRIEF) first — multi-PR bootstrap
4. In a follow-up PR, activate (`pending/` → `active/`) without rewriting the approval
5. `task verify:scope-provenance -- --base-ref origin/master --enforce` exits 0

Emptying `file_scope` to soft-warn past the gate is **not** the supported migration path; it removes the write fence the gate protects.

## Multi-PR approved expansion

1. PR A: operator reviews expanded scope, runs `scope:record-approved-scope`, merges approval only (or approval + docs)
2. PR B: updates the active xBRIEF `file_scope` to exactly that approved set; does **not** rewrite the approval file
3. Gate passes under `--enforce` because base approval already authorizes the new scope

## Migration path

1. Ship gate in warn mode (missing digests do not fail for empty scope)
2. Start recording digests via `scope:record-approved-scope` on activation / promote
3. Enable `--enforce` or project policy when ready

## Remediation

```bash
task scope:record-approved-scope -- <xbrief-path> --actor <you> --confirm
git add .deft/approved-scope/<plan-id>.json
# merge that commit before (or without) co-changing the active xBRIEF expansion
```

Editing the xBRIEF alone does not authorize new implementation paths.
