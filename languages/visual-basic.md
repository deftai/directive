# Visual Basic Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: VB.NET (.NET 8+), SDK-style projects; Testing: xUnit/MSTest; Analysis: Roslyn Analyzers

**Note**: VB.NET is in maintenance mode — Microsoft no longer adds new language features (C# is preferred for new .NET projects). These standards apply to maintaining and modernizing existing VB.NET codebases.

## Standards

### Documentation
- ! XML documentation comments (`'''`) on all public types, methods, and properties
- ! Document `<param>`, `<returns>`, `<exception>` for public/protected members
- ~ Use `<inheritdoc/>` to reduce duplication in overrides

### Testing
See [testing.md](../coding/testing.md).

- ! Use xUnit or MSTest for unit tests
- Files: `*Tests.vb` in a parallel `*.Tests` project

### Coverage
- ! ≥85% coverage
- ! Count src/\*
- ! Exclude entry points, generated code, designer files

### Style
- ! Use `.editorconfig` for code style (project root, checked in)
- ! Enable Roslyn analyzers as project dependencies
- ! Follow [Microsoft VB Coding Conventions](https://learn.microsoft.com/en-us/dotnet/visual-basic/programming-guide/program-structure/coding-conventions)
- ! `Option Strict On` in all files / project-wide
- ! `Option Explicit On` in all files
- ! `Option Infer On` for type inference where clear

### Naming Conventions
- ! `PascalCase` for types, methods, properties, events, namespaces, public fields
- ! `camelCase` for parameters, local variables
- ! `_camelCase` for private fields: `Private ReadOnly _logger As ILogger`
- ! `IPascalCase` for interfaces: `IRepository`, `ILogger`
- ! Async methods suffixed with `Async`: `GetUserAsync()`
- ⊗ Hungarian notation (`strName`, `intCount`, `btnSubmit`)

### Type Safety
- ! `Option Strict On` — no implicit narrowing conversions
- ! Use strongly typed generics (`List(Of T)`, `Dictionary(Of K, V)`)
- ⊗ Late binding / `Object` for known types
- ⊗ Use `Variant` (VB6 holdover — does not exist in VB.NET, but avoid `Object` as substitute)
- ~ Use `TryCast` / `TryParse` over `CType` / `DirectCast` for external data
- ~ Use `String.IsNullOrWhiteSpace()` over null/empty checks

### Error Handling
- ! Use `Try...Catch...Finally` with specific exception types
- ! Use `Using` blocks for all `IDisposable` resources
- ⊗ Use `On Error Resume Next` (VB6 holdover — disabled by `Option Strict On`)
- ⊗ Use `On Error GoTo` — use structured exception handling
- ⊗ Swallow exceptions (empty `Catch` blocks)
- ~ Throw specific exceptions: `ArgumentNullException`, `InvalidOperationException`

### Async/Await
- ! Use `Async`/`Await` for all I/O-bound operations
- ! Return `Task`/`Task(Of T)` — never `Async Sub` (except event handlers)
- ⊗ Use `.Result` or `.Wait()` (deadlock risk)
- ~ Pass `CancellationToken` through async chains

### Resource Management
- ! Use `Using` blocks for all `IDisposable` resources
- ⊗ Manual `.Dispose()` in `Finally` (use `Using` instead)
- ~ Implement `IDisposable` with the standard pattern for types owning resources

### Modernization
- ! Use SDK-style `.vbproj` with `<Nullable>enable</Nullable>` where supported
- ~ Migrate from .NET Framework to .NET 8+ where feasible
- ~ Extract business logic from forms/code-behind into testable service classes
- ≉ Add new features in VB.NET — evaluate C# for new modules/services
- ≉ Maintain separate WinForms business logic and UI in the same file

### Security
- ⊗ Hardcode secrets, keys, or credentials in source
- ! Use parameterized queries for all database access; ⊗ string concatenation for SQL
- ! Validate all external input

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging (Serilog or Microsoft.Extensions.Logging)
- ~ Sentry.io for error tracking

## Commands

See [commands.md](./commands.md).

## Patterns

### Structured Error Handling
```vb
' ! Always use Try...Catch...Finally; never On Error
Public Async Function GetUserAsync(id As Long, ct As CancellationToken) As Task(Of User)
    Try
        Using conn = Await _dataSource.OpenConnectionAsync(ct)
            Dim user = Await conn.QuerySingleOrDefaultAsync(Of User)(
                "SELECT * FROM users WHERE id = @Id", New With {.Id = id})
            If user Is Nothing Then Throw New NotFoundException("User", id)
            Return user
        End Using
    Catch ex As OperationCanceledException
        _logger.LogWarning("Request cancelled for user {UserId}", id)
        Throw
    End Try
End Function
```

### Using Blocks
```vb
' ! Always use Using for IDisposable
Using reader As New StreamReader(path)
    Dim content = Await reader.ReadToEndAsync()
    Return ProcessContent(content)
End Using
```

### Strong Typing
```vb
' ! Option Strict On — use generics, not Object
Dim customers As New List(Of Customer)()
Dim lookup As New Dictionary(Of String, Customer)()

For Each c In customers
    lookup(c.Email) = c
Next
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **`My` namespace for non-trivial tasks**: Use .NET BCL directly
- ≉ **Module-level mutable state**: Use parameters or DI
- ≉ **VB6 functions** (`Len`, `Mid`, `Left`): Use `String` methods
- ≉ **New VB.NET projects**: Evaluate C# for new services

## Compliance Checklist

- ! XML doc comments on all public APIs
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! `Option Strict On` + `Option Explicit On` in all files
- ! `Using` blocks for all `IDisposable` resources
- ! `Try...Catch` with specific exceptions; ⊗ `On Error`
- ! Parameterized queries for all database access
- ⊗ Late binding, `On Error Resume Next`, VB6 holdover patterns
- ! Run `task check` before commit
