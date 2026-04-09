# JavaScript Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: ES2022+, Node 20+; Build: Vite/esbuild; Testing: Vitest/Jest; Lint: ESLint + Prettier; Web: React/Next.js

**Note**: For TypeScript projects, prefer [typescript.md](./typescript.md). Use JavaScript only when TypeScript is not feasible.

## Standards

### Documentation
- ! JSDoc comments for all exported functions, classes, and constants
- ! Document `@param`, `@returns`, `@throws` on public functions
- ~ Use `@typedef` and `@type` for complex shapes when not using TypeScript

### Testing
See [testing.md](../coding/testing.md).

- ! Use Vitest (or Jest) + coverage
- Files: `*.spec.js` or `*.test.js`

### Coverage
- ! ≥85% coverage
- ! Count src/\*
- ! Exclude entry points, scripts, generated code, config files

### Style
- ! Use ESLint + Prettier (project configs required, checked in)
- ! Use `"use strict"` in CommonJS; ESM is strict by default
- ~ Prefer ESM (`import`/`export`) over CommonJS (`require`/`module.exports`)

### Types & Safety
- ! Use `===` / `!==`; ⊗ `==` / `!=` (type coercion bugs)
- ! Use `const` by default; `let` when reassignment needed; ⊗ `var`
- ! Use template literals over string concatenation
- ~ Use optional chaining (`?.`) and nullish coalescing (`??`)
- ⊗ Rely on implicit type coercion for logic (truthiness traps)
- ~ Use JSDoc + `// @ts-check` for type-checked JavaScript when TS is not available

### Error Handling
- ! Use `try..catch` for async operations; always handle promise rejections
- ! Throw `Error` instances (or subclasses), not strings or plain objects
- ⊗ Swallow errors (empty catch blocks)
- ~ Create domain-specific error classes extending `Error`
- ~ Use `.catch()` or `try..catch` with `await`; ⊗ unhandled promise rejections

### Async
- ! Use `async`/`await` over raw Promises/callbacks for readability
- ! Handle all promise rejections
- ⊗ Mix callbacks and promises in the same API
- ⊗ Use `new Promise()` when `async`/`await` suffices (promise constructor anti-pattern)
- ~ Use `AbortController` / `AbortSignal` for cancellable operations
- ~ Use `Promise.allSettled()` when partial failures are acceptable

### Modules & Imports
- ! One module per file; name file after the primary export
- ! Use named exports for most cases; default exports for React components / main entry
- ⊗ Circular imports
- ~ Use barrel files (`index.js`) sparingly — only for public API surfaces

### Security
- ⊗ Use `eval()`, `Function()`, or `innerHTML` with untrusted data
- ⊗ Hardcode secrets in source
- ! Sanitize/validate all external input
- ~ Use Content Security Policy (CSP) headers in web applications

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging (pino, winston) for production
- ~ Sentry.io for error tracking
- ? OpenTelemetry for distributed tracing

## Commands

See [commands.md](./commands.md).

## Patterns

### Testing
```javascript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUser } from "./user-service.js";

describe("createUser", () => {
  const mockRepo = { save: vi.fn() };

  beforeEach(() => { vi.clearAllMocks(); });

  it("saves user and returns id", async () => {
    mockRepo.save.mockResolvedValue({ id: 42 });
    const result = await createUser(mockRepo, { name: "Alice" });
    expect(result.id).toBe(42);
    expect(mockRepo.save).toHaveBeenCalledWith({ name: "Alice" });
  });

  it("throws on invalid name", async () => {
    await expect(createUser(mockRepo, { name: "" }))
      .rejects.toThrow("name is required");
  });
});
```

### Error Handling
```javascript
class NotFoundError extends Error {
  constructor(entity, id) {
    super(`${entity} not found: ${id}`); this.name = "NotFoundError";
  }
}

async function getUser(id) {
  const res = await fetch(`/api/users/${id}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new NotFoundError("User", id);
  return await res.json();
}
```

### Modern Patterns
```javascript
function createConfig({ host = "localhost", port = 3000, debug = false } = {}) { return { host, port, debug }; }
const city = user?.address?.city ?? "Unknown";
const [users, orders] = await Promise.all([fetchUsers(), fetchOrders()]);
const activeEmails = users.filter(u => u.active).map(u => u.email);
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **`for...in` on arrays**: Use `for...of` or array methods
- ≉ **Barrel re-exports everywhere**: Hurts tree-shaking
- ≉ **God modules**: Keep files <300 lines

## Compliance Checklist

- ! JSDoc on all exported APIs
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! ESLint + Prettier configured and enforced
- ! `const`/`let` only; `===`/`!==` only
- ! All promises handled; `async`/`await` for I/O
- ⊗ `var`, `eval()`, loose equality, unhandled rejections
- ! Run `task check` before commit
