# #2190: `biome check .` non-deterministic diagnostic severity -- reproduction + mitigation

## Summary

PR #2186's CI run (`TypeScript (build + lint + test)` job, `pnpm run lint` step)
reported `lint/correctness/noUnusedVariables` (in `packages/cli/src/*-fixtures.ts`)
and `lint/style/noNonNullAssertion` (in
`packages/core/src/architecture/sor-preflight.ts(.test.ts)` and
`packages/core/src/verify-source/cursor-tier1.test.ts`) as **12 errors** (exit 1),
while master, PR #2188's CI run, and every local reproduction attempt below
report the identical diagnostics as **50 warnings** (exit 0) -- on the same
pinned `@biomejs/biome@2.5.0`, installed via `--frozen-lockfile` (so this is not
version skew).

## Reproduction attempts (2026-07-02)

All runs used the frozen-lockfile-resolved `@biomejs/biome@2.5.0` binary
(`node_modules/.bin/biome`).

| Environment | Runs | Checked files | Errors | Warnings | Exit |
|---|---|---|---|---|---|
| Worktree checkout (`.deft-scratch/worktrees/2190-biome`, feature branch) | 3x | 1162 | 0 | 50 | 0 |
| Main checkout (`master`, clean tree) | 2x | 1162 | 0 | 50 | 0 |
| Worktree + 1 extra untracked `.ts` file with a genuine unused variable | 1x | 1163 | 0 | 51 | 0 |

**The error-tier flip did not reproduce locally** across either checkout, run
repetition, or a deliberate file-discovery perturbation (adding an untracked
file). `noUnusedVariables` surfaced as a **warning** in every local run,
including for a freshly-introduced, genuinely-unused variable in the untracked
probe file -- confirming the *current* effective severity for both guarded
rules is warning-tier under the `recommended` preset in this environment, not
error-tier.

### What the untracked-file probe shows

`vcs.useIgnoreFile: true` only consults `.gitignore` / `.ignore` / git's local
exclude file -- it does **not** restrict analysis to tracked files. An
untracked file that is not gitignored is included in the checked-file set (1162
-> 1163) and can change the warning count. This confirms file-discovery *can*
vary between a clean checkout and a dirty/worktree checkout that has stray
untracked files, but in our probe it only ever added a diagnostic at the
existing (warning) tier -- it did not change any rule's *severity tier*.

## Why the flip likely happened in CI and not locally

We could not obtain access to the failing CI job's runner state to confirm
directly, but the evidence is consistent with two candidate mechanisms, listed
by plausibility:

1. **Biome 2.5.0 internal non-determinism under the `recommended` preset.**
   Biome's own docs (`biomejs.dev/linter/`) note that a rule's default severity
   under a preset is derived from the rule's own declared default, and that
   `biome ci` (not `biome check`) is the documented CI-flavored entrypoint (it
   adds VCS-`--changed` semantics and thread-count controls). Nothing in the
   public 2.5.0 changelog documents a known determinism bug for
   `noUnusedVariables` / `noNonNullAssertion` specifically, but the project
   already runs `biome check .` (not `biome ci`) in CI, so any latent
   preset-resolution race under increased parallelism (the CI runner
   (`blacksmith-4vcpu-ubuntu-2404`) is a different core count / thread pool
   size than a typical dev machine) is not ruled out.
2. **CI runner state reuse.** Blacksmith runners are marketed on VM/cache
   reuse across jobs for speed. If a prior job on the same runner left a
   stray Biome daemon process or a differently-configured `node_modules`
   cache fragment, a subsequent job could observe severities resolved against
   stale state rather than the current checkout's `biome.json`. We have no
   direct evidence for this (no runner shell access), so it remains a
   hypothesis, not a confirmed cause.

Both mechanisms are consistent with the issue's own observation that a
rebase + rerun cleared the failure with no code change.

## Mitigation implemented (config-owned, reproduction-independent)

Because the root cause could not be conclusively pinned down, the fix targets
the failure mode directly rather than the hypothesized cause -- per the #2190
issue's own suggested action, both flip-able rules now carry an **explicit**
severity in `biome.json` rather than inheriting from `preset: "recommended"`:

```json
"linter": {
  "enabled": true,
  "rules": {
    "preset": "recommended",
    "correctness": { "noUnusedVariables": "warn" },
    "style": { "noNonNullAssertion": "warn" }
  }
}
```

An explicit `"warn"` cannot silently resolve to `"error"` from a preset
default or a future Biome version bump -- the tier is now declared in version
control, not derived. This keeps today's green baseline (50 warnings, exit 0)
unchanged.

`@biomejs/biome` in `package.json` is also pinned to the exact `2.5.0` (the
`^2` range is dropped) so the declared dependency range itself can no longer
float, even though the lockfile already resolved `2.5.0` before this change --
removing one more variable from the reproduction matrix.

A guard test
(`packages/core/src/verify-source/biome-config.ts` /
`biome-config.test.ts`) asserts `biome.json` declares an explicit
non-`"error"` severity for both rules, so a future preset bump, `biome
migrate`, or manual edit that drops the explicit entry (or sets it to
`"error"`) fails `task check` instead of silently reintroducing the
flip-to-error risk.

## Out of scope

Mass-fixing the pre-existing 50 warnings is explicitly out of scope for this
story; the goal is deterministic severity, not zero diagnostics.

## References

- Issue #2190
- Issue #1882 (the cohort during which #2190 was surfaced)
- PR #2186 (the CI run exhibiting the flip)
