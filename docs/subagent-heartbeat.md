# Sub-agent heartbeat contract (#1365)

Long-running `spawn_subagent` review-cycle agents on the Grok Build hybrid
swarm path can go completely dark from the monitor's perspective -- the
parent sees no commits, no PR comments, no completion notifications, and no
way to distinguish a stalled agent from a healthy mid-poll one. This doc
defines the lightweight heartbeat contract every long-running sub-agent
MUST emit so the monitor (and the `scripts/subagent_monitor.py` helper)
can observe liveness without resorting to manual worktree polling.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Recurrence record: the #1166 swarm session dispatched three parallel
review-cycle sub-agents (#1360, #1362, #1363). One reported back; the
other two produced **zero** observable signals (no commits, no PR
comments, no messages). The monitor could not tell whether they were
working, stalled, or dead. This contract closes that visibility gap.

## Cursor Task pollers (#1877)

! Every long-running Cursor `Task` sub-agent (review-monitor poller,
implementation worker whose tool loop is expected to exceed ~3 minutes,
or any backgrounded `run_in_background: true` worker) MUST honour this
heartbeat contract — same obligation as the `spawn_subagent` path above
(#1166). The Cursor completion-notification channel does NOT replace
periodic heartbeats; it only signals terminal completion.

~ Cursor pollers write to the same `.deft-scratch/subagent-status/<agent-id>.json`
path and schema documented below. The monitor helper
(`scripts/subagent_monitor.py`) reads both Grok Build and Cursor poller
records from that directory without a separate Cursor-specific surface.

Cross-references: `skills/deft-directive-review-cycle/SKILL.md` Review
Monitoring (Approach 1 / heartbeat contract for Cursor pollers),
`skills/deft-directive-swarm/SKILL.md` Phase 3 Step 2e (Cursor launch).
Refs #1877, #1166.

## Cursor false-alive and REDISPATCH_OK (#2824)

Cursor `Task` `drive-to: merge*` leaves can go silent after PR-open while the
host still reports "still running" — blocking resume/replace. The recurrence
record is cohort-2804-2814 (PR #2818 / #2820 silent leaves with zero heartbeat
records and ~1-line transcripts).

! When a monitor observes host-reported **running** PLUS any of: **missing**
heartbeat record for a registered in-flight worker, **STALE** heartbeat (age >
threshold, `terminal_state` null), or **no recent git/PR activity** on the
worker worktree, it MUST treat the worker as dead for re-dispatch purposes and
surface **`REDISPATCH_OK`**. Do NOT wait for a terminal platform lifecycle
event.

Deterministic gate:

```pwsh path=null start=null
task verify:subagent-alive -- \
  --require-agent <agent-id> \
  --scratch-dir <worktree>/.deft-scratch/subagent-status
```

Exit `1` prints `REDISPATCH_OK` and authorizes takeover. Exit `0` means fresh
heartbeats for all required agents. Exit `2` is config error (missing scratch
dir with no records).

Raw heartbeat sweep (no `--require-agent` fail-closed semantics):

```pwsh path=null start=null
task agent:monitor -- \
  --scratch-dir <worktree>/.deft-scratch/subagent-status
```

Cross-references: `task verify:subagent-alive`, `skills/deft-directive-swarm/SKILL.md`
Phase 4 / Phase 5, `templates/agent-prompt-preamble.md` § 10.5. Refs #2824,
#1365, #2655 (review-monitor is orthogonal — ownership, not implementer liveness).

## OpenClaw sessions_spawn (#2879)

Long-running OpenClaw `sessions_spawn` review-monitors and leaves can go dark
from the parent session's perspective the same way Grok Build `spawn_subagent`
and Cursor `Task` pollers do: the host may still show a live session while the
tool loop has stalled (no commits, no PR comments, no parent announce).

! Every long-running OpenClaw `sessions_spawn` sub-agent (review-monitor
poller, implementation worker whose tool loop is expected to exceed ~3 minutes,
or a Control UI–visible subagent) MUST honour this heartbeat contract — same
obligation as the `spawn_subagent` and Cursor `Task` paths (#1166 / #1365 /
#2879).

~ OpenClaw pollers write to the same
`.deft-scratch/subagent-status/<agent-id>.json` path and schema documented
below. The monitor helper (`scripts/subagent_monitor.py` / `task agent:monitor`
/ `task verify:subagent-alive`) reads OpenClaw records from that directory
without a separate OpenClaw-specific surface.

! OpenClaw host session liveness, Control UI presence, or gateway channel
reachability does NOT replace periodic heartbeats. Those signals only prove
the session exists, not that the review-monitor tool loop is progressing.
Prefer the file-heartbeat + `task verify:subagent-alive` / `task agent:monitor`
path as the **canonical** liveness contract for OpenClaw review-monitors.

! **Parent `mkdir` + startup grace before REDISPATCH_OK (#2879):** `task verify:subagent-alive`
exits `2` (config error, **no** `REDISPATCH_OK`) when the scratch directory is
missing and has zero records. A worker that dies before its first heartbeat
never creates `.deft-scratch/subagent-status/`, so a probe against a non-existent
dir blocks the takeover this contract promises. Parents MUST create the worker
worktree's status directory at dispatch time **and** honor a startup grace before
treating a missing required-agent record as dead. `task swarm:launch` (worktree
map) and `task swarm:pre-dispatch --action begin` on a filesystem target mkdir
this directory mechanically (#3730). Interactive spawn without those verbs still
MUST mkdir before the spawn primitive:

```pwsh path=null start=null
New-Item -ItemType Directory -Force -Path <worktree>/.deft-scratch/subagent-status | Out-Null
# or: mkdir -p <worktree>/.deft-scratch/subagent-status
# ... sessions_spawn the worker ...
# Startup grace: wait until the first expected heartbeat window elapses
# (default 3 minutes, matching the heartbeat cadence floor) OR until the
# first `phase: "starting"` record appears -- whichever comes first.
# Only THEN arm --require-agent probes for REDISPATCH_OK.
task verify:subagent-alive -- \
  --require-agent <agent-id> \
  --scratch-dir <worktree>/.deft-scratch/subagent-status
```

Once the directory exists **and** the startup grace has elapsed, a missing
required-agent record is exit `1` + `REDISPATCH_OK` (same as Cursor #2824).
Exit `2` stays reserved for true config errors (invalid args, wrong path).

! **Takeover after REDISPATCH_OK (#3730):** Exit `1` does not cancel the
delivery-attempt row. A killed worker stays `running`, and
`DENY_DUPLICATE_ACTIVE` still blocks a second spawn. Takeover is
`task swarm:pre-dispatch -- --action cancel` then begin. If gated ritual
verify fails, run `session:start --rearm --session-id=<same>` first.

! **Commit early (#3730):** Long-running workers MUST commit as soon as a
coherent unit exists. A host-kill leaves uncommitted work invisible to every
gate.

⊗ Put runtime last-seen on the C2 launch manifest (written `mode: "replace"`)
or in `occupancy.json` — those are the wrong primitives (#3730).

! **Startup grace is mandatory (#2879 Greptile P1):** An immediate first probe
against a parent-created empty status directory will correctly emit
`REDISPATCH_OK` for a missing required-agent -- and that would race a healthy
worker that has not yet written `phase: "starting"`. Parents MUST NOT treat
missing heartbeat as takeover-eligible until either (a) a first heartbeat has
been observed for that agent_id, then later goes missing/STALE, or (b) the
startup grace (default **3 minutes** from dispatch) has elapsed with still no
record. Workers still MUST write the first heartbeat immediately
(`phase: "starting"`) so the grace window stays short in the healthy path.

⊗ Redispatch on the first `verify:subagent-alive` exit `1` within the startup
grace window without checking wall-clock age since dispatch -- that is the
duplicate-worker race this rule closes.

? When an OpenClaw-native liveness signal is available (gateway session health,
subagent lifecycle event, Control UI status), monitors MAY treat it as a
*supplementary* signal alongside the file heartbeat, but MUST NOT treat host
"still running" alone as alive when the heartbeat is missing or STALE (same
`REDISPATCH_OK` posture as Cursor #2824).

! OpenClaw completion for pollers is **parent push / announce** (session
announce or visible subagent terminal message) — not
`get_command_or_subagent_output` and not Cursor Task completion-notification
semantics. The completion channel and the heartbeat path are complementary:
completion tells the parent the poller finished; the file heartbeat tells the
monitor the poller is still alive mid-flight.

Cross-references: `templates/swarm-greptile-poller-prompt.md` (Role posture +
OpenClaw completion channel), `templates/agent-prompt-preamble.md` § 10.5,
`skills/deft-directive-review-cycle/SKILL.md` Review Monitoring (Approach 1).
Refs #2879, #2874, #1365, #2824.

## Where heartbeats live

! Every long-running sub-agent (review-cycle poller, watchdog, or
implementation agent whose tool loop is expected to exceed ~3 minutes)
MUST write a heartbeat record to:

```
<project-root>/.deft-scratch/subagent-status/<agent-id>.json
```

- `<project-root>` is the deft project root (the directory containing
  `AGENTS.md` and `vbrief/`). Heartbeat records live INSIDE the project
  worktree the agent owns, NOT inside the parent's worktree, so each
  worktree carries its own status file and the monitor reads every
  worktree's `.deft-scratch/subagent-status/` directory.
- `<agent-id>` is a stable per-agent slug (e.g. the agent run ID, the
  branch slug, or a `<role>-<pr-number>` form). One record per agent;
  agents MUST NOT rotate filenames between writes.
- `.deft-scratch/` is gitignored (see `.gitignore` -- the per-session
  scratch root is never versioned). The directory MUST be created on
  first write if it does not exist.

The monitor walks `.deft-scratch/subagent-status/` for every agent
worktree and reports liveness based on the records found there.

## Heartbeat schema

! Every heartbeat record MUST be a single JSON object conforming to the
schema below. Records are overwritten in place on each heartbeat (NOT
appended). The on-disk write MUST be atomic -- write to a sibling temp
file and rename into place so the monitor never reads a half-written
record.

```json
{
  "agent_id": "agent3-1365",
  "parent_id": "019e6f1a-cbd9-75cb-a5d9-7c0d078c87d6",
  "last_heartbeat_at": "2026-05-28T18:47:50Z",
  "last_message": "polling Greptile on PR #1411 (poll 4/20)",
  "phase": "polling",
  "terminal_state": null
}
```

### Required fields

! Every record MUST carry:

- `agent_id` (string) -- the stable per-agent slug. MUST match the
  basename of the record file (`<agent-id>.json`) so the monitor can
  cross-check identity.
- `parent_id` (string) -- the agent run ID of the orchestrator the agent
  reports to. Allows the monitor to filter heartbeats from sibling
  cohorts that share the same `.deft-scratch/` directory.
- `last_heartbeat_at` (string, ISO-8601 UTC with the `Z` suffix) -- the
  timestamp of THIS write. The monitor compares this to wall-clock now
  to compute staleness. UTC is the contract; local-timezone timestamps
  fail the schema validator (`tests/cli/test_subagent_monitor.py`
  exercises the rejection path).
- `last_message` (string, max ~200 chars) -- one human-readable line
  describing what the agent is doing RIGHT NOW. Surfaces in the
  monitor's report; replaces the prior `last_message` on each write.
- `phase` (string, one of the canonical phases below) -- machine-readable
  lifecycle classifier so the monitor can group agents by phase.

### Optional fields

? Records MAY carry:

- `terminal_state` (string or null) -- when the agent has reached a
  terminal exit (CLEAN, ERRORED, TIMEOUT, STALL, FAILED, BLOCKED), this
  field carries the canonical exit name from the poller template's
  terminal-exit-condition set. When `null` (or absent), the agent is
  still mid-flight. The monitor uses this to distinguish "stale but
  finished" from "stale and stalled".
- `pr_number` (integer or null) -- the PR the agent is acting on, if
  applicable. Surfaces in the monitor's per-agent report.
- `extra` (object) -- agent-defined opaque payload. The schema validator
  ignores unknown keys here so individual agent types can carry their
  own diagnostics (e.g. `clean_gate_holdout`, `stall_streak`, last
  reviewed SHA) without coordinating a schema bump.

## Canonical phases

! `phase` MUST be one of:

- `starting` -- agent loaded AGENTS.md / vBRIEF, has not begun the main
  tool loop yet
- `implementing` -- writing code changes (implementation agents)
- `validating` -- running `task check` / pytest / equivalent
- `committing` -- staging + committing the change set
- `pushing` -- pushing to remote / opening PR
- `polling` -- waiting for an external signal (Greptile review, CI run,
  rebase cascade unlock)
- `fixing` -- addressing P0/P1 findings during a review cycle
- `terminal` -- the agent has reached a terminal exit and is about to
  return; `terminal_state` MUST be populated when `phase == "terminal"`

The phase taxonomy is intentionally small. Add a finer-grained
description to `last_message`, not to the phase field.

## Heartbeat cadence

! Sub-agents MUST write a heartbeat:

- Immediately on startup (first heartbeat carries
  `phase: "starting"`).
- At minimum every 2-3 minutes during normal operation. The poller
  template's recommended 90s poll cadence means every poll iteration is
  ALSO a heartbeat write, so a poller naturally satisfies this rule
  without an extra timer.
- Immediately before exiting (terminal heartbeat carries
  `phase: "terminal"` and a populated `terminal_state`). The terminal
  heartbeat is what tells the monitor "the agent finished cleanly" vs
  "the agent went silent at 19 min, possibly stalled".

~ The first heartbeat SHOULD be written BEFORE the agent's first
`send_message_to_agent` start announcement, so the monitor sees an
entry even when the parent has not yet processed the start message.

⊗ Skip the terminal heartbeat write because "the agent is about to exit
anyway". The monitor reads the on-disk state; an unwritten terminal
heartbeat is indistinguishable from a stall.

## What "stale" means

! The monitor's default staleness threshold is **30 minutes**. A record
whose `last_heartbeat_at` is older than 30 minutes (and whose
`terminal_state` is null) is classified as STALE and surfaces in the
monitor report with non-zero exit. The threshold is configurable via
`--threshold-minutes` on `scripts/subagent_monitor.py`.

The 30-minute default is calibrated for the review-cycle poller cadence
(90s polls, 30-minute caps). For implementation agents that do
long-running validation (large test suites), set a larger threshold via
`--threshold-minutes` or split the agent into a dispatch + poller pair
(see Dispatcher-lifecycle-hygiene at
`templates/agent-prompt-preamble.md` § 10).

## The monitor (`scripts/subagent_monitor.py`)

The helper walks one or more scratch directories and reports the
liveness of every record found there. Canonical invocations:

```pwsh path=null start=null
# Scan the default project-root scratch dir
uv --project . run python scripts/subagent_monitor.py

# Scan one or more explicit scratch dirs (one per agent worktree)
uv --project . run python scripts/subagent_monitor.py \
  --scratch-dir C:\Repos\deft-agent3-1365\.deft-scratch\subagent-status \
  --scratch-dir C:\Repos\deft-agent4-1368\.deft-scratch\subagent-status

# Tighter threshold for impatient monitors
uv --project . run python scripts/subagent_monitor.py --threshold-minutes 5

# Machine-readable output for parent monitor agents
uv --project . run python scripts/subagent_monitor.py --json
```

Exit codes (three-state, mirrors `task verify:cache-fresh` /
`task pr:merge-ready` / `task swarm:verify-review-clean`):

- `0` -- every record is fresher than the threshold AND every record
  parses cleanly. An empty scratch dir that EXISTS also exits 0 (no
  agents to monitor is not the same as stale state).
- `1` -- one or more records is stale OR malformed. The monitor MUST
  inspect the per-record diagnostics and surface a remediation
  (re-dispatch the stalled agent, take over manually, ...).
- `2` -- config error (the scratch directory does NOT exist AND no
  records were found, or `--threshold-minutes` is non-positive).
  Distinct from `1` so the operator can tell "missing scratch dir"
  from "agents are stale".

`gh` capture inside the monitor routes through
`scripts/_safe_subprocess.py::run_text` per the AGENTS.md
`## Safe subprocess capture (#1366)` rule -- the monitor never crashes
its reader thread on non-cp1252 bytes in a Greptile body it has to
inspect on behalf of an agent that has gone dark.

## Runtime and GitHub auth troubleshooting (#1557)

Workers that stall in `validating` or `pushing` with GitHub failures often
show healthy heartbeats while `gh` operations fail inside the worker sandbox.
The parent monitor shell may pass `gh auth status` even when the worker
execution envelope cannot authenticate or reach GitHub.

! When a worker reports GitHub auth or API failures (in `last_message`,
`terminal_state`, or `extra` diagnostics), classify the worker runtime and
validate auth from the **worker worktree**, not the parent shell:

```pwsh path=null start=null
cd <worker-worktree>
uv --project . run python scripts/platform_capabilities.py --json
uv --project . run python scripts/github_auth_modes.py --json
```

### Runtime modes

The capability probe (`scripts/platform_capabilities.py`, #1557a) classifies:

- `local-unsandboxed` -- interactive local shell without Cursor native sandbox
- `cursor-native-sandbox` -- Cursor native sandbox; UID 0 is remapped to the
  host user (`sandbox_uid_remap`), not real root
- `cloud-headless` -- cloud or headless runtime without local host context

! When `sandbox_uid_remap` is true, do NOT interpret sandbox UID 0 or
sandbox-root cwd ownership as host-root access. The probe reports
`identity_kind: sandbox-remapped-local-user` and ownership as a sandbox view
of the host filesystem.

### Auth modes and failure shapes

The auth validator (`scripts/github_auth_modes.py`, #1557b) checks from the
same envelope that will run `gh`:

- `host-gh` -- `gh auth status` plus minimal API reachability from the worker
- `injected-token` -- requires `GH_TOKEN`, `GITHUB_TOKEN`, or
  `GH_ENTERPRISE_TOKEN`; fails closed with `missing_injected_token` when
  absent (typical for `cloud-headless` workers)

### Remediation when host auth works but worker auth fails

! When parent host `gh` auth succeeds but worker validation fails in
`cursor-native-sandbox`, surface these operator choices (never paste token
values into prompts or heartbeat records):

- **Full-access execution** -- run GitHub steps with full filesystem/network
  access so the worker shares the host `gh` credential store
- **Trusted `gh` command allowlisting** -- allowlist the trusted `gh` command
  path for the worker sandbox
- **Injected-token handoff** -- bind credentials at the invocation layer
  without exposing token values in dispatch envelopes or transcripts

For `cloud-headless` workers missing injected credentials, re-dispatch with
injected-token handoff or switch to a local interactive runtime. Do not assume
host `gh` state is visible across the cloud boundary.

Cross-references: `skills/deft-directive-swarm/SKILL.md` Phase 3 Step 1a,
`scripts/platform_capabilities.py`, `scripts/github_auth_modes.py`. Refs #1557.

## Cross-references

- `scripts/subagent_monitor.py` -- the canonical monitor helper
- `tests/cli/test_subagent_monitor.py` -- empty / fresh / stale /
  malformed coverage
- `templates/swarm-greptile-poller-prompt.md` -- the poller template that
  embeds the heartbeat write into the bounded poll loop (OpenClaw
  `sessions_spawn` + parent push/announce completion channel, #2879)
- `templates/agent-prompt-preamble.md` -- the canonical orchestrator
  preamble carrying the Heartbeat contract section (§10.5 OpenClaw
  mapping, #2879)
- `skills/deft-directive-swarm/SKILL.md` Phase 4 (Monitor) and Phase 6
  Sub-Agent Role Separation -- the swarm skill surfaces that cite the
  heartbeat contract as the canonical alive-check on the Grok Build
  hybrid path (OpenClaw descriptor matrix is #2875 -- not this doc)
- `AGENTS.md` `## Safe subprocess capture (#1366)` -- the dependency
  helper the monitor uses for any gh capture it does on behalf of a
  dark sub-agent
- Recurrence: the #1166 swarm session where `#1362` and `#1363` went
  silent with zero observable signals
- OpenClaw: #2879 (templates + heartbeat mapping), epic #2874
