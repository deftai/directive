# TypeScript Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../../main.md) | [PROJECT.md](../../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: TypeScript 5.0+, Vitest/Jest; Web: React 18+/Next.js; CLI: commander; Build: Vite/tsup

## Standards

### Documentation
- ! TSDoc comments for all exported APIs

### Testing
See [testing.md](../coding/testing.md).

- ! Use Vitest (or Jest) + coverage
- Files: `*.spec.ts` or `*.test.ts`

### Coverage
- ! ≥85% coverage
- ! Count src/\*
- ! Exclude entry points, scripts, generated code

### Style
- ! Use ESLint + Prettier
- ~ Prefer functional over classes where practical

### Types
- ! Use strict mode
- ⊗ Use `any` — including `as any` or `as unknown as T` casts to bypass type checking
- ~ Prefer `unknown` for inputs from untrusted sources; narrow with type guards before use
- ⊗ `unknown` as a function return type where the concrete type is knowable
- ⊗ `@ts-ignore` or `@ts-expect-error` without an inline comment explaining why it is safe

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging (pino, winston) for production
- ~ Sentry.io for error tracking
- ? OpenTelemetry for distributed tracing

## Commands

See [commands.md](./commands.md).

## Patterns

**Parameterized Tests**: `test.each([[1,2],[3,4]])('case %s', (a,b) => {...})`
**Setup/Teardown**: `beforeEach(() => {})`, `afterEach(() => {})`, `beforeAll`, `afterAll`
**Mocking**: `vi.fn()`, `vi.mock('module')`, `vi.spyOn(obj, 'method')`
**React Testing**: `@testing-library/react` - `render()`, `screen`, `fireEvent`, `waitFor`
**Async**: `await` in tests, `waitFor(() => expect(...))` for async UI

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.spec.ts"]
}
```

## package.json

```json
{
  "type": "module",
  "scripts": {
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --ext .ts,.tsx",
    "fmt": "prettier --write 'src/**/*.{ts,tsx}'",
    "build": "tsup src/index.ts --format esm,cjs --dts"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "@vitest/coverage-v8": "^1.0.0",
    "eslint": "^8.56.0",
    "prettier": "^3.2.0",
    "tsup": "^8.0.0",
    "typescript": "^5.3.0",
    "vitest": "^1.0.0"
  }
}
```

## vitest.config.ts

Key settings: `globals: true`, `environment: "node"` (or `jsdom`), `coverage.provider: "v8"`, `thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 }`, include `src/**/*.ts`, exclude tests.

## .eslintrc.json

Key settings: `@typescript-eslint/parser`, extends `recommended` + `recommended-requiring-type-checking`, rules: `no-explicit-any: error`, `no-unused-vars: [error, { argsIgnorePattern: "^_" }]`, `explicit-function-return-type: [warn, { allowExpressions: true }]`.

## Hygiene

**Dead code:**
- ~ Run `knip` to detect unused exports, files, and dependencies
- ~ Add `knip` as a `task hygiene` target; treat unused exports in library code as errors

**Circular dependencies:**
- ~ Run `madge --circular --exit-code src/` to detect cycles; resolve by extracting shared types to a lower-level module
- ⊗ Circular imports between modules — use dependency inversion (interfaces/types in a shared module)

**Error handling:**
- ⊗ Empty `catch` blocks or `catch (e) {}` — log or re-throw
- ⊗ Returning `null`, `undefined`, or a neutral default to mask a thrown error

## TypeScript 7 side-by-side (pre-7.1)

TypeScript 7.0 ships without a stable programmatic compiler API. A direct `typescript` major bump to 7 breaks `typescript-eslint` (for example `ModuleKind.Cjs` is undefined). Until ~7.1, ! run TS 7 side-by-side with a TS 6 alias for tooling that still needs the compiler API — the same pattern as [deftai/cartograph#111](https://github.com/deftai/cartograph/pull/111).

### package.json aliases

Keep `typescript` on the TS 6 API for ESLint, `tsc --noEmit`, and other programmatic consumers. Install TS 7 under `@typescript/native`:

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@^7.0.2",
    "typescript": "npm:@typescript/typescript6@^6.0.2"
  }
}
```

Use `@typescript/native` (or `pnpm exec tsgo`) for TS 7-native typechecking when you opt in; keep existing `typescript` / `tsc` scripts on the alias until typescript-eslint and your toolchain support TS 7's programmatic surface.

### Dependabot

Because `typescript` is aliased to `@typescript/typescript6`, ! ignore Dependabot major bumps on the `typescript` dependency name until you intentionally migrate off the side-by-side layout:

```yaml
ignore:
  - dependency-name: "typescript"
    update-types: ["version-update:semver-major"]
```

### Scaffold and doctor coverage

**Scaffold bake — deferred (#2591):** Directive does not ship a Deft-owned TypeScript `package.json` scaffold to mutate. New TypeScript projects copy the alias snippet from this section into their own `package.json`.

**Doctor hint — shipped (#2591):** `deft doctor` warns (advisory, exit-exempt) when `package.json` declares typescript-eslint (`typescript-eslint` or `@typescript-eslint/*`) and `eslint`, and `typescript` resolves to 7.x without the `@typescript/typescript6` alias — pointing here and at the Cartograph alias pattern above. Scaffold bake remains deferred.

### References

- [Announcing TypeScript 7.0 — side-by-side install](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#side-by-side-installation) — official TS 7 side-by-side guidance.
- [typescript-eslint#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518) — typescript-eslint TS 7 / compiler API tracking.

## Compliance Checklist

- ! Include TSDoc comments for all exported APIs
- ! Use strict TypeScript; ⊗ use `any`
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Run `task check` before commit
