# Domain pack: code-debug

Local and CI failures — tests, builds, regressions. No Fly unless operator ties incident to production.

---

## Evidence adapters

| Adapter | When | How |
|---------|------|-----|
| **Test output** | Failing test named | `npx vitest run <path>`, capture to evidence/ |
| **Git diff** | Recent change suspected | `git diff`, `git log --oneline -10` on anchor commit |
| **Local repro** | Runnable failure | Minimal command in evidence/repro.txt |
| **CI logs** | CI-only failure | `gh run view`, job logs excerpt |
| **Code read** | Trace needed | Read call chain; cite file:line in EV description |

---

## Starter logic tree — "Why does this fail?"

| id | title |
|----|-------|
| `branch.repro` | Cannot reproduce or wrong failure mode |
| `branch.regression` | Worked before — bisect recent changes |
| `branch.environment` | Env/toolchain/dependency mismatch |
| `branch.logic` | Code path bug — wrong behavior in isolated trace |

---

## Popularity traps

### trap.flaky

| Claim | Check |
|-------|-------|
| `claim.trap.flaky.B1` | Fails 3/3 runs same command same env |

### trap.wrong_test

| Claim | Check |
|-------|-------|
| `claim.trap.wrong_test.B1` | Test models call shape different from production call site |

### trap.stale_fixture

| Claim | Check |
|-------|-------|
| `claim.trap.stale_fixture.B1` | Fixture diff matches current PR under test |

---

## Disproof order

1. Re-run failing test once
2. Read error at cited line
3. Compare to last green commit
4. Minimal repro script
5. Widen to integration only if unit seam insufficient

---

## Feedback loop (diagnose parity)

Before Wave 2 branch work, orchestrator should confirm a **repro signal** exists (failing test, repro command, or captured CI log). If none, branch.repro stays active until loop exists.