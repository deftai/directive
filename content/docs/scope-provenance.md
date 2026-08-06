# Approved-scope provenance (`verify:scope-provenance`)

Refs: #3145 · Related: #1310, #2944 human-origin grants, #516 file scope

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
    "mintedAt": "2026-08-06T00:00:00Z"
  }
}
```

`task verify:scope-provenance` compares the live active xBRIEF `plan.metadata.swarm.file_scope` to the digest when that xBRIEF is modified in the current change set.

| Outcome | Behavior |
| --- | --- |
| No expansion | Pass |
| Expansion + renewed human stamp / re-recorded matching digest | Pass |
| Expansion without renewal | **Fail** — self-authorizing scope |
| Modified active xBRIEF, no digest yet | **Warn** by default; `--enforce` fails closed |

Agent-shaped stamps (`kind: agent`, `actor: agent:…`) never count as renewal.

## Migration path

1. Ship gate in warn mode (missing digests do not fail)
2. Start recording digests on activation / promote
3. Enable `--enforce` or project policy when ready

## Remediation

Re-record the approved-scope file after human review of the expanded `file_scope`. Editing the xBRIEF alone does not authorize new implementation paths.
