# Follow-ups (within forensic mode)

Follow-ups are **narrower investigations** that inherit the active ledger. They are not a fresh full-tree rerun unless the operator changes anchor or asks to start over.

**Read `forensic-mode.md` first** — follow-ups only apply while mode is active.

---

## Detect follow-up

Any of:

- Operator references prior outcome ("on the 784 investigation", "you said embed contention", "that 8–10 minutes")
- Same anchor (crId / PR) + new **why** that drills into one mechanism claim
- Operator challenges a bullet ("18 files shouldn't take that long")

⊗ Re-run Wave 1 traps already `failed` in parent unless new evidence contradicts.

---

## Follow-up scaffold

**Same anchor, drill-down** (most common):

1. Keep **same** investigation id and `.active` pointer.
2. Add `branch.followup.<slug>` to existing `plan.items` (e.g. `branch.followup.scope`).
3. Set `operatorQuestionVerbatim` to the new message in `metadata.x-investigation` (append prior verbatim in `Observation` if useful).
4. Run Wave 2b-style mechanism claims for the follow-up branch only.
5. Append **`outcome-followup-<slug>.md`** or add **§ Follow-up** at bottom of `outcome.md` — do not overwrite §2 of original without operator ask.

**New anchor or explicit "start over":**

1. New investigation id.
2. `parentInvestigationId` + `plan.references` → parent `investigation.vbrief.json`.
3. Update `.active`.

---

## Example: #784 scope challenge

Operator: *"Why would 18 files alone cost 8–10 minutes on context? That shouldn't."*

| Step | Action |
|------|--------|
| Parse | Follow-up challenging `claim.mechanism.context.M3` (search volume) |
| Branch | `branch.followup.scope` |
| Claims | F1: single-pass context caps at 10 files per `review-session-context.ts` — 18 ≠ 18 embed loops; F2: `vectorContextCount` on timeout line; F3: ms/file vs #779 baseline; F4: operator "shouldn't" → trap — belief needs measured comparison not gut |
| ⊗ | Re-blame agentic, gates, or full slowness narrative |

**Good § follow-up answer:** "18 files inflates work but the path only vector-searches **10** diff files per pass; 8–10 min implies **~1 min/search** under fleet load, not file count alone — file count is contributing, not sufficient."

---

## Chat discipline

While mode active on follow-up:

- Lead with answer to **this** question only.
- Point to new/updated outcome section.
- §2b if still inferring (embed wait unknown, etc.).