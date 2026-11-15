# Hook root admission — which tree a gated write is judged against (#3794 / #4013)

Every PreToolUse mutation carries **two** roots, and they are not interchangeable:

- **payload root** — the project root the host hook payload names.
- **effective root** — the working tree the write target actually lands in, chosen by
  `admitEffectiveHookRoot` from the target path.

Deny messages name both: `payloadRoot=<path> effectiveRoot=<path>`.

This page publishes what root admission decides, which gate reads which root, and why the
no-toplevel case behaves the way it does. It describes shipped behaviour; it changes none of it.

## The outcomes of root admission

| Target's nearest existing ancestor resolves to | Outcome | Effective root |
| --- | --- | --- |
| The payload root itself | admit | payload root |
| Another working tree sharing `--git-common-dir` with the payload root | admit | that worktree |
| Another Git toplevel, while the payload root is not a Git repository | admit — no containment question exists | payload root |
| Another Git toplevel whose `--git-common-dir` cannot be read | refuse `unproven-identity` | — (deny) |
| A proven different repository | refuse `foreign-repository` | — (deny) |
| **No Git toplevel at all** | **admit** | **payload root** |

Set level: `admitMutationTargetSet` admits every member of one mutation (the declared ApplyPatch
path plus every path in the patch body), short-circuits on the first refused member, and then
requires **one unique** effective root across the members. Two admitted roots is a
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
arc: **#4023**.

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

**Limits, named and not closed here.** A plain commit is still judged at the hook project root,
wherever the shell actually is; workers name their worktree in every git command (#6291). A
`git add` in the same call as the commit stages after the gate has read the index, and that now
also reaches the two named forms. The commit is held to the target story's `file_scope` for the
product paths in that snapshot; it does not authenticate which actor commits. Other shell forms
(subshells, `pushd`, an exported `GIT_DIR`) are not interpreted; this is not a general shell
parser.

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
| Behaviour lock | `packages/core/src/hooks/dispatcher-effective-root.test.ts`; commit targets in `dispatcher-active-scope.test.ts` and `commit-target.test.ts` |
