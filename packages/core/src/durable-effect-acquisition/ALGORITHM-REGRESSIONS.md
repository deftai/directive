# Durable-effect algorithm regressions

Golden head/base fixtures that pin escaped algorithm bugs of the class fixed and
discussed around `deftai/directive#5101` (durable-effect acquisition under an
armed presentation ceiling).

Corpus file: `algorithm-regressions.test.ts`.

## Probes

| id | What it pins | Call shape |
| --- | --- | --- |
| `deleted-file-not-classified` | A file present at merge-base with a would-be durable-effect (collector URL) that is **deleted** at head must not produce findings keyed to that path. Deletion is absence (`readAtHead` → `null`), never a base fallback. | `evaluateDurableEffectAcquisition` via `ev()` with `deleted` + `changed` listing the path |
| `unchanged-effect-not-new` | When base content equals head for a file that would classify in isolation, the delta is empty: no **new** facts, exit clean (`code === 0`). | `evaluateDurableEffectAcquisition` via `ev()` with identical base/head sources |
| `admitted-package-exact-match` | `importFact` continues only on **exact** `admittedPackages` name match. `approved-package` does not admit `approved-package/sub`; the subpath creates an import fact unless that exact specifier is itself admitted (no silent prefix grant). | `classifyTsxSource` with `admittedPackages`, plus full `evaluateDurableEffectAcquisition` with a stamped ceiling |

## How to add a probe

1. Give the case a stable `id` (kebab-case) and append it to the `probes` table in
   `algorithm-regressions.test.ts`.
2. Prefer the injected `ev()` helper (same shape as `fixtures.test.ts`):

   ```ts
   evaluateDurableEffectAcquisition({
     projectRoot: process.cwd(),
     mergeBase: "injected",
     changedFiles: changed,
     presentationFiles: /* in-class paths */,
     readAtBase: (rel) => baseFiles[rel] ?? null,
     readAtHead: (rel) => /* deleted → null; else head[rel] ?? baseFiles[rel] ?? null */,
   });
   ```

3. For import / package policy, prefer `classifyTsxSource(path, source, ctx)` with
   an explicit `admittedPackages` list so the assertion names the fact id
   (`import:…`). Use a full evaluate + ceiling when the bug only shows up after
   amendment intersection / arming.
4. Ceiling artifact: `.deft/presentation-ceiling.json` with
   `schema: "deft.presentation-ceiling.v1"`, `changeClass: "presentation"`.
   Grants require `humanApproval` (see `emptyAmendments` in `ceiling.ts`).
5. If a probe correctly fails because of a real algorithm bug, keep the failing
   assertion and mark it:

   ```ts
   // REGRESSION: <short description of the production defect>
   ```

   Do **not** weaken the probe to match buggy behavior. Document the failure in
   the IMPLEMENTATION note and leave production code unchanged unless a separate
   repair is authorized.

6. Run:

   ```bash
   pnpm -w exec vitest run packages/core/src/durable-effect-acquisition/algorithm-regressions.test.ts
   ```
