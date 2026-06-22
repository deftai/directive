# Office.js Standards (Excel JavaScript API)

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../../main.md) | [PROJECT.md](../../PROJECT.md) | [typescript.md](./typescript.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: TypeScript 5.0+, Office.js (Excel JavaScript API); Build: webpack/Vite; Testing: Vitest + office-addin-mock; Manifest: unified JSON manifest (preferred) or XML manifest; Scaffolding: Yeoman (`yo office`) or manual

**Note**: Office.js builds on TypeScript but has a fundamentally different execution model — proxy objects, `RequestContext`, `context.sync()` batching, and platform-dependent API surfaces. The general [typescript.md](./typescript.md) standards apply to all TypeScript code in the project. This module adds the Office.js-specific patterns that generic TypeScript standards do not cover.

## Standards

### Documentation
- ! TSDoc comments on all exported functions, classes, and custom function definitions
- ! Document `@param`, `@returns`, `@throws` for public APIs
- ! Document platform availability when using APIs not in the base requirement set (e.g., `// Requires: ExcelApi 1.9+`)
- ~ Document `context.sync()` boundaries in complex functions with inline comments explaining what is being batched

### Execution Model
- ! All Excel API interactions MUST happen inside `Excel.run(async (context) => { ... })`
- ! Minimize `context.sync()` calls — batch reads and writes between syncs
- ! `load()` properties before reading them — proxy objects do not pre-populate
- ! Specify only the properties you need in `load()`: `range.load("values, address")` not `range.load()`
- ⊗ Access proxy object properties before calling `context.sync()` after `load()` — values are not populated until sync completes
- ⊗ Store proxy objects outside their `Excel.run` scope — they become invalid after the run completes
- ⊗ Nest `Excel.run()` calls — use a single run with multiple syncs when needed

### Sync Batching
- ! Group related reads together, sync once, then process results
- ! Group related writes together, sync once at the end
- ~ The ideal pattern is: load → sync → compute → write → sync (two syncs per operation)
- ⊗ Sync after every individual read or write — this defeats the batching model and causes severe performance degradation
- ⊗ `context.sync()` inside a loop — batch the operations and sync once after the loop

```typescript path=null start=null
// ✓ Correct: batch reads, sync, compute, batch writes, sync
await Excel.run(async (context) => {
  const revenue = context.workbook.names.getItem("in_base_revenue").getRange();
  const growthRate = context.workbook.names.getItem("as_growth_rate").getRange();
  revenue.load("values");
  growthRate.load("values");
  await context.sync();

  const projected = computeProjection(revenue.values, growthRate.values[0][0]);

  const output = context.workbook.names.getItem("calc_projected_revenue").getRange();
  output.values = projected;
  await context.sync();
});

// ⊗ Wrong: sync inside loop
await Excel.run(async (context) => {
  const table = context.workbook.tables.getItem("RevenueTable");
  const rows = table.rows;
  rows.load("count");
  await context.sync();
  for (let i = 0; i < rows.count; i++) {
    const row = rows.getItemAt(i);
    row.load("values");
    await context.sync(); // ⊗ N round trips instead of 1
    // ...
  }
});
```

### Error Handling
- ! Wrap `Excel.run()` calls in try/catch at the call site
- ! Check for `OfficeExtension.Error` and extract `code`, `message`, `debugInfo`
- ! Handle `InvalidReference` errors specifically — they indicate a range that no longer exists (row/column deleted)
- ! Handle `ItemNotFound` errors when looking up named ranges, tables, or sheets that may not exist
- ⊗ Swallow `context.sync()` errors — they indicate failed API operations that leave the workbook in an unknown state
- ~ Provide user-facing error messages that distinguish between "model error" (the xlconfig is wrong) and "runtime error" (Excel API failure)

```typescript path=null start=null
try {
  await Excel.run(async (context) => {
    // ... operations ...
    await context.sync();
  });
} catch (error) {
  if (error instanceof OfficeExtension.Error) {
    switch (error.code) {
      case "ItemNotFound":
        showError(`Named range not found: ${error.message}`);
        break;
      case "InvalidReference":
        showError("A referenced cell no longer exists. Check if rows/columns were deleted.");
        break;
      default:
        showError(`Excel error: ${error.message}`);
    }
  } else {
    throw error;
  }
}
```

### Custom Functions
- ! Use the `@customfunction` JSDoc tag for registration
- ! Custom functions run in a separate runtime — they have NO access to the DOM, task pane, or `Office.context`
- ⊗ Import task pane code into custom function modules — they share no runtime
- ! Custom functions that call external APIs MUST handle timeouts and return meaningful error values
- ! Use streaming functions (`@streaming`) for real-time data (prices, rates) — return `invocation.setResult()` on each update
- ! Cancel streaming gracefully via `invocation.onCanceled`
- ⊗ Synchronous custom functions that perform I/O — all I/O must be async

```typescript path=null start=null
/**
 * Calculates projected revenue for a given year.
 * @customfunction PROJECTED_REVENUE
 * @param baseRevenue Base year revenue
 * @param growthRate Annual growth rate (decimal, e.g. 0.05 for 5%)
 * @param years Number of years to project
 * @returns Projected revenue
 */
export function projectedRevenue(
  baseRevenue: number,
  growthRate: number,
  years: number
): number {
  return baseRevenue * Math.pow(1 + growthRate, years);
}
```

### Named Ranges and Tables
- ! Reference named ranges and Excel Tables (`ListObject`) by name — never by hardcoded cell address
- ! Use `context.workbook.names.getItemOrNullObject(name)` to safely check for named range existence
- ! Use `table.columns.getItemOrNullObject(columnName)` for safe column lookup
- ⊗ Hardcode cell addresses (`"B5"`, `"Sheet1!$C$10"`) in production code
- ~ Use helper functions that centralize range resolution from config or named ranges

```typescript path=null start=null
// ✓ Batching-friendly: no internal sync — load all named items and call context.sync() once in the caller
function loadNamedItem(
  context: Excel.RequestContext,
  name: string
): Excel.NamedItem {
  const item = context.workbook.names.getItemOrNullObject(name);
  item.load("isNullObject");
  return item; // caller must await context.sync() before checking isNullObject
}
```

### Platform Awareness
- ! Check API requirement sets before using platform-specific features
- ! Document minimum requirement set in manifest and README
- ~ Test on all target platforms (Windows, Mac, Web) — API availability varies
- ! Use `Office.context.requirements.isSetSupported("ExcelApi", "1.9")` before calling 1.9+ APIs
- ⊗ Assume all APIs are available on all platforms — Excel for Web and Mac have smaller API surfaces than Windows

```typescript path=null start=null
function supportsDataValidation(): boolean {
  return Office.context.requirements.isSetSupported("ExcelApi", "1.8");
}

async function applyValidation(range: Excel.Range, context: Excel.RequestContext) {
  if (!supportsDataValidation()) {
    console.warn("Data validation not supported on this platform");
    return;
  }
  // ... apply validation ...
}
```

### Task Pane UI
- ! Task pane is a web page rendered in a side panel — standard HTML/CSS/JS
- ! Use the shared runtime model when the task pane and custom functions need to share state
- ~ Keep task pane UI simple — it is a narrow panel, not a full web app
- ! Use `Office.onReady()` to initialize — do not access Office APIs before this resolves
- ⊗ Block the task pane UI during long `Excel.run()` operations — show a loading indicator and keep the pane responsive

### Manifest
- ~ Prefer the unified JSON manifest (Teams-compatible, modern) over the XML manifest (legacy)
- ! Declare the minimum API requirement set your add-in actually needs — do not over-declare
- ! Declare all permissions your add-in requires (read/write document, network access)
- ! If the add-in works in shared/coauthoring scenarios: in XML manifests set `<SupportsSharedFolders>true</SupportsSharedFolders>`; in JSON manifests set `"authorization": { "permissions": { "supportsSharedFolders": true } }` in the extension definition

### Testing
See [testing.md](../coding/testing.md).

- ! Use Vitest (or Jest) for unit tests
- ! Use `office-addin-mock` to mock `Excel.RequestContext`, workbook, worksheets, and ranges
- ! Test business logic separately from Office.js API interactions — extract pure computation functions
- ! Test custom functions as pure functions (they should be side-effect-free)
- ! Test error paths: `ItemNotFound`, `InvalidReference`, network failures for external API calls
- ⊗ Test only the happy path — Office.js has many failure modes that must be covered
- Files: `*.spec.ts` or `*.test.ts`

### Coverage
- ! ≥ 85% coverage on business logic modules
- ! ≥ 70% coverage on Office.js integration modules (mocking limitations reduce achievable coverage)
- ! Count src/\*
- ! Exclude: entry points, generated code, manifest files, webpack/vite config

### Style
- ! Follow all rules from [typescript.md](./typescript.md) — ESLint, Prettier, strict mode, no `any`
- ! Use `async`/`await` exclusively — Office.js is promise-based, never use callbacks
- ~ Separate Office.js API code from business logic: `services/` (pure logic), `office/` (API interactions), `ui/` (task pane)

### Security
- ⊗ Hardcode API keys, tokens, or credentials in add-in source
- ! Use `Office.context.auth.getAccessToken()` for SSO when authenticating against Microsoft Graph or backend APIs
- ⊗ Store sensitive data in `Office.context.document.settings` — it persists in the workbook and is visible to anyone who opens it
- ! Validate all data received from external APIs before writing to the workbook
- ⊗ Use `eval()` or dynamically construct Office.js API calls from user input

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging for production (console in dev, backend logging service in production)
- ~ Sentry.io or equivalent for error tracking in deployed add-ins
- ~ Log `Excel.run()` durations and `context.sync()` counts for performance monitoring

## Commands

```bash
task officejs:dev       # Start dev server + sideload add-in
task officejs:build     # Production build
task officejs:test      # Run unit tests (Vitest + office-addin-mock)
task officejs:lint      # ESLint with Office.js rules
task officejs:typecheck # tsc --noEmit
task officejs:manifest  # Validate manifest against schema
task officejs:sideload  # Sideload add-in into Excel for testing
task check              # Pre-commit: lint + typecheck + test
```

## Patterns

### Standard Excel.run Pattern
```typescript path=null start=null
export async function updateRevenueSection(modelConfig: ModelConfig): Promise<void> {
  try {
    await Excel.run(async (context) => {
      // 1. Load — batch ALL reads in one sync: existence flags + range values
      // getItemOrNullObject chains are safe: null objects propagate through getRange()
      const revenueItem = loadNamedItem(context, "in_base_revenue");
      const growthItem = loadNamedItem(context, "as_revenue_growth_rate");
      const outputItem = loadNamedItem(context, "calc_projected_revenue");
      const revenueRange = revenueItem.getRange(); // safe before sync: null objects chain
      const growthRange = growthItem.getRange();
      revenueRange.load("values");
      growthRange.load("values");
      await context.sync(); // sync 1 — existence flags + range values

      // 2. Check existence after sync
      if (revenueItem.isNullObject || growthItem.isNullObject || outputItem.isNullObject) {
        throw new ModelConfigError(
          "Missing required named ranges: in_base_revenue, as_revenue_growth_rate, calc_projected_revenue"
        );
      }

      // 3. Compute — pure logic, no API calls
      const baseRevenue = revenueRange.values[0][0] as number;
      const growthRate = growthRange.values[0][0] as number;
      const projected = projectRevenue(baseRevenue, growthRate, modelConfig.projectionYears);

      // 4. Write — batch all writes
      const outputRange = outputItem.getRange();
      outputRange.values = projected.map((v) => [v]);
      outputRange.format.font.bold = false; // formula role: no bold
      outputRange.numberFormat = [["#,##0"]];
      await context.sync(); // sync 2 — all writes committed
    });
  } catch (error) {
    handleOfficeError(error, "updateRevenueSection");
  }
}
```

### Centralized Error Handler
```typescript path=null start=null
export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

export function handleOfficeError(error: unknown, source: string): never {
  if (error instanceof ModelConfigError) {
    showUserError(`Model configuration error in ${source}: ${error.message}`);
    throw error;
  }
  if (error instanceof OfficeExtension.Error) {
    const detail = `[${error.code}] ${error.message}`;
    console.error(`Office.js error in ${source}:`, detail, error.debugInfo);
    showUserError(`Excel error in ${source}: ${detail}`);
    throw error;
  }
  throw error;
}
```

### Platform-Safe API Access
```typescript path=null start=null
const API_REQUIREMENTS: Record<string, string> = {
  dataValidation: "ExcelApi 1.8",
  chartEvents: "ExcelApi 1.8",
  customFunctions: "CustomFunctionsRuntime 1.1",
  dynamicArrays: "ExcelApi 1.12",
};

export function requiresApi(feature: keyof typeof API_REQUIREMENTS): boolean {
  const [setName, version] = API_REQUIREMENTS[feature].split(" ");
  return Office.context.requirements.isSetSupported(setName, version);
}
```

### Mocked Test Setup
```typescript path=null start=null
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OfficeMockObject } from "office-addin-mock";

const mockData = {
  context: {
    workbook: {
      names: {
        getItemOrNullObject: vi.fn(),
      },
    },
  },
};

describe("updateRevenueSection", () => {
  let mockContext: OfficeMockObject;

  beforeEach(() => {
    mockContext = new OfficeMockObject(mockData);
    vi.clearAllMocks();
  });

  it("throws ModelConfigError when named range is missing", async () => {
    mockData.context.workbook.names.getItemOrNullObject.mockReturnValue({
      isNullObject: true,
      load: vi.fn(),
    });

    await expect(updateRevenueSection(testConfig)).rejects.toThrow(ModelConfigError);
  });
});
```

## Project Structure

```
src/
  office/          # Office.js API interaction layer
    excel-service.ts
    range-helpers.ts
    format-helpers.ts
  services/        # Pure business logic (no Office.js imports)
    revenue.ts
    projection.ts
    validation.ts
  functions/       # Custom functions (separate runtime)
    functions.ts
  ui/              # Task pane UI
    taskpane.html
    taskpane.ts
  config/          # Model config types and loaders
    model-config.ts
tests/
  services/        # Business logic tests (no mocking needed)
  office/          # Office.js integration tests (mocked context)
  functions/       # Custom function tests (pure function tests)
manifest.json      # Unified JSON manifest (or manifest.xml for legacy)
webpack.config.js  # Build config
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ⊗ **Sync in a loop**: `for (...) { range.load(); await context.sync(); }` — load all ranges, sync once
- ⊗ **Stored proxy objects**: Saving a `Range` from one `Excel.run` for use in another — proxy objects expire
- ⊗ **Full `load()`**: `range.load()` loads every property — specify only what you need
- ⊗ **Mixed runtimes**: Importing task pane modules into custom function files or vice versa
- ⊗ **Hardcoded addresses**: `sheet.getRange("B5:B16")` — use named ranges or config-driven resolution
- ⊗ **Platform assumptions**: Using ExcelApi 1.12 features without checking `isSetSupported`

## Compliance Checklist

- ! All Excel interactions inside `Excel.run()`
- ! Minimal `context.sync()` calls — batch reads and writes
- ! `load()` with specific properties before read
- ! Named ranges or table references — no hardcoded addresses
- ! Error handling for `OfficeExtension.Error` with specific codes
- ! Platform requirement checks for non-baseline APIs
- ! Business logic separated from Office.js API layer
- ! Custom functions isolated in separate runtime-safe modules
- ! Follow all [typescript.md](./typescript.md) rules for general TypeScript code
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Run `task check` before commit
