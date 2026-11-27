# Human-origin approval + UAT mutation lease (#2944 / #2948 Wave 1)

Layer **L1–L2** of the layered authorization stack (epic #2948). Composes with
`runtimeAuthority` (L3, #1394 / #2711) and does **not** re-implement Shell push/merge
matchers.

Threat model: **aligned agent** confusion — the agent believes self-authored
xBRIEF/lifecycle/dispatch state is permission. Credential-compromised local-file
forgery remains #983-class out of scope.

## Defaults

| Surface | Default | Notes |
| --- | --- | --- |
| UAT lease | inactive | No Wave 1 denials until operator starts UAT |
| Human-origin grants | none | Minted only via `deft authz:grant` |

## Human-origin grant

Stored under `.deft/authz/grants/<id>.json`.

Accepted `origin.kind` values:

- `operator-cli` (mint path: `deft authz:grant`)
- `operator-session` (future interactive approval)
- `human-event` (external human event ref)

**Rejected** (never satisfy an implementation-approval gate):

- `agent-lifecycle`, `xbrief-status`, `dispatch-envelope`, `allocation-context`,
  `self-asserted`, `agent-authored`
- any grant with actor `agent` / `agent:*` / `self`

Structural binding (not crypto/HMAC):

- `scope.planRef`, `repo`, `branch`, `worktree`
- `scope.surfaces` — path globs (including user-visible UI)
- `scope.operations` — `edit` \| `push` \| `pr` \| `merge` \| `settings` \| `deployment` \| `issue_mutation`
- `scope.storyIds` / `issueIds`
- `scope.cohortId` — **required** for product mutations while UAT is active
- `semantics.expiresAt` / `singleUse`

## Fail-closed UAT mutation lease

Start: `deft authz:uat-start -- --campaign <id>`  
Suspend: `deft authz:uat-suspend`  
Inspect: `deft authz:show`

While UAT is **active** (and was started with human-origin provenance):

| Attempt | Result without matching fix-cohort grant |
| --- | --- |
| Product / UI direct write | **deny** |
| `git push` / classifiable push MCP | **deny** |
| `gh pr create` / ready / edit | **deny** |
| `gh pr merge` / classifiable merge MCP | **deny** |
| settings / deploy heuristics | **deny** |
| Test execution (`vitest`, `pnpm test`, …) | **allow** |
| Issue filing (`gh issue create`) | **allow** |
| Evidence / defect capture writes (`xbrief/proposed/**`, `evidence/**`, `uat-evidence/**`, `incidents/**` at repo root) | **allow** |

Approving one named fix cohort **does not** clear the UAT lock or authorize adjacent
failures or other operations (e.g. edit grant ≠ push).

## Enforcement order (PreToolUse)

1. Ritual / scope / read-only / spawn gates
2. **Authz Wave 1** — UAT lease + human-origin grant (`#2944`)
3. Runtime authority path + `scopes.edits` / `scopes.push` / `scopes.merge` (#1394 / #2711)

While UAT is active, missing-operation and expired-grant denials name human-presence
`deft authz:uat-suspend` from a real operator console (listed agent/CI markers empty,
stdin+stdout TTY, controlling terminal, `--confirm`, typed phrase `mint` — suspend
reuses the mint phrase). `authz:grant`, `authz:uat-start`, and `authz:revoke` stay
hard-refused while the lease is active. After suspend, grant is available again
through the same human-presence gate.

Audit appends to `.deft/authz/audit.jsonl` with:

`humanApprovalRef`, `approvedScope`, `attemptedOp`, `path`, `result`, `code`, `campaignId`.

## CLI

```bash
deft authz:show
deft authz:uat-start -- --campaign uat-2026-07-30
deft authz:grant -- --operations edit --surfaces 'apps/web/src/**' --cohort fix-defect-12 --stories 2944
deft authz:uat-suspend
deft authz:revoke -- grant-…
```

## Operator mint inventory (#7031)

An operator mint is the terminal step `refuseNonInteractiveMint` runs. On an
ordinary human console (no agent or CI marker) that means a real TTY, a
controlling terminal, `--confirm`, and the typed phrase `mint`. It proves that
a person was at a terminal. It does not prove that the person reviewed anything,
and it does not check identity.

Under agent or CI markers, inventoried kept-mint verbs
(`scope:record-approved-scope`, `authz:grant`, `authz:uat-start`,
`authz:uat-suspend`, `authz:revoke`) do **not** forge by unsetting markers
(#7279). The harness may only **request-open**: freeze verb, authority payload,
canonical checkout, and resolved destinations under a single-use request id.
Bare chat-yes is that request-open only and never stamps. Completion is an
operator-controlled confirmation surface — controlling-TTY phrase `mint` or a
host-authenticated user-event — bound to that unchanged request, with a fresh
command-specific admission recheck (including active-UAT refuse and the
`uat-suspend` exception) before existing writers run. Observable-scope and
intent-constraint stay on #7031 declared writers; `--minted-via in-harness-ask`
is not restored for them; #6945 signed keep-out is unchanged.

A command keeps the mint when its record is live authority before any merge: a
hook or a verb reads it inside the session, before a PR exists. A command drops
the mint when its record is read only from the merge base, so the merge that
lands it comes first.

| Command | Store | Read at | Hook denies writes in the checkout | Self-approval it prevents | Mint | What the kept mint buys |
| --- | --- | --- | --- | --- | --- | --- |
| `authz:grant` (every template: AFK, closed-verb, finish-loop, gate-override, spec-drift-override; acceptance-disposition, plan-sequence-approval and delivery-identity-attest write the main clone's store) | `.deft/authz/grants/` | live hook and local grant store | yes (`.deft/authz/`) | an agent grants itself edit, push, PR, merge, a gate override or a deferral | kept | the command stops while agent markers are set; the in-checkout write deny |
| `authz:grant --template one-pr-unit` | Directive App store | App store (one-PR proof) | no (outside the checkout) | an agent approves its own one-PR unit | kept | the command stops while agent markers are set |
| `authz:uat-start` | `.deft/authz/` UAT lease | live hook | yes | an agent locks the tree under a campaign it chose | kept | the command stop; the in-checkout write deny |
| `authz:uat-suspend` | `.deft/authz/` UAT lease | live hook | yes | an agent lifts the UAT lock it works under | kept | the command stop; the in-checkout write deny |
| `authz:revoke` | `.deft/authz/grants/` (retries in the main clone's store) | local grant store | yes, in this checkout only | an agent deletes a human grant | kept | the command stop; the in-checkout write deny |
| `scope:record-approved-scope` | `.deft/approved-scope/` | write-fence hook (working tree) and merge base | yes (`.deft/approved-scope/`) | an agent widens its own `file_scope` fence | kept | the command stop; the in-checkout write deny |
| `scope:record-observable-scope` | `.deft/observable-scope/` | merge base (`verify:observable-scope`) | no | none: the record is a declaration | dropped; writes `kind: "declared"` | n/a |
| `scope:record-intent-constraint` | `.deft/intent-constraint/` | merge base (`verify:intent-constraint`) | no | none: the record is a declaration | dropped; writes `kind: "declared"` | n/a |

The in-checkout write deny covers `.deft/authz/` and `.deft/approved-scope/`
only, and only for writes inside the checkout. A kept mint does not make a
store unwritable. Known limits:

- Claude Code's PowerShell tool is not inspected by the hooks (#6981).
- An absolute Write or Edit from a linked worktree into the main clone's
  `.deft/authz/` is not denied (#7036).
- A commit made on the forge (web edit, API) never meets a local hook.
- Presence is marker-based: a shell with no agent or CI marker and a TTY passes.
  The mint checks markers and the terminal, not who is typing.
- Brief stamps such as the presentation ceiling and the durable-effect ceiling
  are checked by shape only.

### Control for the two dropped commands

`scope:record-observable-scope` and `scope:record-intent-constraint` write from
any shell, an agent's included, with
`humanApproval: {kind: "declared", actor, mintedAt, mintedVia: <command>}`.
They refuse `--kind` and `--minted-via`; `--actor` is an optional declared-by
name and may name an agent. An active UAT lease still refuses them.
`isHumanApprovalStamp` does not accept `declared`, so approved-scope, the
one-PR proof and every other human-approval reader refuse a declared record. A
declared record is a declaration the product check holds the PR to, not an
approval.

| Merge policy | Control on a declared record |
| --- | --- |
| `requireHumanMerge: true` | The person who merges the PR that lands the record. The human stop moves from the terminal to that merge. |
| Bot merge, or a merge under the operator's own identity | None. Nothing human checks the record. |

The story fence refuses a direct write of these record paths unless the
merge-gate signal is live; the command is a writer the fence does not see. A
fact found mid-build still needs a record PR on the merge base before the
product PR, because the product check reads the record from the merge base and
refuses a same-PR record.

### Signed level (#6945)

With `.deft/approvers.json` on the merge base, those two commands no longer
treat a declared stamp as enough. `--request` prints a ceremony link and
writes nothing. `--assertion` writes the records only after the blob verifies
against an enrolled key. There is still no terminal step. A record without a
valid approval is not approved, including one merged under
`DEFT_ALLOW_BOT_MERGE`, `policy:allow-bot-merge`, or a plain `gh pr merge`.
A valid approval proves a user-verified gesture by an enrolled authenticator over exactly this set. The human read it only if the page ran on a device the agent does not drive and was deployed with credentials the agent does not hold. Without the trust file, the declared write above is unchanged.
`approvers:enroll` and `approvers:remove` are the same kind of command: no
terminal step, and they accept only the page's combined blob.

### TOTP-armed operator delegation (#7420)

A phone-only operator may arm a time-boxed delegation from chat with
`deft delegate on [<ttl>] <code>` (default 12h, maximum 72h). The code is a TOTP
code from a secret enrolled at a terminal with `deft delegate enroll --confirm`.
While the delegation is live, #7279 harness-attended requests complete with
provenance `delegated-totp` (never `host-user-event`) for
`scope:record-approved-scope` and for `authz:grant` with `release-cut`,
`release-publish`, `release-rollback` or `release-promote-latest` only. Every
other verb and template refuses as before, including `finish-loop`,
`gate-override`, `spec-drift-override`, raw-ops grants, `authz:uat-*` and
`authz:revoke`. The human merge gate is unchanged.

A delegated grant or stamp has the delegated origin (`operator-delegated`), not
human origin. Exactly one check accepts each: the scope-provenance fence for a
stamp, and `evaluateClosedVerb` for a release grant, only for the verb its
template names. `isHumanOrigin`, `isHumanApprovalStamp` and the general grant
check refuse it. It expires no later than the delegation and stops admitting
when the delegation ends (`delegate off`, TTL, session end, UAT start, the kill
switch, a terminal `authz:revoke`).

Strength: parity of forging effort with the terminal mint, and a wider blast
radius. The secret is readable by the operator's OS user, so an agent shell can
compute a code, as a same-user process can drive a pseudo-terminal through the
terminal mint. One arm buys hours, not one mint. The passkey (#6945 / #7046) is
the upgrade that makes the code unproducible by an agent. Under standing
delegation the #7279 request digest is not human review. Full contract:
[operator-delegation.md](../docs/operator-delegation.md).

## Gate-override hatch (#5542 / #5674)

Mint + admission APIs for an audited interactive override bound to a coverage-
applicability refuse (#5542). Consumer wiring on pre-PR `coverage_headroom` /
`deft coverage:hotspots` lands as **exit 4** + distinct waived skip token with
admission-receipt re-verify (#5674). Measured Istanbul floor/headroom failure
still dominates when a coverage report exists. Exit 4 never maps to pass /
exit 0. Residual deposit keep-unknowns (run / hooks / codeql / approved-scope)
stay open on #5677. Classifier exact-path relief for ordinary managed
stamps/ledgers is #5665 — not this hatch.

```bash
deft authz:grant -- --template gate-override --target <refuseCode> \
  --plan-ref <attemptId> --base-sha <sha> --head-sha <sha> --tree-hash <hash> [--confirm]
deft coverage:hotspots --attempt-id <attemptId>
```

| Rule | Detail |
| --- | --- |
| Mint provenance | `origin.kind=operator-cli` only via live `authz:grant` human-presence; `operator-session` non-admitting; refuse chat/parent/fixture consent |
| Binding | gate id + refuse code + `baseSha+headSha+treeHash` + attempt id (+ optional worktree/evaluator) |
| Admission | Atomic one-use via claim lock; inspection does **not** consume; same attempt reuses receipt; renew after revoke/expiry replaces under an attempt-id lock |
| Result arms (#5674) | Live `waived` on coverage-hotspots + pre-PR evidence via exit 4 + waived skip token — **never** map to pass / exit 0; measured floor dominates when a report exists |
| Eligible refuse codes | Closed set (`unknown-path`, `dirty-tree`, …); non-overridable authenticity codes (`tree-mismatch`, `invalid-*`) dominate |
| Deferred peers | Empty list in v1 |
| Push/merge | Grant is `settings` only — no independent push/merge permission |
| Keep-outs | Does not fix #5541 / #5665 classifier correctness; no fabricate green; no UAT silent suspend; no blanket env override |

Complementary hatches stay separate: `--allow-coverage-debt`, `policy:allow-*`,
`DEFT_ALLOW_*`, delivery-attempt `recordOperatorOverride`, `spec-drift-override`,
`delivery-identity-attest`, `acceptance-disposition`.

## Delivery identity attestation (#6317)

Recovery for merged work with no merge-time identity basis (#6310 Bound 3). An
operator attests one PR and its merge commit for one plan; the completion
identity join then accepts the basis `operator-attested`.

```bash
deft authz:grant -- --template delivery-identity-attest \
  --target <owner>/<repo>#<pr>@<merge_commit_sha> --plan-ref <scopeId> [--confirm]
```

| Rule | Detail |
| --- | --- |
| Mint provenance | `origin.kind=operator-cli` only, through the same human-presence mint gate; default expiry 24 hours; single-use |
| Binding | PR number + full merge commit sha + plan id; `operations=[settings]` only, no push/merge permission |
| Admission | Grant matches, the PR's merge-time body was read, and the PR passes the nonzero-file and delivery-exclusion checks. A body with `deft-story-part: N` is admitted only on the `scope:complete` command, and only after the part-line sibling check (#6645): the PR is a product part (a path outside the brief-land family and outside `.deft/`), no other merged or open product part of the story on this repository's base (forks included) carries a story line, and no open PR there carries `deft-story: N`. Activation, mint and other brief-only or `.deft/`-only part-line PRs never block. A failed read is a retry, never an admission |
| Use record | First use must be before expiry; it is recorded when the `completed/` write succeeds, not in the join. An acceptance refusal leaves the grant unused. A later run for the same plan, PR and merge commit (finalize retry, restamp) accepts the used grant |
| Expired | An expired, unused grant refuses completion and names a re-mint or `authz:revoke`; an unreadable `--expires` is refused at mint, and an unused grant with a missing or unreadable expiry never attests |
| One store | Mint, every read, the use record, `authz:revoke` and `authz:show` resolve the store at `mainWorktreeRoot(projectRoot)`, so the primary clone, a linked dest and the finalize lifecycle checkout share it; an unresolvable root refuses |
| Provenance | `completionProvenance.identityBasis=operator-attested` and `attestationGrantId` |
| Remedy text | A refusal prints the mint command only when this run would admit the grant: the body was read, no earlier read failed, the plan has an id, the store resolved, and the delivery checks passed. Every other refusal names its own remedy (#6645) |
| Keep-outs | Never a finalize close for a part-line PR: `swarm:finalize-cohort`, `completeCohort` and the in-PR tip proof keep the part-line refusal, grant or not; a body with both story lines is never attested; never bypasses a PR's own contested sole mark (that settles by the delivery-branch stamp); does not relax ancestry |

## Acceptance-disposition deferral (#6318)

Records that acceptance items are deferred to a later issue without editing the
active brief (#6310 Bound 4). `scope:complete` writes the `deferred` disposition
on the covered items instead of merge evidence.

```bash
deft authz:grant -- --template acceptance-disposition --plan-ref <scopeId> \
  --story-ids <itemIds> [--disposition deferred|not_applicable|waived] \
  [--deferred-to <issue>] --reason <text> [--confirm]
```

`--disposition` defaults to `deferred` (#6644). `--reason` is required for every value.
`--deferred-to` is required for `deferred` and refused for `not_applicable` and `waived`.
A grant minted before #6644 reads as `deferred`. A clause a grant stamps in a
`scope:complete` run stays in the brief but is left out of the walk counts (#6644);
a disposition written into the brief by hand never is.

| Rule | Detail |
| --- | --- |
| Mint provenance | `origin.kind=operator-cli` only, through the same human-presence mint gate; default expiry 24 hours; single-use |
| Inputs | `--story-ids` are `clause.N` ids or plan item ids; `--deferred-to` is `N`, `#N` or `owner/repo#N`; `--reason` is one non-empty line; `--expires` must be a readable future date. The brief is found by plan id in `active/`, `pending/`, `proposed/`, then `completed/`, in the current checkout, then the main clone |
| Binding | Plan id plus, per covered id, a sha256 digest of `acceptance.clauses[id].text` (a plan item that is not a clause uses its title); `operations=[settings]` only |
| Admission | On first use and on any replay, only for that plan and those ids, and only while each digest still matches. A changed clause refuses and names a re-mint. Per id the latest usable grant wins (ordered by a millisecond mint time). A restamp of a brief already in `completed/` replays each grant its dispositions cite, only while that grant is used or still live; the brief's own `recorded_at` is never proof of use. Each cited disposition is rewritten from its grant (`deferred`, the grant's reason and `deferred_to`, the grant id), so a hand-edited disposition does not survive a restamp. When the cited grant no longer fits, the latest used or live grant that covers the item with a matching digest replaces it; with none, restamp refuses and names a replacement mint for the completed brief |
| Complete-prep | Dispositions (`deferred`, the reason, `deferred_to`, `provenance.grantId`) apply in memory after `persistClauseKeyedPendingItems` and before `stampMergeFromCompletionProvenance`, so the merge stamper skips them. The mid-flight active write leaves them out; they land only with the `completed/` write. `swarm:complete-cohort --dry-run` applies them on its clone |
| Use record | First use must be before expiry; it is recorded when the `completed/` write succeeds. An acceptance refusal leaves the grant unused. A used grant replays |
| Expired | An expired or inactive unused grant refuses completion and names a re-mint or `authz:revoke`, unless a later usable grant covers the same plan and every one of its ids. A missing or unreadable expiry never authorizes an unused grant |
| One store | Same store as `delivery-identity-attest`: `mainWorktreeRoot(projectRoot)` for mint, reads, use record, `authz:revoke` and `authz:show`; mint refuses an unresolvable root. A completion run with no resolvable store sees no grant and stamps as before (stated limit of the #6310 lean) |
| Keep-outs | The intent extract is unchanged: a hand-written disposition on an active brief still fails scope-provenance membership |

## Explicit non-goals (siblings)

| Concern | Owner |
| --- | --- |
| Shell/MCP push/merge matchers alone | #2711 |
| Slash-command intent ceiling / human merge | #1193 |
| Path write fence schema | #516 / #2443 |
| AFK session-auth / release verbs | #1095 — see `content/contracts/closed-verb-authz.md` (Wave 4; consumes these grants) |
| HMAC / hardware-keyed grants | non-goal for MVP |
| Classifier false-refuse correctness | #5541 / #5665 (not absorbed by gate-override) |
| Interactive gate waiver audit | #5542 (this hatch) |
| Pre-PR/hotspots waived-exit consumer + VERSION/lifecycle gitkeep inert | #5674 (leftover #5665/#5542) |
| Residual deposit keep-unknowns (run / hooks / codeql / approved-scope) | #5677 |

## Wave 4 consumers

Release-class closed verbs (`release-cut`, `release-publish`, `release-rollback`)
evaluate via `evaluateClosedVerb` and accept only:

- `DEFT_ALLOW_<VERB>=1` ephemeral bypass, or
- a **human-origin** grant from this store (templates: `deft authz:grant -- --template release-publish --target <ver>`)

They do not mint grants of their own. Walk-away finish-loop product: #871 (Wave 5) —
`authz:grant --template finish-loop` and `content/contracts/finish-loop.md`.

Refs #2948 #2711 #1394 #1378 #2176 #2402 #1095.
