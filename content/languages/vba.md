# VBA Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../../main.md) | [PROJECT.md](../../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: VBA 7.1 (Excel 2010+), 64-bit compatible; Testing: Rubberduck VBA or hand-rolled assert module; Source control: exported .bas/.cls/.frm files

**Note**: VBA is NOT VB.NET. The [visual-basic.md](./visual-basic.md) module covers VB.NET (.NET 8+, xUnit, Roslyn analyzers, `Option Strict On`, async/await). VBA has no `Try...Catch`, no generics, no async, no dependency injection, no package manager. These standards are written for VBA's actual capabilities.

## Standards

### Documentation
- ! Module-level header comment block on every module: purpose, author, date, dependencies
- ! Procedure-level comments on all `Public` subs and functions: purpose, parameters, return value, errors raised
- ~ Inline comments explain **why**, not **what** — VBA is readable enough without narrating every line
- ⊗ Orphan comments that describe code that was later changed or removed

### Module Organization
- ! One responsibility per module — do not build "utility grab bag" modules
- ! Separate concerns: data access modules, business logic modules, formatting modules, UI modules (UserForms)
- ~ Modules < 300 lines ideal; ! modules < 500 lines maximum
- ! Prefix module names by responsibility: `mod_` (standard module), `cls_` (class module), `frm_` (UserForm)
- ~ Group related procedures within a module using comment-block section headers

### Option Statements
- ! `Option Explicit` at the top of every module — no exceptions
- ⊗ Rely on implicit variable declarations — this is the single most common source of VBA bugs
- ? `Option Compare Text` when case-insensitive string comparison is the module's default behavior
- ⊗ `Option Base 1` — always use 0-based arrays and be explicit about bounds

### Testing
- ! Every public procedure in a logic module MUST have a corresponding test
- ~ Use Rubberduck VBA for unit testing when available (provides `@TestModule`, `@TestMethod` annotations)
- ? When Rubberduck is unavailable, use a hand-rolled assert pattern (see §Patterns — Test Harness)
- ! Test modules live in a dedicated `tests/` export folder, prefixed `test_`
- ! Test procedures are named `Test_<ModuleName>_<Scenario>` (e.g., `Test_ModRevenue_GrowthRateZero`)

### Coverage
- ! ≥ 70% of public procedures in logic modules have corresponding tests
- ! Exclude: UserForm event handlers, `Auto_Open`/`Workbook_Open` entry points, formatting-only procedures
- ~ 70% is the floor, not the target — VBA's testing limitations justify a lower bar than other languages but not zero

### Style
- ! `PascalCase` for procedure names, module names, public variables, constants, enum members
- ! `camelCase` for local variables and parameters
- ! `m_camelCase` for module-level private variables
- ! `ALL_CAPS_SNAKE` for global constants: `Public Const MAX_RETRY_COUNT As Long = 3`
- ! Use `Long` not `Integer` — `Integer` is 16-bit and causes silent overflow on modern data sizes
- ! Use `String` not `Variant` when the type is known
- ⊗ Hungarian notation (`strName`, `intCount`, `rngData`) — it was standard in VBA culture but harms readability; use meaningful names instead
- ⊗ Single-letter variable names except `i`, `j`, `k` for loop counters
- ~ One blank line between procedures; two blank lines between section groups

### Naming Conventions
- ! Procedure names are verb-first: `CalculateRevenue`, `FormatOutputSection`, `LoadPortfolioData`
- ! Boolean variables/functions prefixed with `Is`, `Has`, `Can`: `IsValid`, `HasHeader`, `CanProceed`
- ! Constants describe the value's purpose, not its magnitude: `MAX_PROJECTION_YEARS` not `FIVE`
- ⊗ Abbreviations in names unless universally understood in the domain: `CalcNPV` is fine, `CalcRev` is not — use `CalculateRevenue`

### Type Safety
- ! Declare all variables with explicit types — `Dim x As Long`, never `Dim x`
- ! Use `Long` for all integer work (not `Integer`)
- ! Use `Double` for all floating-point work (not `Single`)
- ! Use early binding (`Dim dict As Scripting.Dictionary`) when the reference is always available
- ~ Use late binding (`Dim dict As Object: Set dict = CreateObject(...)`) only for optional dependencies or cross-version compatibility
- ⊗ `Variant` for variables whose type is known at design time
- ⊗ Implicit `Variant` from undeclared variables (enforced by `Option Explicit`)
- ~ Use `Enum` types for related constants: `Public Enum CellRole: crInput = 1: crAssumption = 2: ...`

### Error Handling
- ! Every `Public Sub` and `Public Function` MUST have an error handler
- ! Use the `On Error GoTo ErrHandler` pattern with a labeled handler block at the end
- ! Error handlers MUST either: (a) raise a meaningful error to the caller, (b) log and recover, or (c) clean up and re-raise
- ⊗ `On Error Resume Next` as a blanket — it silently swallows every error
- ? `On Error Resume Next` for exactly one statement when checking existence (e.g., testing if a named range exists), followed immediately by `On Error GoTo 0` or `On Error GoTo ErrHandler`
- ! Always restore error handling after a `Resume Next` block: `On Error GoTo ErrHandler`
- ! Clean up resources (close files, restore `Application` state) in the handler or a cleanup label before exiting
- ⊗ `End` statement — it terminates all execution without cleanup. Use `Exit Sub`/`Exit Function`
- ~ Raise custom errors with `Err.Raise vbObjectError + N, Source, Description` for domain-specific failures

### Application State Management
- ! Wrap bulk operations in `Application.ScreenUpdating = False` / `True`
- ! Wrap calculation-intensive operations in `Application.Calculation = xlCalculationManual` / `xlCalculationAutomatic`
- ! Wrap event-triggering operations in `Application.EnableEvents = False` / `True`
- ! Restore all `Application` state in error handlers — a crash with `ScreenUpdating = False` leaves Excel frozen
- ~ Use a guard pattern (see §Patterns — Application State Guard) to guarantee restore on all exit paths

### Range Operations
- ! Use named ranges or table references (`ListObject`) — never hardcoded cell addresses in production code
- ⊗ Cell-by-cell read/write loops — read into a `Variant` array, process, write back as a block
- ! Use `Range.Value2` not `Range.Value` for numeric reads — `Value` applies date/currency coercion
- ~ Use `Intersect()` to check range overlap before operations
- ~ Use `Range.Resize()` and `Range.Offset()` for relative navigation instead of address arithmetic

### Workbook / Worksheet References
- ! Always qualify worksheet references: `ThisWorkbook.Sheets("Data")`, never bare `Sheets("Data")`
- ! Use `ThisWorkbook` not `ActiveWorkbook` unless explicitly operating on a different workbook
- ⊗ `ActiveSheet`, `ActiveCell`, `Selection` in logic modules — these are UI-context-dependent and break when called programmatically
- ? `ActiveSheet` / `Selection` in UI-facing entry points only (ribbon callbacks, button handlers)

### Security
- ⊗ Hardcode credentials, API keys, or connection strings in source modules
- ! Store secrets in environment variables, Windows Credential Manager, or a protected `secrets/` config file excluded from VCS
- ! Parameterize all SQL — never concatenate user input into query strings
- ⊗ `Shell()` or `CreateObject("WScript.Shell")` with unsanitized input

## Source Control

VBA code lives inside `.xlsm` / `.xlam` binary containers. To participate in git workflows, modules must be exported to the filesystem.

- ! Export all VBA modules to `src/` as `.bas` (standard modules), `.cls` (class modules), `.frm` (UserForms) after every meaningful change
- ! Export test modules to `tests/` with the same convention
- ! The `.xlsm` / `.xlam` file is checked in alongside exports as the "built" artifact
- ! Taskfile targets: `task vba:export` (workbook → files), `task vba:import` (files → workbook)
- ~ Use a `_vba_manifest.json` listing all modules, their types, and export paths for round-trip integrity
- ⊗ Edit `.bas` files by hand and import without verifying — always round-trip through the workbook to catch compile errors
- ~ Pre-commit hook runs `task vba:export` to ensure exports are current

## Commands

```bash
task vba:export        # Export VBA modules from .xlsm to src/ and tests/
task vba:import        # Import .bas/.cls/.frm files into .xlsm
task vba:test          # Run test suite (Rubberduck or custom harness)
task vba:compile-check # Open workbook and check for compile errors
task check             # Pre-commit: export + compile-check + test
```

## Patterns

### Error Handler
```vb
Public Sub ProcessData(ByVal ws As Worksheet)
    On Error GoTo ErrHandler

    Dim appState As cls_ApplicationState
    Set appState = GuardApplicationState()   ' see Application State Guard

    Dim data As Variant
    data = ws.Range("DataTable").Value2

    ' ... business logic ...

    appState.Restore
    Exit Sub
ErrHandler:
    If Not appState Is Nothing Then appState.Restore
    Err.Raise Err.Number, "mod_DataProcessor.ProcessData", _
        "Failed to process data on " & ws.Name & ": " & Err.Description
End Sub
```

### Application State Guard
```vb
' cls_ApplicationState — guarantees restore on all exit paths
Private m_screenUpdating As Boolean
Private m_calculation As XlCalculation
Private m_enableEvents As Boolean

Public Sub Capture()
    m_screenUpdating = Application.ScreenUpdating
    m_calculation = Application.Calculation
    m_enableEvents = Application.EnableEvents
    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual
    Application.EnableEvents = False
End Sub

Public Sub Restore()
    Application.ScreenUpdating = m_screenUpdating
    Application.Calculation = m_calculation
    Application.EnableEvents = m_enableEvents
End Sub
```

```vb
' mod_AppGuard — factory: creates a cls_ApplicationState, captures state, and returns it
' Call at the top of any bulk operation; call guard.Restore in the error handler
Public Function GuardApplicationState() As cls_ApplicationState
    Dim guard As New cls_ApplicationState
    guard.Capture
    Set GuardApplicationState = guard
End Function
```

### Array-Based Range Operations
```vb
' ! Read/write ranges as arrays — never cell-by-cell
Public Function SumColumn(ByVal rng As Range) As Double
    Dim data As Variant
    data = rng.Value2

    ' Wrap scalar (single-cell range) into a 2-D array so the loop is uniform
    If Not IsArray(data) Then
        Dim tmp(1 To 1, 1 To 1) As Variant
        tmp(1, 1) = data
        data = tmp
    End If

    Dim total As Double
    Dim i As Long
    For i = LBound(data, 1) To UBound(data, 1)
        If IsNumeric(data(i, 1)) Then total = total + data(i, 1)
    Next i

    SumColumn = total
End Function
```

### Test Harness (No Rubberduck)
```vb
' mod_TestRunner — minimal assert pattern when Rubberduck is unavailable
Private m_passed As Long
Private m_failed As Long

Public Sub RunAllTests()
    m_passed = 0: m_failed = 0
    Test_ModRevenue_GrowthRateZero
    Test_ModRevenue_NegativeGrowth
    ' ... add test calls here ...
    Debug.Print "Results: " & m_passed & " passed, " & m_failed & " failed"
End Sub

Private Sub AssertEqual(ByVal actual As Variant, ByVal expected As Variant, ByVal label As String)
    If actual = expected Then
        m_passed = m_passed + 1
    Else
        m_failed = m_failed + 1
        Debug.Print "FAIL: " & label & " — expected " & expected & ", got " & actual
    End If
End Sub

Private Sub Test_ModRevenue_GrowthRateZero()
    Dim result As Double
    result = CalculateRevenue(1000000, 0, 5)
    AssertEqual result, 1000000, "Revenue with zero growth should equal base"
End Sub
```

### Named Range Lookup
```vb
' ! Always check existence before referencing a named range
Public Function NamedRangeExists(ByVal wb As Workbook, ByVal rangeName As String) As Boolean
    On Error GoTo ErrHandler
    Dim rng As Range
    On Error Resume Next               ' scoped: existence check only
    Set rng = wb.Names(rangeName).RefersToRange
    On Error GoTo ErrHandler           ' restore labeled handler
    NamedRangeExists = Not rng Is Nothing
    Exit Function
ErrHandler:
    NamedRangeExists = False
End Function
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ⊗ **God modules**: 800-line `Module1` with every procedure — split by responsibility
- ⊗ **Bare `Sheets("Name")`**: Always qualify with `ThisWorkbook`
- ⊗ **`Select` / `Activate` in logic**: `ws.Range("A1").Select` then `Selection.Value = x` — just write `ws.Range("A1").Value2 = x`
- ⊗ **Cell-by-cell loops**: Read range into array, process, write back
- ⊗ **`GoTo` for flow control**: Use `If`/`Select Case`/`Do While` — `GoTo` is only for error handlers
- ⊗ **`Integer` for counts**: Use `Long` — `Integer` overflows at 32,767
- ⊗ **Unqualified `ActiveSheet`** in library code: Pass worksheet as a parameter

## Compliance Checklist

- ! `Option Explicit` in every module
- ! Error handler in every public procedure
- ! `Application` state restored on all exit paths
- ! Named ranges or table references — no hardcoded addresses
- ! Array-based range I/O — no cell-by-cell loops
- ! All variables explicitly typed — no bare `Dim x`
- ! Modules exported to `src/` and `tests/` for git
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Run `task check` before commit
