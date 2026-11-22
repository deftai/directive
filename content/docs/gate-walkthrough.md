# Gate walkthrough: one push, one completion, one plan update

This page gives the full command sequence for three common jobs. At each step it names the gate that can refuse and the remedy that gate prints. Read it before you read runtime source to learn what a gate wants (#6281).

Values in angle brackets are yours to fill: `<N>` is the issue number, `<brief>` is the path of the story brief under `xbrief/active/`, `<branch>` is your feature branch, `<pr>` is the pull request number and `<owner/name>` is the repository.

A **declared refusal** is a row in the refusal declaration table (`packages/core/src/refusal-declarations/table.ts`). Its line starts with `deft gate <id>` and ends with `Remedy:` and the commands to run, in order, as printed. A test runs each declared remedy as printed. In `warn` mode the line says the gate can refuse from a later release, and the work goes on.

## One push

1. Start the session and activate the story.

   ```bash
   deft session:start
   deft scope:promote -- <brief>
   deft scope:activate -- <brief>
   deft xbrief:preflight -- <brief>
   ```

   - **Write fence (#5656).** A Write or Edit outside the running brief's `file_scope` is refused. Remedy: the refusal names `deft scope:promote -- <path>` then `deft scope:activate -- <path>` for a brief that is not active yet. For a path that is not in `file_scope`, widen the brief before activation, or stop and report the path.

2. Create a feature branch.

   ```bash
   git switch -c <branch>
   ```

   - **Branch gate (`verify:branch`, #746).** A commit or push on the default branch is refused. Remedy: `git switch -c feat/<name>`.

3. Commit.

   ```bash
   git add <paths>
   git commit -F <message-file>
   ```

   - **Encoding check (`verify:encoding`, #798)** in `.githooks/pre-commit`. Remedy: rewrite the named file as UTF-8 with no mojibake, then commit again.
   - **Commit scope check (#5656).** A staged product path outside the brief's merge-base `file_scope` is refused. Remedy: unstage that path, or widen the brief in its own PR.

4. Run the pre-PR workflow and push.

   ```bash
   deft pre-pr:run --repo <owner/name> --base-sha <sha> --head-sha <sha> --tree-hash <sha> --body-file <pr-body> --approved-revision <sha>
   git push -u origin <branch>
   ```

   - **Bound pre-PR push gate (#5804), declared row `pre-pr-push-gate`.** A push of product or test changes is refused unless a completed pre-PR pass is bound to the pushed HEAD and covers the outgoing paths. Remedy: start a `deft pre-pr:run` controller run for this HEAD (the line fills `--head-sha`), observe every phase in `deft-directive-pre-pr` skill order (`--observe-command` and `--observe-semantic`), run `deft pre-pr:run --complete` (it runs `verify:ac` itself; a failed `verify:ac` refuses, #6888), then `git push`. This remedy is not runnable exactly as printed: you fill the angle-bracket values and do the review the semantic phases record. A one-command pre-PR is #5933.
   - **Does a pass gate the push? (#6893).** Only when `plan.policy.requireBoundPrePrPush` is true. Then the managed `pre-push` hook (`preflight-gh --pre-push-stdin`) refuses a push of non-docs changes without a pass bound to HEAD. False or not set: the hook does not look for a pass. `deft pre-pr:run --push-admit` treats not set as on. `deft pre-pr:run --complete` prints the value on success. Completing a run is not push admission.
   - **Finishing a run (#6893).** Required phases, in order: `branch_policy`, `plan_sequence`, `read`, `write`, `lint_iteration`, `render_export`, `diff`, `loop` (`deft pre-pr:run --help`). `--observe-semantic` needs only `--run-id` and `--phase`: the controller hashes the run's changed files itself. `merge_chokepoint` is optional, and `--complete` does not need a PR.

5. Open the pull request.

   ```bash
   gh pr create --body-file <pr-body>
   ```

   The body carries `Refs #<N>` and the story line `deft-story: <N>` on its own line, and a `## Documentation impact` block.

## One completion

Run after the story's product PR is merged.

```bash
git fetch origin
deft swarm:finalize-cohort -- --stories <brief> --pr <pr> --repo <owner/name> --no-commit
git commit -F <message-file>
git push -u origin <branch>
gh pr create --body-file <pr-body>
```

When finalize finds no merged delivery PR, run `deft scope:complete -- <brief> --merge-commit <sha> --pr <pr>` instead.

After the completion PR merges:

```bash
deft verify:orphan-active --issue <N>
deft verify:completed-tracked --issue <N>
```

- **Acceptance gate (`verify:ac`, #3284)** at `scope:complete`. Each clause's artifact must exist at its path and each verify command must pass. Remedy: ship the artifact the failed clause names, then run `scope:complete` again.
- **Orphan active (`verify:orphan-active`, #3429).** A brief still in `active/` for a closed issue or a merged PR fails. Remedy: the printed `deft scope:complete -- <path>`.
- **Completed tracked (`verify:completed-tracked`, #3476).** The completed brief must be on the fetched delivery branch. Remedy: `deft swarm:finalize-cohort` and a lifecycle PR.

## One plan update

Add an unplanned story to the ordered plan, then check that it is the target.

```bash
deft plan-sequence:current
deft plan-sequence:insert --kind story --id <id> --issue <N> --expected-generation <n>
deft verify:plan-sequence --target-kind story --target <id>
```

- **Plan approval.** When `plan.policy.requireBoundPrePrPush` is true, `insert` needs a single-use operator grant. Remedy: the operator runs `deft authz:grant -- --template plan-sequence-approval --target insert:story:<id> --plan-ref <sequence_id> --generation <n> --confirm`, then `insert` again.
- **Plan gate (`verify:plan-sequence`).** A target that is not the current entry (or in the current batch) is refused. Remedy: work on the entry that `deft plan-sequence:current` prints, or ask the operator to insert the target.

## Setup and hooks

These two refusals are declared refusals (rows `setup-hook-files` and `hooks-installed`), and their remedies run as printed:

- **`setup-hook-files`.** `task setup` (consumer: `task deft:setup`) refuses when `.githooks/` lacks `pre-commit`, `pre-push` or `_directive-run.sh`. Remedy: `directive install --repair --yes`.
- **`hooks-installed`.** `verify:hooks-installed` refuses when the hooks are not wired or not functional. Remedy: `directive install --repair --yes`. Repair keeps the pinned version, so it is never a downgrade to an older npm latest.
