# Forensic mode (session contract)

Forensic research is a **mode**, not a one-shot skill invocation. The operator enters it for a line of questioning and stays in it until they say otherwise.

---

## Enter mode

Mode becomes **active** when:

- Operator asks a causal investigation (`why did`, `investigate why`, `root cause`, `what caused`, `forensic research`), **or**
- Operator explicitly says: **forensic mode**, **stay in forensic**, **remain in forensic mode**, **keep investigating**

**First action on enter:**

1. Scaffold investigation (Wave 0) if none active.
2. Write `.tmp/investigations/.active` — single line, investigation id only (e.g. `2026-06-13-deftvisage-784-timeout`).

**First chat line while mode active:**

> Forensic mode active — investigation: `.tmp/investigations/<id>/`

---

## While mode is active

Apply **all** iron laws and waves on every turn until exit. ⊗ Casual diagnosis in chat. ⊗ "Quick answer" bypass.

### Chat gate (while `plan.status: running`)

| Allowed in chat | Forbidden until validator pass + `plan.status: completed` |
|-----------------|--------------------------------------------------------|
| "Forensic mode active — `.tmp/investigations/<id>/`" | Root cause or lead mechanism |
| Current wave + what's in flight | Concurrency / embed / host / queue counts |
| "Investigation in progress — see ledger" | Config or code change recommendations |
| Point at existing `outcome.md` from a **completed** prior pass only | Paraphrasing mechanism from ledger before Wave 5 |

Follow-ups in mode still obey the gate — extend the ledger, do not narrate early.

**Operator does NOT re-declare mode each message.** Say "forensic mode" or ask the first "why" once; then plain follow-ups ("what about 18 files?", pasted logs, "that still seems high") stay in mode until exit. Agent checks `.tmp/investigations/.active` at turn start — if present, mode is on without trigger keywords.

| Operator does | Agent does |
|---------------|------------|
| New causal question, same anchor | **Follow-up** on active investigation (see `follow-ups.md`) |
| New causal question, new anchor | New investigation id; update `.active` |
| Narrower "why" on prior bullet | Follow-up branch under active ledger |
| Log paste | Evidence for **active** investigation |
| Unrelated task (commit, implement, fmt) | **Confirm** — "Still in forensic mode on `<id>`. Do that anyway or exit forensic first?" One question only. |

**Mode does not block** unrelated work if operator clearly scopes it ("exit forensic and commit" or "leave investigation, just fix X"). When in doubt, ask once.

---

## Exit mode

Mode ends when operator says (examples):

- **exit forensic** / **leave forensic mode** / **done investigating** / **stop forensic** / **normal mode**

**On exit:**

1. Append `metadata.x-investigation.modeEndedAt` (ISO time) on active ledger if present.
2. Delete `.tmp/investigations/.active` (investigation folder **stays** for comparison).
3. Confirm: "Forensic mode off. Investigation artifacts kept at `.tmp/investigations/<id>/`."

⊗ Delete investigation folders on exit unless operator asks.

---

## Resuming in a new agent session

If `.tmp/investigations/.active` exists and operator message is investigative:

1. Read pointer → load that ledger + `outcome.md`.
2. Say: "Resuming forensic mode on `<id>`."
3. Treat message as follow-up unless operator names a new anchor.

If pointer missing but a recent investigation folder matches operator topic, offer once: resume that id or start fresh?

---

## Ledger fields

```json
"x-investigation": {
  "mode": "active",
  "modeEnteredAt": "2026-06-13T...",
  "parentInvestigationId": null
}
```

Follow-up investigations set `parentInvestigationId` to prior id; add reference to parent ledger.