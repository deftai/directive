# Deft Events

Unified structural artifact listing every framework event in a single data
file, partitioned by the required `category` enum.
Wired under epic [#635](https://github.com/deftai/directive/issues/635) per
the canonical [#642 workflow comment](https://github.com/deftai/directive/issues/642#issuecomment-4330742436)
and unified per the Repair Authority [AXIOM] proposal
([#709](https://github.com/deftai/directive/issues/709)) and the
data-file-convention check follow-up
([#710](https://github.com/deftai/directive/issues/710)). The prior
`events/behavioral.yaml` registry has been folded into `registry.json`.

## Files

- `registry.json` — single source of truth for every event name, category,
  payload contract, detector / emission pointer, and consumer pointers.
  Lists 5 `detection-bound` events and 4 `behavioral` events (9 total).
- `registry.schema.json` — schema validating the registry's shape, including
  the required `category` enum (`detection-bound` | `behavioral`).
- `event-record.schema.json` — schema for individual emitted event records.

## Categories

Every entry MUST carry a `category` enum value. Two categories exist today;
future categories are additive enum extensions per the
data-file-convention check ([#710](https://github.com/deftai/directive/issues/710)):

- **`detection-bound`** — detectable from filesystem state alone (e.g. dirty
  tree, vBRIEF schema invalidity, version drift). Emitted via
  `scripts/_event_detect.py`. Detector lives at the call site documented in
  the entry's `trigger` field.
- **`behavioral`** — requires runtime instrumentation (paired
  `session:interrupted` / `session:resumed`, `plan:approved`,
  `legacy:detected`). Emitted via `scripts/_events.py`, which manages 1:1
  session-pair invariants and a JSONL append-only log at
  `<project_root>/.deft/events.jsonl`.

## Emission

Both helpers consume the same `registry.json` data file and produce records
conforming to `event-record.schema.json`:

```json
{
  "event": "<registered name>",
  "detected_at": "<UTC ISO-8601 seconds>",
  "payload": { ...per-event contract... }
}
```

`scripts/_event_detect.py::emit(name, payload)` validates against the full
registry (any registered name is accepted) and is silent by default; when the
`DEFT_EVENT_LOG` environment variable points to a writable path, each
emission is appended as a single JSON line.

`scripts/_events.py::emit(name, payload)` validates against the
`category="behavioral"` subset of the registry, generates a sortable event id
for pairing semantics, enforces required-payload contracts, and persists to
`<project_root>/.deft/events.jsonl` (or a path injected via `log_path` /
`DEFT_EVENT_LOG`). Use this helper when emitting behavioral events from
skills (`python -m scripts._events emit ...`).

## Adding an event

1. Append the entry to `registry.json` with the appropriate `category`,
   payload contract, trigger pointer, and consumer pointers (validate via
   `tests/cli/test_events.py` and `tests/cli/test_behavioral_events.py`).
2. Add the detection / emission call site in `scripts/` or the relevant
   surface (use `scripts/_event_detect.py` for detection-bound,
   `scripts/_events.py` for behavioral).
3. Reference the event by name from at least one consumer (skill, task,
   script) so the surface stays usable -- the schema requires `consumers`
   to be a non-empty array.

The registry's `consumers` array is the single audit trail for who reacts
to each event — keep it current when wiring or removing call sites.

## Adding a new category

New categories are an additive change to the schema's `category` enum:
update `registry.schema.json` `$defs.Event.properties.category.enum`,
document the new category in the registry `description` and this README,
and add corresponding tests asserting the new category is recognized.
The existing 5 detection-bound + 4 behavioral entries remain stable
through such extensions per the unification convention agreed in #642 /
#709 / #710.
