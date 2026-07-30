# Typed escalation channel (#518 / #2948 Wave 5 slim)

Async agent-to-human escalation with a fixed type vocabulary, local file queue,
and CLI batch tools. Composes with Wave 1 human-origin grants
(`content/contracts/human-origin-authz.md`) when a resolution authorizes a gated
product action — resolution does **not** mint grants automatically; the operator
runs `deft authz:grant` for implement/push/merge/release.

Threat model: **operator attention** under multi-agent load (not malice). At 60
agents, one undifferentiated interrupt channel is a denial-of-attention attack.

## Types

| Type | Meaning | Default SLA | Bulk? | UI treatment (full product — residual) |
| --- | --- | --- | --- | --- |
| `cmd_approval` | Agent wants to run a command requiring human ack | 1h | yes (non-dangerous) | Batched queue; bulk-approve |
| `design_decision` | Ambiguity not resolvable from authoritative docs | 4h | no | Priority inbox; one-at-a-time |
| `approval` | Merge, release, or other gated action | 4h | no | Priority inbox |
| `resource` | Missing secret, credential, quota, env | 4h | no | Routed to ops owner |
| `external` | Waiting on third-party (GitHub, CI, service) | 72h | no | Dashboard indicator, no interrupt |
| `question` | Clarification (not blocking) | 24h | yes | Review-queue; no interrupt |

Unknown types are **rejected** at parse and `escalation:file` time.

## Event schema (versioned)

`schemaVersion: 1`. Stored as JSON under `.deft/escalations/<id>.json`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | e.g. `esc-<timestamp>-<hex>` |
| `agentId` | string | Filing agent id |
| `type` | enum | One of the six types above |
| `title` | string | Short subject |
| `body` | string | Detail / command / context |
| `contextRefs` | string[] | xBRIEF paths, issue refs, … |
| `createdAt` | ISO-8601 Z | |
| `slaHours` | number | Default from type table |
| `status` | `open` \| `resolved` | |
| `dangerous` | boolean | Batch-approve skips unless `--include-dangerous` |
| `resolution` | object \| null | `decision`, `resolvedAt`, `resolvedBy`, `note`, `answer` |

Snake_case aliases (`agent_id`, `context_refs`, `sla_hours`, `created_at`) are
accepted on read for the issue-#518 YAML shape.

## Store

```
.deft/escalations/<id>.json
```

List open: `status === "open"`. Corrupt files are skipped (not fail-closed for
the whole queue — one bad file must not hide the rest).

## CLI

```bash
deft escalation:file -- --type cmd_approval --title "run tests" [--body …] [--dangerous]
deft escalation:list [--open] [--type <type>] [--format json]
deft escalation:resolve -- <id> --decision approved|denied|answered|dismissed
deft escalation:batch-approve [--ids a,b] [--include-dangerous]
```

### Batch rules

- **Allowed bulk types:** `cmd_approval`, `question` only.
- **Individual only:** `design_decision`, `approval`, `resource`, `external`.
- **Dangerous:** `dangerous: true` items (write-scope shell, PR merge, etc.) stay
  individual unless the operator passes `--include-dangerous`.
- `question` bulk marks `answered`; `cmd_approval` bulk marks `approved`.

### Composition with grants

After `approved` on `cmd_approval` / `approval`, operators who need product
mutations mint Wave 1 grants:

```bash
deft authz:grant -- --operations edit,push --surfaces 'src/**' --cohort <id>
```

Agents MUST NOT treat an open or resolved escalation alone as implement authority.

## Agent guidance (swarm / preamble pointer)

When blocked on human input, file a typed escalation instead of a synchronous
interrupt storm:

1. Pick the most specific type from the table.
2. Set `dangerous: true` for write-scope shell / merge / release-class requests.
3. Include `contextRefs` to the active xBRIEF and related issues.
4. Continue other unblocked work; poll `escalation:list --open` or wait for
   operator drain.

## Residual (full #518 product — not this slim cut)

The following remain **out of scope** for Wave 5 slim and should stay tracked
on #518 (or a follow-up) until delivered:

- [ ] **Priority-inbox web UI** for `design_decision` / `approval` / `resource`
- [ ] **Dashboard indicator** for `external` that does not interrupt
- [ ] **Warp-native / GitHub Projects** queue surfaces
- [ ] **Metrics** per type: count, SLA met %, median time-to-resolution (RFC #515 §6 learning loop)
- [ ] Multi-operator drain UX beyond concurrent CLI access to the same store
- [ ] Auto-mint of Wave 1 grants from resolution (optional future; not default)

First cut is **CLI + file queue** so grants and finish-loop (#871) have a
structured escalation channel without a full web UI.

## Related

- Issue: #518 (parent RFC #515 §6 Human-in-the-loop)
- Program: #2948 Wave 5
- Grants: `content/contracts/human-origin-authz.md` (#2944)
- Closed verbs: `content/contracts/closed-verb-authz.md` (#1095)
