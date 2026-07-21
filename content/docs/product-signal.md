# Product signal (optional partner check-in)

Phase 1 consented product-improvement signal under epic #2603 (#2693). Defaults **off**.

## Enable (project)

```bash
task product-signal:enable -- --confirm
task policy:show -- --field=productSignal
```

Capability-cost disclosure prints before `--confirm` applies `plan.policy.productSignal.enabled=true`.

## Consent (install / user)

Consent file: `%APPDATA%\\deft\\product-signal-consent.json` (Windows) or `~/.config/deft/product-signal-consent.json` (Unix).

```bash
task product-signal:consent -- --grant
task product-signal:consent -- --revoke
task product-signal:status
```

Outbound requires **both** enable and consent.

## Submit (ops / tests)

```bash
task product-signal:submit -- --surface pulse|portrait [--dry-run] [--json] [--nps 0-10]
```

## Sink bootstrap (maintainers)

Internal (org) inbox: `deftai/product-signal` (overridable via `plan.policy.productSignal.sinkRepo`). Not public.

```bash
task product-signal:bootstrap-sink [-- --dry-run]
```

Creates the repo if needed, sets visibility to **internal**, and bootstraps D20 labels (`surface:*`, `nps:*`, `signal:gap`). Standing threads keyed by `(installId, actorName)`.

## Skill

Agents: `deft-directive-product-signal` — triggers `product check-in`, `product pulse`, `partner feedback`, `product signal`.

## Related

- Public gap escalation: `deft-directive-feedback` / `task feedback:file` (hard confirm)
- Skill telemetry emit: #829 (optional `skillsSummary` hook only; not required for pulse)
- HTTP transport: #2697 (Phase 2)
