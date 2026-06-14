# Question framing (read at Wave 0)

Operators often ask one sentence that contains **two questions**. Split them before building the logic tree.

---

## Operator voice (natural language)

The operator (the operator) speaks in **full sentences**, not command syntax. Treat messages as human conversation.

**Do:**

- Parse **intent** from plain English; do not require perfect structure or jargon.
- Treat **pasted log lines** as the anchor when present — extract crId, timestamps, events from them before asking anything.
- Record the operator's **verbatim** question in `metadata.x-investigation.operatorQuestionVerbatim`.
- When one message mixes topics, split them in the ledger — do not ask the operator to rephrase into machine format.
- When wording is ambiguous, prefer the **deeper** question: *why was it slow* (mechanism) over *that it failed* (terminal). The slowness clause is usually what they care about; failure is often context ("…and failed").
- Answer in plain English in `outcome.md`; translate evidence for a smart operator, not a developer peer.

**Do not:**

- Ask more than **one** clarifying question in Wave 0, and only if anchor is truly missing (no PR, no logs, no time hint).
- Nitpick grammar, demand `/flags`, or reject the request because they said "review" instead of "crId".
- Collapse "took so long **and** failed" into a single timeout answer — that answers failure, not slowness.
- Assume casual "failed" means only `review.failed` — it often means timed out, check run red, no useful result, or "didn't work out."

**Common phrasings → parse as:**

| Operator says (examples) | Primary intent | Secondary |
|--------------------------|----------------|-----------|
| "Why did this take so long" / "so slow" | `branch.slowness` + mechanism | — |
| "…and failed" / "didn't work" / "timed out" | still slowness if both present | `branch.terminal` |
| "What happened" / "what went wrong" | terminal + timeline first, then mechanism if duration mentioned | |
| "Investigate" + pasted logs | anchor from logs; infer slowness if duration/timeout in lines | |
| "This review" / "earlier today" | deictic — resolve from logs, check run, or thread context | |

---

## Example

> "Investigate why this review took so long and failed earlier today"

| Parsed question | Type | Acceptable one-line answer? |
|-----------------|------|----------------------------|
| Why did it **fail**? | Terminal | "Check run `timed_out` after 20m session wall" |
| Why did it take **so long**? | Mechanism | ⊗ "Because it timed out" ⊗ "Because context phase was 11 min" |

**Terminal answers describe the exit.** They do not satisfy slowness questions.

**Slowness answers name a mechanism:** embed fleet wait, index-read gate degrade, N concurrent reviews inflating embed latency, stale index, etc. Phase duration is **evidence** for the mechanism search, not the mechanism itself.

---

## Wave 0 scaffold

Set in `plan.narratives.Problem`:

```
Anchor: <crId, time, pasted log lines>
Operator question (slowness): <verbatim slowness clause>
Operator question (terminal): <failure/symptom clause if distinct>
```

Seed branches:

| Branch | Serves |
|--------|--------|
| `branch.terminal` | How the session ended (timeout, failed, salvage) |
| `branch.slowness` | Why wall clock was high |
| `branch.traps` | Popular wrong theories |

⊗ Merge terminal and slowness into one conclusion.

---

## Tautology trap (Wave 5 validator)

**Reject** investigation close if `narratives.Outcome` or `outcome.md` "why slow" section is only:

- "failed because it timed out / hit the session cap"
- "slow because `<phase>` took X minutes" with no completed child under `branch.mechanism.<phase>`
- "contributing factor: concurrent work" without a verified mechanism claim (embed contention, gate wait, CPU pressure, etc.)

**Minimum for slowness close:** at least one `branch.mechanism.*` child `completed` OR all mechanism children `failed`/`blocked` with explicit "mechanism unknown" and list of what was checked.

---

## Mechanism drill-down rule

When `branch.slowness` identifies dominant phase `P` (e.g. context):

1. Spawn `branch.mechanism.P` nested items from domain pack § Phase mechanisms
2. Wave 2b: dispatch branch investigator for `branch.mechanism.P` (parallel ok)
3. ⊗ Set `plan.status: completed` until `branch.mechanism.P` resolved

Phase timings go in `Observation`. Mechanism claims go in `branch.mechanism.*`.

---

## Operator challenge (mandatory re-verify)

When the operator **disputes** an agent claim — e.g. "it was the only review running", "the VM was sick all day", "that's not a huge PR" — that is not debate. It is a **falsification signal**.

1. Record `EV-OPERATOR-*` with verbatim operator text + timestamp.
2. Re-run the cheapest disproof for the disputed claim (log lifecycle count, fleet day metrics, `gh pr view` file count).
3. Update ledger claim status before any chat repeats the old narrative.
4. If operator supplies decisive context (host sickness, deploy state), weight `EV-OPERATOR` equal to log evidence in `branch.mechanism.host` and traps.

⊗ Repeat concurrency/embed theories after operator challenge without new EV refs.

---

## Ledger field

```json
"operatorQuestionVerbatim": "<paste full operator message or slowness clause>"
```

Synthesizer `outcome.md` §2 should read as a direct reply to that sentence — not a pipeline post-mortem template.

When §2 uses **inference** (mechanism claim `completed` but evidence is indirect, or sibling claims `blocked`), §2b is **mandatory**: name observability gaps and actionable logging/metrics additions (see `outcome-template.md` §2b).