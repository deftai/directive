# Visual Basic Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, â‰‰=SHOULD NOT, âŠ—=MUST NOT, ?=MAY.

**âš ï¸ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: VB.NET (.NET 8+), SDK-style projects; Testing: xUnit/MSTest; Analysis: Roslyn Analyzers

**Note**: VB.NET is in maintenance mode â€” Microsoft no longer adds new language features (C# is preferred for new .NET projects). These standards apply to maintaining and modernizing existing VB.NET codebases.

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
- ! â‰¥85% coverage
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
- âŠ— Hungarian notation (`strName`, `intCount`, `btnSubmit`)

### Type Safety
- ! `Option Strict On` â€” no implicit narrowing conversions
- ! Use strongly typed generics (`List(Of T)`, `Dictionary(Of K, V)`)
- âŠ— Late binding / `Object` for known types
- âŠ— Use `Variant` (VB6 holdover â€” does not exist in VB.NET, but avoid `Object` as substitute)
- ~ Use `TryCast` / `TryParse` over `CType` / `DirectCast` for external data
- ~ Use `String.IsNullOrWhiteSpace()` over null/empty checks

### Error Handling
- ! Use `Try...Catch...Finally` with specific exception types
- ! Use `Using` blocks for all `IDisposable` resources
- âŠ— Use `On Error Resume Next` (VB6 holdover â€” disabled by `Option Strict On`)
- âŠ— Use `On Error GoTo` â€” use structured exception handling
- âŠ— Swallow exceptions (empty `Catch` blocks)
- ~ Throw specific exceptions: `ArgumentNullException`, `InvalidOperationException`

### Async/Await
- ! Use `Async`/`Await` for all I/O-bound operations
- ! Return `Task`/`Task(Of T)` â€” never `Async Sub` (except event handlers)
- âŠ— Use `.Result` or `.Wait()` (deadlock risk)
- ~ Pass `CancellationToken` through async chains

### Resource Management
- ! Use `Using` blocks for all `IDisposable` resources
- âŠ— Manual `.Dispose()` in `Finally` (use `Using` instead)
- ~ Implement `IDisposable` with the standard pattern for types owning resources

### Modernization
- ! Use SDK-style `.vbproj` with `<Nullable>enable</Nullable>` where supported
- ~ Migrate from .NET Framework to .NET 8+ where feasible
- ~ Extract business logic from forms/code-behind into testable service classes
- â‰‰ Add new features in VB.NET â€” evaluate C# for new modules/services
- â‰‰ Maintain separate WinForms business logic and UI in the same file

### Security
- âŠ— Hardcode secrets, keys, or credentials in source
- ! Use parameterized queries for all database access; âŠ— string concatenation for SQL
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
' ! Option Strict On â€” use generics, not Object
Dim customers As New List(Of Customer)()
Dim lookup As New Dictionary(Of String, Customer)()

For Each c In customers
    lookup(c.Email) = c
Next
```

## Anti-Patterns

Items marked âŠ— in Standards above are not repeated here.

- â‰‰ **`My` namespace for non-trivial tasks**: Use .NET BCL directly
- â‰‰ **Module-level mutable state**: Use parameters or DI
- â‰‰ **VB6 functions** (`Len`, `Mid`, `Left`): Use `String` methods
- â‰‰ **New VB.NET projects**: Evaluate C# for new services

## Compliance Checklist

- ! XML doc comments on all public APIs
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! `Option Strict On` + `Option Explicit On` in all files
- ! `Using` blocks for all `IDisposable` resources
- ! `Try...Catch` with specific exceptions; âŠ— `On Error`
- ! Parameterized queries for all database access
- âŠ— Late binding, `On Error Resume Next`, VB6 holdover patterns
- ! Run `task check` before commit
