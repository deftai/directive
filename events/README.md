# Deft Events

Structural artifact listing detection-bound and behavioral framework events.
Wired under epic [#635](https://github.com/deftai/directive/issues/635) per the
canonical [#642 workflow comment](https://github.com/deftai/directive/issues/642#issuecomment-4330742436)
(events split into 5 detection-bound + 3 behavioral).

## Files

- `registry.json` — single source of truth for event names, payload
  contracts, detector pointers, and consumer pointers. Currently lists 5
  detection-bound events; the behavioral events vBRIEF appends 3 more.
- `registry.schema.json` — schema validating the registry's shape.
- `event-record.schema.json` — schema for individual emitted event records.

## Emission

`scripts/_event_detect.py::emit(name, payload)` builds a uniform record
(filename is intentionally distinct from the sibling vBRIEF's
`scripts/_events.py` for behavioral events; merge-time consolidation may unify
them under one canonical name):

```json
{
  "event": "<registered name>",
  "detected_at": "<UTC ISO-8601 seconds>",
  "payload": { ...per-event contract... }
}
```

Default behavior is silent (records are returned to the caller). When the
`DEFT_EVENT_LOG` environment variable points to a writable path, each emission
is appended as a single JSON line — the simplest pattern for skills, tasks, or
CI runners that want to consume events out-of-band without a daemon.

## Detection-bound vs Behavioral

- **Detection-bound** — detectable from filesystem state alone (e.g. dirty
  tree, vBRIEF schema invalidity, version drift). Wired here.
- **Behavioral** — requires runtime instrumentation (paired
  `session:interrupted` / `session:resumed`, `plan:approved`, `legacy:detected`).
  Tracked in the sibling vBRIEF and not yet wired.

## Adding an event

1. Append the entry to `registry.json` (validate via
   `tests/cli/test_events.py`).
2. Add the detection / emission call site in `scripts/` or the relevant
   surface.
3. Reference the event by name from at least one consumer (skill, task,
   script) so the surface stays usable.

The registry's `consumers` array is the single audit trail for who reacts
to each event — keep it current when wiring or removing call sites.
