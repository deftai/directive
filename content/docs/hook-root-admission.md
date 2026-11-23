# Hook root admission — which tree a gated write is judged against (#3794 / #4013)

Every PreToolUse mutation carries **two** roots, and they are not interchangeable:

- **payload root** — the project root the host hook payload names.
- **effective root** — the working tree the write target actually lands in, chosen by
  `admitEffectiveHookRoot` from the target path.

Deny messages name both: `payloadRoot=<path> effectiveRoot=<path>`. A session-ritual deny also
names the judged checkout and prints one recovery command for it (#6376).

This page publishes what root admission decides, which gate reads which root, and why the
no-toplevel case behaves the way it does. It describes shipped behaviour. One narrowing has
shipped: the [outside-every-checkout class](#the-outside-every-checkout-class-6376) (#6376).

## The outcomes of root admission

| Target's nearest existing ancestor resolves to | Outcome | Effective root |
| --- | --- | --- |
| The payload root itself | admit | payload root |
| Another working tree sharing `--git-common-dir` with the payload root | admit | that worktree |
| Another Git toplevel, while the payload root is not a Git repository | admit — no containment question exists | payload root |
| Another Git toplevel whose `--git-common-dir` cannot be read | refuse `unproven-identity` | — (deny) |
| A proven different repository | refuse `foreign-repository` | — (deny) |
| **No Git toplevel at all** | **admit** | **payload root** |

On Windows, roots compare by physical identity (#7200): the payload root, the candidate toplevel
and both `--git-common-dir` values pass through `canonicalPathIdentity` (`realpathSync.native`), so
an 8.3 short spelling, another letter case or a junction spelling of the same checkout is that
checkout. When the match is found only this way, the effective root is the candidate (git's
spelling). No case fold applies to roots, so two case-distinct folders stay two repositories, and a
path whose native form cannot be read adds no equality. POSIX roots compare as before.

The write fence keeps up with that root on Windows. A target that is lexically outside the fence root
but whose native spelling is inside the root's native spelling (an 8.3 or other-case spelling of a
path in that checkout) is inside: `isOutsideProjectRootWrite` says so and `toProjectRelativePosix`
relativizes from the native forms, so story file_scope and denyPaths still apply. This only ever
moves a target inside, never outside. Admission still picks the target's toplevel from the target
as written (#4023, below).

Set level: `admitMutationTargetSet` admits every member of one mutation (the declared ApplyPatch
path plus every path in the patch body), short-circuits on the first refused member, and then
requires **one unique** effective root across the members (on Windows, two spellings of one root
count once). Two admitted roots is a
`worktree-span` refusal, so occupancy and ritual cannot follow only the declared path.

The last row is the subject of #4013. It fires for any destination whose nearest existing ancestor
directory is not inside a Git working tree — a path under the OS temp directory, a file in the home
directory, a scratch directory outside every checkout.

## The no-toplevel case is deliberate

**A write target with no Git toplevel is gated against the payload root. That is intended, not a
gap.** #3794's acceptance text required falling back to the payload root when a target worktree
could not be admitted, and commit `bcd9d34e` deliberately split the two situations that fallback
used to hold: a target that resolves to *some other* toplevel whose identity cannot be read now
fails closed as `unproven-identity`, while a target with *no* toplevel keeps the payload-root
behaviour. "A question asked and left unanswered" is the rationale for the fail-closed branch. It
is not the rationale for this one — no containment question was ever posed.

Three measured reasons the fallback is not a lease bug (#4013, accepted successor lean
[5481139589](https://github.com/deftai/directive/issues/4013#issuecomment-5481139589)):

1. **The effective root selects more than a lease.** It is the input to occupancy, the session
   ritual, active scope, the story write fence and assist-scratch classification. "No root, no
   gating" would drop all of those for an out-of-tree write, so an unritualed session — or an agent
   acting on an absolute path it read in an issue — could write a home, config or temp file with no
   ritual and no scope basis. It would also buy nothing on active scope, which already exempts
   outside-root writes (#2885).
2. **Occupancy and ritual are cross-checked, and the allow path re-stamps the lease.** The admitted
   owner is compared against the session the verified ritual is bound to. Relaxing only the
   foreign-lease refusal either leaves the writer blocked by that comparison, or suppresses it and
   lets one session ride another's ceremony. The same path re-stamps `heartbeat_at` immediately
   before an allowed write, so an unrelated out-of-tree write would renew the very lease a
   narrowing meant to decouple.
3. **A nullable root has no defined behaviour for a multi-target patch.** Target-set admission
   demands one unique root. If an outside member contributed nothing, a patch mixing a
   linked-worktree edit with an injected absolute path could collapse to the linked root and evade
   the `worktree-span` refusal; if absence dominated instead, one outside member would suppress the
   gates for the in-tree edit beside it. Either way an untrusted patch path becomes an
   authority-selection input — the containment risk #3794 closed.

The friction is real: a foreign lease holder should not block an unrelated note under the OS temp
directory. Relieving it costs a change to the authority contract, not a bug fix. See
[What a narrowing would have to define](#what-a-narrowing-would-have-to-define).

## What still runs for a no-toplevel target, gate by gate

| Gate | Root it reads | Disposition |
| --- | --- | --- |
| Occupancy lease | effective root (= payload root here) | **Runs.** A live foreign lease on the payload root denies `occupancy-occupied`; the owner or a granted member is admitted. |
| Session ritual, gated tier | effective root (= payload root here) | **Runs**, including the occupancy↔ritual owner cross-check and the pre-allow re-check. |
| Authz / UAT grant scoping | payload root | **Payload-root authoritative**, unchanged by admission. |
| Authz audit trail | payload root | **Payload-root authoritative.** |
| Kill-switch (`.deft-directive-disable`) | payload root | **Payload-root authoritative.** A flag beside the target does not disable the gate. |
| `deny().projectRoot` | payload root | **Payload-root authoritative**, so a deny is reported against the tree the host named. |
| Mutation intent ceiling (#1193) | neither | **Runs independently** of both roots. |
| Read-only posture | neither | **Runs.** |
| Runtime authority / path write fence | project policy from the payload root; story `file_scope` and the path it matches from the effective root | **Runs** when enabled. |
| Active scope | effective root | **Inspected, deny skipped.** The not-ready deny is skipped by the #2885 outside-root carve-out, measured from the payload root. Spawn tools have no write target and still require scope. |
| Assist-scratch allowlist | effective root | **No match.** An out-of-tree target is not under `.deft-scratch/` or `temp/` relative to the effective root, so the low-ceremony path does not apply. |

Read that table as the answer to "what does the lease actually protect here". The case is not a
lease question with one disposition; it is a root-selection question with a disposition per gate.

## The outside-every-checkout class (#6376)

A direct Write or Edit whose every target is in this class is allowed without the payload root's
occupancy lease and gated session ritual. The class is closed: any doubt keeps a target out, and a
target out of the class is judged exactly as the table above says. The class adds no deny.
Accepted design: [#6376, lean 6908601625](https://github.com/deftai/directive/issues/6376#issuecomment-6908601625).
Code: `packages/core/src/hooks/outside-every-checkout.ts`.

**Which targets are in the class.** For each target the test builds two paths: the typed path
(the target as given, normalized) and the physical destination (each existing component resolved
with the native resolver, the missing rest appended unchanged). Both paths must pass every rule:

1. **Positive location.** Inside the physical OS temp directory, inside a home directory (the
   OS home directory, `HOME`, `USERPROFILE`), or inside the **checkout folder** (#6871): the
   parent of the payload repository's main worktree. The main worktree is the folder that holds
   the common directory `git rev-parse --git-common-dir` reports for the payload root, compared in
   physical form. There is no checkout folder when the payload root is not a repository, the
   lookup fails, the repository is bare (its common directory is not a `.git` folder of a
   non-bare repository), or the parent is a filesystem or drive root. `git worktree list` is not
   read, so a worktree registration cannot add a location. A path inside temp or a home directory
   keeps those rules exactly, even when it is also inside the checkout folder.
2. **Not a configuration area.** A configuration area is a directory directly under a home
   directory whose name starts with a dot or is `Library` or `AppData` (any letter case), or a
   directory named by `APPDATA`, `LOCALAPPDATA` or an `XDG_*` base directory variable. When a path
   is inside both a configuration area and the temp directory, the innermost of the two decides.
3. **No repository and no Directive project.** No `.git` or `.deft` entry beside any ancestor of
   the typed path or of the physical destination, no ancestor that is itself a Git directory, a
   Git toplevel lookup that ran and reported no
   repository, and outside the payload root (`isOutsideProjectRootWrite`).
4. **Exclusions** (any letter case): a component that contains `deft` or `directive` or is named
   `.git` (for a path in the checkout folder and not in temp or a home directory, the
   `deft`/`directive` part skips only the components of the checkout folder's own path and reads
   every component below it, so `<folder>/.deft-scratch/x` stays out; the `.git` part and every
   other rule read the whole path); a path equal to or inside a path named by any `DEFT_*` or `DIRECTIVE_*` variable or by
   `OPENCLAW_STATE_DIR`, `CODEX_HOME`, `GH_CONFIG_DIR`, `PNPM_HOME`, `GIT_DIR`, `GIT_WORK_TREE`,
   `GITHUB_EVENT_PATH`, `GITHUB_STEP_SUMMARY`; a path inside a `PATH` directory; a path inside the
   running Directive runtime package. Each excluded value is compared in its typed form and in the
   physical form of its deepest existing folder, so a file that does not exist yet is still caught
   through a link; a relative value is read against the hook's working directory and the payload
   root. Positive location compares native names exactly, with no case folding on any platform,
   because a volume can be case-sensitive; configuration areas and exclusions may fold case, which
   only keeps more paths out.
5. **Doubt rules.** Out of the class: a target whose original spelling in the payload differs
   from the harvested one (surrounding whitespace trimmed, a `file:` URI decoded); a relative
   path; a `..` or `.` step anywhere in the typed
   path (it is never collapsed before links are followed); a backslash in a POSIX path (a filename
   character there, not a separator); a component that ends with a dot or a
   space, has the Windows short-name form (`~1`) or holds a colon after the drive; a device or
   network-share prefix; a walk directory that cannot be read; a Git lookup that could not run or
   disagrees with the walk; a home or temp directory that cannot be resolved; an existing file with
   more than one hard link; a link that cannot be resolved.

**Combining rule.** `admitMutationTargetSet` runs first and unchanged, so `foreign-repository`,
`unproven-identity` and `worktree-span` keep precedence. The class applies only when every target
of the mutation is in it. Only the bare host direct-write tools reach it; shell writes, generic MCP
writes and proxy wrappers are classified as before.

**Gates for a write in the class.**

| Gate | Disposition |
| --- | --- |
| Kill switch, read-only posture deny, Cursor planning-choice store check | **Run**, unchanged (upstream). |
| Protected-store authz, runtime authority | **Run** on the payload root, in the assist-scratch order. |
| Mutation intent ceiling (#1193) | **Runs**, so a non-implement slash verb still refuses. |
| Occupancy lease, gated session ritual, active scope, story write fence | **Do not run.** |
| Write-gate lease refresh and product-mutation marker | **None.** |
| General owner-liveness renewal | Unchanged. |

The allow carries the decision code `write-outside-every-checkout-ready`. The class selects no
ritual, lease, story or worktree registration, and it has no posture condition: a write in the
class is also allowed under requirements posture.

**What this gives up, on purpose.** Before #6376 a session with no valid ritual could not use Write
or Edit on a file in the OS temp directory or an ordinary home folder; now it can. Shell writes to
the same files never needed a ritual. Since #6871 the same holds for a plain folder beside the
main checkout (for example the folder that holds this repository's linked worktrees). A file in a
configuration area (for example an agent memory folder under a host's dot-folder) and a folder
outside the home, temp and checkout folders stay judged as before. A link created between the check and the write is not caught (the same check/use
residual as #3953).

**Naming rule for Directive code.** A file or folder that Directive keeps outside a checkout has
`deft` or `directive` in its name or in a parent folder name, lives in a configuration area, or is
named by a `DEFT_*` or `DIRECTIVE_*` variable. Every file or folder Directive creates under the OS
temp directory carries `deft` in its created name (`deftTempName` helps a caller-supplied prefix).
A unit test in `packages/core/src/hooks/dispatcher-outside-root.test.ts` scans the non-test source
of `packages/core/src`, `packages/runtime/src` and `packages/cli/src` and fails on a temp name
without `deft`.

**Ritual recovery names the judged checkout.** A direct write refused on the session ritual ends
with `Judged checkout: <path>.` and one command, for example
`deft session:start --rearm --session-id=<id> --project-root=<path>`, that runs as printed from any
directory. A path with characters other than letters, digits and `_.:\/+-` is single-quoted, which
neither POSIX shells nor PowerShell expand; a path holding a single quote or a control character
gets no printed command. When occupancy refuses the ceremony (#4290), only the checkout is named.

## Three surfaces, three behaviours

The fallback is a **direct-write** behaviour. It does not generalise across transports.

| Surface | Example tool name | Reaches root admission? | Out-of-tree destination |
| --- | --- | --- | --- |
| Direct write, bare host name | `Write`, `Edit`, `search_replace`, `ApplyPatch` | **Yes** | Judged against the payload root — the fallback above. |
| Generic server-prefixed MCP | `tasks__search_replace` | **No** | Routed only through push/merge runtime classification; unrecognized there, so `shell-op-unclassifiable` (fail open). |
| Recognized Shell file-write | `Set-Content -Path <os-temp>/note.md …` | **No** | `isInRepoShellWritePath` rejects destinations resolving outside the project root, so the #3987 reissue path skips them (fail open). |

Dedicated Write/Edit and recognized in-repository shell forms are gated; unrecognized
shell forms remain outside that coverage. This document does not claim universal shell
interception and does not add a general shell parser.

Catalogued MCP push/merge names (`git_push`, `merge_pull_request`, …) *are* gated — by runtime
authority scopes, which is a different gate and does not consult root admission either.

⊗ Do not state that the payload-root fallback fires "on the direct-write and MCP surfaces". #4013's
issue body said that and it is wrong for generic MCP. Three surfaces, three behaviours.

## Known limitation — relative targets have no declared base (#4023)

`existingAncestorDir` resolves the write target with `resolve(targetPath)` and no base argument, so
a **relative** target is canonicalized against the hook **process** working directory rather than
the payload root or a host-supplied cwd. The same lexical target can therefore land in different
rows of the first table depending only on where the hook runs. Symlink and Windows-junction targets
shift the class the same way: a junction into a linked worktree admits that worktree, a junction
into a non-repository directory falls back to the payload root.

Recorded, not fixed by #4013. Canonicalization changes admission classification, so it needs its own
arc: **#4023**. #7200 does not change this for relative targets or admission classification; on
Windows it only keeps an alias-spelled target inside its root at the fence (above).

## What a narrowing would have to define

A narrowing is refused *as filed*, not forever. A viable successor design would:

1. Name a target-class lattice: same admitted worktree, same-repository other worktree, foreign
   repository, unproven identity, proven no-toplevel.
2. State the combining rule for every mixed target set, so `admitMutationTargetSet` still yields one
   answer.
3. Keep the `foreign-repository`, `unproven-identity` and `worktree-span` refusals ahead of any
   exemption.
4. State, per gate in the table above, whether the exemption changes that gate — including whether a
   no-toplevel write may refresh any worktree lease, and whose ritual satisfies it.
5. Canonicalize targets first (#4023).

None of that would make #4013's filed premise — that the fallback is a defect — true.

#6376 is the narrowing that shipped. It answers these points without canonicalizing relative
targets: a relative target is never in its class, and every other target falls back to the rows
above. See [The outside-every-checkout class](#the-outside-every-checkout-class-6376).

## Commit targets — which checkout a `git commit` is judged against (#6278 / #6247)

The prospective scope-cover check on a Shell `git commit` (#5656) reads staged paths before the
commit runs. It reads them on the **target root**, the checkout the commit names:

| Command shape | Target root |
| --- | --- |
| `git -C <absolute path> commit …` | The named path, admitted as below. |
| `cd <absolute path> && … git commit …` (one `cd`, joined to the commit by `&&`) | The named path, admitted as below. |
| A commit with no `cd` and no `-C` | The hook project root, as before. |

A path is absolute when it is a native absolute path. On Windows that is a drive path (`C:\…` or
`C:/…`) or the MSYS drive form (`/c/…`), which maps to its drive path. Quoted and unquoted paths
resolve the same way; one quote-aware tokenizer serves commit recognition, target resolution and
the index-mutating-form check (`packages/core/src/hooks/commit-target.ts`).

**Admission.** A named path must exist and pass `admitEffectiveHookRoot`: same
`--git-common-dir` as the payload root, or deny (`foreign-repository-deny`). A commit target has
no non-repository fallback: a path outside every checkout, or a payload root that is not a
repository, is refused. The payload root stays the identity for authz, the kill-switch and deny
diagnostics.

**A different repository (#6871).** When the named path is a proven different repository (both
common directories were read and differ), the gate checks that repository's toplevel for a
Directive project: a `.deft` entry, `xbrief/PROJECT-DEFINITION.xbrief.json` or
`vbrief/PROJECT-DEFINITION.vbrief.json`. Each probe must report not-found (`ENOENT` or `ENOTDIR`);
any other result counts as present. When all three are absent, the commit gate returns no decision
for the call: that repository's own hooks and policy govern its commits. Otherwise the refusal
stays `foreign-repository-deny`, and its message says to commit from a Directive session in that
project. A separate clone of this repository is a Directive project, so it stays refused. The gate
does not judge a foreign Directive project at its own root. An unproven identity, a missing path, a
path outside every checkout, every same-repository target and the rule that every commit in one
call names one target are unchanged.

**Index and story.** Staged paths are listed on the target root, and `resolveWorktreeStoryBinding`
runs there: `bound` selects that worktree's story and its write fence; `refuse` denies with the
resolver's reason (never a fallback to another eligible story); `none` keeps the earlier
selection. The empty-index and lifecycle-only passes still apply, read from the target root.

**Refused as unresolvable** (the message names the two absolute forms): a relative path after
`cd` or `-C`; more than one `cd` or `-C` before the commit; a `cd` joined to the commit by `;` or
`||`, or reached through an `||` that can skip it (a `{ … }` brace group runs in the current
shell, so a `cd` or commit inside one is read the same way; a `( … )` subshell `cd` does not move
a later commit); a variable, `~` or substitution in the path; `--git-dir` / `--work-tree`; and a `GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE` or `GIT_COMMON_DIR` prefix on the commit. In each case the gate
cannot know which index the commit will use.

**Commit signals (#6362).** These are refused the same way, for the whole call, whatever visible
commit comes before or after them: a commit after `cd <path> &` (a lone `&` ends the command, so
the `cd` is not joined by `&&`); a commit inside a `( … )` subshell, also when the group spans
several commands (a group that closes first does not move a later commit, so
`(cd /r/wt) && git commit` is still judged at the hook root); a `git commit` in a literal
`sh -c` / `bash -c` string, `env -S` string or `eval`; a commit behind a wrapper (`env`,
`command`, `exec`, `nohup`, `time`, `timeout`, `xargs`, `nice`, `sudo`, `doas`, `stdbuf`,
`ionice`; only the wrapped command is read, not its arguments); a git subcommand that holds a
variable (`git $SUB`), refused even when it never commits; and, when the call shows the word
`commit`, a command word that holds a variable (`$GIT commit`) or a `-c`, `env -S` or `eval`
string that holds a variable or substitution. An unquoted heredoc body raises no signal, and its
parentheses open or close a group only inside a `$( … )`; only the commits it shows are read.

**The commit word (#6871).** A variable command word, and a `-c`, `env -S` or `eval` string that
holds a variable, is a signal only when the call shows `commit` (any case, as part of any word) in
the decoded word values of its command chunks or in the same text before decoding. Quoted heredoc
bodies are removed, unquoted bodies kept and line continuations joined, so `$GIT co''mmit` and a
`commit` split by a backslash-newline still show it. A call such as `$D verify:x`,
`$env:X = "1"; deft foo` or `bash -c "deft foo $X"` is not a commit. Limit: a command supplied
wholly by variables set earlier (`$RUN`, `eval "$RUN"`, or the word `commit` split across
variables) is not read.

**Array assignments (#6871).** A bash array-element assignment, `NAME[subscript]=value` or
`NAME[subscript]+=value`, is read as an assignment, like `NAME=value`, when the word holds no `$(`
and no backtick; its variable name without the subscript is checked against the `GIT_DIR`-class
prefixes above. This is assignment recognition only: it makes no claim that a subscript cannot
run code supplied by earlier shell state.

**Limits, named and not closed here.** A plain commit is still judged at the hook project root,
wherever the shell actually is; workers name their worktree in every git command (#6291). A
`git add` in the same call as the commit stages after the gate has read the index, and that now
also reaches the two named forms. The commit is held to the target story's `file_scope` for the
product paths in that snapshot; it does not authenticate which actor commits. Forms the gate does
not read stay open (#3595): keyword forms (`if … then git commit`, `!`), `pushd`, an exported
`GIT_DIR`, a commit in a one-line `$( … )`, scripts, and git verbs other than `commit` that
create commits. The git pre-commit hook runs only `verify:encoding`, so nothing catches them
later. This is a guardrail over the commands the gate reads, not a shell parser and not a
security boundary; branch policy (at push) and the merge-base scope fence (in CI) are unchanged.

## Warn-only sites behind a live merge gate (#6535)

Some local refusals repeat checks that the repository's merge path already runs. A repository can
let those sites warn instead of refuse. It names one required status check in
`plan.policy.mergeGateContext` of its project definition. Nothing else selects warn: no record, cache
file, flag or table mode, and neither the #1517 merge-gate record nor the #6281 refusal table is read.

**The signal.** The worktree copy of the project definition is only a trigger. With no name there,
the hook makes no GitHub call and refuses as today. With a name, the hook makes one read with a
ten-second budget at the site: it reads the project definition at the head of the delivery branch on
GitHub (contents API) and the branch's required status contexts (the #3234 reader). The signal holds
only when GitHub's copy names the same check and the contexts list it. A failed read, a timeout, a
different name or a name that is not required means no signal. The result lives for one hook call and
is written nowhere. The name is never taken from a local ref.

**The warn sites.** These sites warn under the signal; each one records today's refusal text as a
warning and evaluation continues, so every later check still runs and a later refusal wins:

| Site | What warns |
| --- | --- |
| Gated ritual | A stale, missing or other-worktree ritual and a failed ritual step. The compact-heal refusal and an inspection that throws still refuse. |
| Scope not ready | A write with multiple eligible briefs, zero eligible briefs or an env pin miss, when no worktree binding refused. Blocked-only scopes, spawns and binding refusals still refuse. |
| Positive governing allow | A write whose selected story has no positive `file_scope` allow. Spawns still refuse. |
| Commit check | Staged paths outside the story's `file_scope`, the same no-positive-allow result, and the index-snapshot word (`-a`, `-am`, pathspecs). The commit check then returns no decision and the shell route goes on to the write checks. |
| Story write fence | A direct write outside the selected story's `file_scope` that no project `denyPaths` or `allowPaths` refuses. |

The warning is the final allow's message. It starts with `Warning:`, gives today's refusal text and
one clause that local enforcement is advisory because the named check is required on the delivery
branch. It does not claim that check enforces the same condition. It uses the existing tool.before
allow-advisory field of each host: `reason` on Grok, `agent_message` on Cursor and
`additionalContext` on Claude and Codex.

**The floor.** Every refusal not in the table keeps today's behaviour: protected stores, the
kill-switch, occupancy, the intent ceiling, the installation identity check, foreign repositories,
tree-wide destructive git, default-branch push and force push, runtime-authority refusals other than
the story `file_scope` verdict, and the commit-target refusals.

**What it does not do (limits, named and not closed here).** The change adds no guard for secrets paths, deletes outside
the repository or force pushes to other branches; none exists today. It does not fix the hook-timeout
fail-open (#5920). The read budget bounds the added latency; a hook that still runs past the host
timeout fails open as before. The delivery branch name comes from the existing delivery-branch
resolver. The change does not prove that the named check runs every Directive gate: the operator
names it, and a wrong name, or a repository where an agent can merge its own pull request, weakens
only that repository. Commit verdicts for worktrees inside and outside the repository folder still
differ until #6471 is fixed in the runtime you run.

## Scope of this guarantee

Root admission is **cooperative host-session routing**, the same posture as the occupancy lease it
selects: hook payloads and local session ids are forgeable by a same-user process. It bounds
careless cross-tree writes; it is not an authentication boundary against an adversarial agent. See
[`contracts/path-write-fence.md`](../contracts/path-write-fence.md) for the same limit stated for
the write fence.

## Code

| Concern | Where |
| --- | --- |
| Root admission, single target and target set | `packages/core/src/hooks/dispatcher.ts` — `admitEffectiveHookRoot`, `admitMutationTargetSet` |
| Which gate reads which root | `packages/core/src/hooks/dispatcher.ts` — `inspectMutationGates` header comment |
| Nearest existing ancestor, toplevel and common-dir lookups | `packages/core/src/session/git.ts` — `existingAncestorDir`, `worktreePathOrNull`, `gitCommonDir` |
| Shell write-dest classification and the in-repo predicate | `packages/core/src/hooks/shell-write-targets.ts` — `isInRepoShellWritePath` |
| Tool-name surfaces | `packages/core/src/hooks/tools.ts` — `isDirectWriteTool`, `isShellTool`, `isMcpTool` |
| Commit-target tokenizer and resolver | `packages/core/src/hooks/commit-target.ts` — `resolveCommitTarget`, `tokenizeShellCommand` |
| Commit-target admission and scope-cover | `packages/core/src/hooks/dispatcher.ts` — `decideProspectiveGitCommitScopeCover`, `evaluateProspectiveScopeCover` |
| Merge-gate signal and warn sites | `packages/core/src/hooks/merge-gate-signal.ts`; `packages/core/src/hooks/dispatcher.ts` — `createMergeGateWarner`; `packages/core/src/policy/runtime-authority.ts` — `storyScopeOnly`; tests in `dispatcher-merge-gate-warn.test.ts` |
| Behaviour lock | `packages/core/src/hooks/dispatcher-effective-root.test.ts`; commit targets in `dispatcher-active-scope.test.ts` and `commit-target.test.ts` |
