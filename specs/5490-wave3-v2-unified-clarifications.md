# Wave 3 V2 — UNIFIED clarifications (C1–C8)

| | |
| --- | --- |
| Design authority | `UNIFIED-GITHUB-V2.md` / #5490 — stay on V2 |
| Strategy | `IMPLEMENTATION-STRATEGY-YOLO-WAVE3-V2.md` (orchestrator home: `~/Projects/directive-install-simplification-2`) |
| Base tip | `yolo/cp-wave3c` @ `2a38865d8c04522e5228c6eb70377476c06c8336` |
| Verdaccio | `yolo-cp-wave3c` / `0.0.0-yolo.cp-wave3c.1` |
| Status | Operator-approved **reading rules** for UNIFIED-V2. Not a redesign. Cut UNIFIED-V3 only per C8. |

These clarifications are checked into the patient tip so upgrade/uninstall/doctor work can cite them without opening UNIFIED-V3. Prefer this appendix + survey table updates over inventing Part B conflicts.

---

## C1 — Upgrade may perform internal uninstall/reinstall

§A6.7 / AC10.3 / Part B feature-preservation already allow convert **or** internal uninstall/reinstall preserving settings and project data. Clarification: **`directive upgrade` may execute that internal path in one approved operation** (removal steps + pin change + setup + migrate) without requiring the user to run `directive uninstall` then `directive install`. User-facing refuse+name-uninstall remains only for shapes still marked **unsupported-honest** after fixtures fail or operator deferral.

## C2 — Survey decisions are living under AC10.8

WAVE3-V1 assigned several shapes `uninstall-reinstall` (user-facing). WAVE3-V2 flips those to **`convert`** (mechanism = composed removals + L0 arrival) once fixtures pass. Update `specs/5490-wave3-historical-survey.md` decision column in the same waves that land green support.

## C3 — AC14.32 scope

AC14.32 applies only while a shape remains survey-marked **reinstall** / unsupported. After a shape is marked **convert** and fixture-proven, upgrade must mutate per plan (not stop with uninstall+install naming).

## C4 — AC11.5 empty parents (F-012) — **required AC tighten**

Current AC11.5 text that permits leaving empty parents is **too weak for ship quality**. Clarification / erratum: after Directive removes a file or entry it owned, **prune empty directories it emptied**, walking up while parents are empty **and** existed only as containers for removed Directive-owned content. Never delete a non-empty directory or a parent that still holds user/foreign content. Acceptance: HT-06 / uninstall fixtures assert no empty Directive husk trees under host skill/command roots, `.githooks`, etc.

## C5 — Sole-author husks (F-013)

After owned removal, if a file is **solely Directive-authored residue** (e.g. `package.json` only `{ "private": true }` with matching near-empty lockfile we created; host hooks JSON now `{}` that we created; `AGENTS.md` reduced to install-seeded stub with no user body), **remove the file**, then apply C4 prune. Preserve true user content and foreign keys. `xbrief/` always kept (AC8.4 / AC10.6).

## C6 — Doctor composition (F-015)

AC12.3’s install-sync surface list is **additive**, not a license to hide the pre-existing product doctor suite behind an unreachable code path. Clarification: `directive doctor` **composes** install-sync diagnosis **and** the full product doctor (or an explicit documented second phase invoked by the same verb). Silent drop of the deep suite is a defect. Prefer option **(A) compose in one verb** unless the operator later chooses a taught split.

## C7 — No-git precondition (F-010)

Prefer **warn + allow partial install**, with plan / completion / doctor / recovery telling one story: incomplete without git; next step `git init` then `directive install --repair`. AC6.2 “doctor in sync after first install” applies when preconditions for full install were met. Do not claim clean AC6.2 on no-git partial installs. (Refuse-without-git remains an operator-optional stronger gate; default for this train is warn+partial+consistent messaging.)

## C8 — When to cut UNIFIED-V3

Only if clarifications C1–C7 cannot be reconciled with Part B text mid-run **and** the operator directs a V3 pin. Default: stay on V2 + this appendix + survey table updates.

---

## Pointers

- Wave order / strategy table / F-* map: `IMPLEMENTATION-STRATEGY-YOLO-WAVE3-V2.md`
- Survey decisions (living): `specs/5490-wave3-historical-survey.md`
- Removal substrate (3d+): `packages/runtime/src/removal-steps/`
- Registry decision enum (cli, AC3.1-thin): `packages/cli/src/legacy-shapes/registry.ts` → `convert-via-removals`

---

*End of specs/5490-wave3-v2-unified-clarifications.md*
