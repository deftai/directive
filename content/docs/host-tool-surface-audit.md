# Host tool-surface audit (#3987)

The PreToolUse write gate only runs on tool names the host's deposited matcher
selects. A name nobody listed is not a permissive policy — it is a gate that
never executes. #3987 was exactly that: Grok Build's shell tool
`run_terminal_command` was in no matcher, so a write the gate refused could be
reissued through the shell and land unobserved.

This file is the recorded answer to acceptance item 2: **for every tool name a
supported host emits, either the deposited matcher covers it, or there is a
written reason it stays out of scope.** The machine-readable form is
`HOST_TOOL_SURFACE_AUDIT` in `packages/core/src/hooks/tools.ts`, and
`deft verify:hooks-installed --scope=agent` fails closed on any silence in it.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `⊗`=MUST NOT.

---

## Two layers that can disagree

| Layer | Form | Where |
|-------|------|-------|
| Deposited matcher | literal `a\|b\|c` alternation the host matches against | `.claude/settings.json`, `.grok/hooks/deft.json`, `.cursor/hooks.json`, `.codex/hooks.json` |
| Runtime classifier | lowercases and strips non-alphanumerics, then set-membership | `isDirectWriteTool` / `isShellTool` / `isSpawnTool` |

Both read the same constants, so they normally agree — but a name can be
present in one and useless in the other. A matcher entry the classifier does not
recognize invokes the hook and then falls through to `not-direct-write`; a
classifier entry the deposit omits is never reached at all. The coverage check
asserts **both** for every catalogued name, so a fix has to say which layer it
changed.

---

## Grok Build — fully observed

Source: this host's published tool list, plus the 5,354-call session census
recorded on [#3987](https://github.com/deftai/directive/issues/3987).

| Tool | Disposition |
|------|-------------|
| `write` | covered — direct write |
| `search_replace` | covered — direct write |
| `run_terminal_command` | covered — shell (#3990) |
| `monitor` | covered — shell; it runs an arbitrary background shell command, so omitting it reproduces the #3987 gap one tool over |
| `spawn_subagent` | covered — spawn |
| `read_file`, `grep`, `list_dir`, `search_tool`, `web_search`, `web_fetch` | out of scope — read |
| `todo_write` | out of scope — session-local non-product scratch |
| `get_command_or_subagent_output`, `wait_commands_or_subagents` | out of scope — poll over already-dispatched work |
| `kill_command_or_subagent` | out of scope — process control |
| `scheduler_delete`, `scheduler_list` | out of scope — scheduler control and read; mutate no product path |
| `enter_plan_mode`, `exit_plan_mode` | out of scope — session posture |
| `image_gen`, `image_edit`, `image_to_video`, `reference_to_video` | out of scope — generated media lands in session scratch, never a tracked product path |
| `scheduler_create` | **known gap, not covered** — see below |
| `use_tool` | **known gap, not covered** — see below |

### `scheduler_create` — spawn-class, needs a policy decision

It dispatches a background subagent on an interval, which is spawn-class by the
same reading that puts `spawn_subagent` in the matcher. Covering it routes a
scheduling primitive through the full spawn stack (session ritual plus an active
xBRIEF), which denies a shape that works today — a new deny class, not a
coverage repair. That is a deliberate policy call and belongs in its own change,
not in a matcher edit.

### `use_tool` — mcp-class, needs a classifier change

`use_tool` is a proxy: the MCP tool actually invoked is nested in
`tool_input.tool_name`, and the dispatcher classifies on the outer name only. A
matcher entry alone would buy a hook invocation and no enforcement, because
`isMcpTool("use_tool")` is false and `classifyMcpTool` returns null. Reading the
inner name is a classifier change with its own untrusted-input surface.

---

## Claude, Codex, Cursor — partly or wholly unobserved

The deposit asserting a spelling is **not** evidence that the host emits it. All
four deposits carry the identical shell matcher, which is a matcher-string fact,
not a coverage fact ([#3987 comment 5471374558](https://github.com/deftai/directive/issues/3987#issuecomment-5471374558) F8).

| Host | Established | Unobserved |
|------|-------------|------------|
| Claude Code | shell `Bash` | direct-write and spawn spellings |
| Codex | shell `shell`; `apply_patch` write form (#3614) | everything else |
| Cursor | nothing | the whole surface |

Cursor is the one that matters: nothing in this tree observes which tool names
it emits on `preToolUse`. The fixture corpus asserts the framework's own
assumption, and `agent-hooks.test.ts` asserts the deposit contains a string.
Neither observes the host. Cursor could be a second zero-coverage host by the
exact mechanism that produced #3987, and the evidence available here would not
distinguish that from working coverage.

! Closing these requires an **observed** PreToolUse payload per host, not a
re-reading of the deposit.

⊗ Fill a host's catalog from the deposit, the matcher constants, or the fixture
corpus. That makes the check assert its own input and hides the gap it exists
to find.

---

## The check

`deft verify:hooks-installed --scope=agent` (also run by `deft doctor`) fails
closed on four silences:

| Finding | Meaning |
|---------|---------|
| `missing-audit` | a supported host has no entry here at all — the "new host drops out of coverage" case |
| `uncovered-tool` | a catalogued mutation name is absent from every **deposited** matcher — the "renamed tool" case, read from the file rather than regenerated |
| `unclassified-tool` | a catalogued name the runtime classifier does not place in the same group |
| `unexplained-entry` | an out-of-scope entry with no reason, a host claiming full observation while naming no mutation tool, or a non-mutation entry the classifier actually gates |

A hand-edited deposit reads as **stale** first, and `deft update` is the remedy
for that; the coverage message is for gaps a current deposit still leaves.

Implementation: `packages/core/src/init-deposit/host-tool-coverage.ts`.
Catalog: `packages/core/src/hooks/tools.ts`.

---

## Why coverage alone did not close #3987

Matcher coverage is necessary and not sufficient — all three seats of the #3987
panel agreed. Coverage closes the reissue bypass. It does not keep the occupancy
lease alive, because the lease renews on a **gated write**, and eligibility
keeps almost all real shell traffic off that path: five recognized write verbs,
no dest carrying `$` / `*` / `?`, nothing out of root or in OS temp, and any
compound command refused before the gate. `cd <root>; <command>` is compound,
and the mandated Windows body-file flow (#2646 / #2744) fails all three
conditions at once.

The renewal half is `restampOwnerLivenessOnHookEvent`
(`packages/core/src/hooks/owner-liveness.ts`): the hook already resolves the
owner from the host payload, so a matched tool call renews the lease even when
it writes nothing. It is bounded to a host-authoritative owner, keeps
`markWrite` false, keys on the lease's own worktree, and never touches
`claimed_at`, so `OCCUPANCY_MAX_LEASE_MS` still ends the lease at 12 hours.

---

## Cross-links

| Topic | Where |
|-------|-------|
| Gate integrity (do not clear red by editing the gate) | [`gate-integrity.md`](./gate-integrity.md) |
| Host honesty limits | [`host-surface-assumptions.md`](./host-surface-assumptions.md) |
| Agent hook readiness | [`agent-hook-readiness.md`](../contracts/agent-hook-readiness.md) |
| Occupancy lease and its bounds | `packages/core/src/session/occupancy.ts` |
