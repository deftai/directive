# C# Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: C# 12+/.NET 8+ (LTS), SDK-style projects; Web: ASP.NET Core/Minimal APIs; Testing: xUnit + NSubstitute + FluentAssertions; Analysis: Roslyn Analyzers, StyleCop.Analyzers

## Standards

### Documentation
- ! XML documentation comments (`///`) on all public types, methods, properties, and constants
- ! Document `<param>`, `<returns>`, `<exception>`, `<summary>` for public/protected members
- ~ Use `<see cref=""/>` and `<inheritdoc/>` to reduce duplication
- ~ Use `<remarks>` for complex behaviors or threading considerations

### Testing
See [testing.md](../coding/testing.md).

- ! Use xUnit (`[Fact]`, `[Theory]`, `[InlineData]`)
- ! Use NSubstitute or Moq for mocking; FluentAssertions for readable assertions
- ≉ Use MSTest or NUnit for new code (maintain existing suites only)
- Files: `*Tests.cs` in a parallel `*.Tests` project

### Coverage
- ! ≥85% coverage
- ! Count src/\*
- ! Exclude entry points, generated code, migrations, program bootstrapping

### Style
- ! Use `.editorconfig` for code style (project root, checked in)
- ! Enable Roslyn analyzers and StyleCop.Analyzers as project dependencies
- ! Follow [Microsoft C# Coding Conventions](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/coding-conventions)
- ! SDK-style `.csproj` with `<Nullable>enable</Nullable>` and `<ImplicitUsings>enable</ImplicitUsings>`
- ! `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` in CI builds

### Naming Conventions
- ! `PascalCase` for types, methods, properties, events, namespaces, public fields
- ! `camelCase` for parameters, local variables
- ! `_camelCase` for private fields: `private readonly ILogger _logger;`
- ! `IPascalCase` for interfaces: `IRepository`, `ILogger`
- ! `UPPER_SNAKE_CASE` only for interop constants; otherwise `PascalCase` for const
- ! Async methods suffixed with `Async`: `GetUserAsync()`, `SaveAsync()`
- ⊗ Hungarian notation or type prefixes (`strName`, `intCount`)

### Modern Language Features (C# 12+)
- ! Use records for immutable data carriers: `record UserDto(long Id, string Name);`
- ! Use `required` properties for mandatory init-only data
- ! Use primary constructors for simple DI and parameter capture
- ! Use `init` accessors for immutable-after-construction properties
- ! Use pattern matching (`is`, `switch` expressions, list patterns)
- ! Use raw string literals (`"""`) for multi-line strings
- ~ Use `file`-scoped types for implementation-only helpers
- ~ Use collection expressions (`[1, 2, 3]`) where supported (C# 12+)
- ≉ Use verbose constructors + field assignments when primary constructors suffice

### Nullable Reference Types
- ! Enable `<Nullable>enable</Nullable>` in all projects
- ! Annotate API boundaries with `?` for nullable; treat non-nullable as contract
- ! Handle `null` at system boundaries (deserialization, DB, external APIs)
- ⊗ Use `null!` (null-forgiving operator) except as last resort with documented reason
- ⊗ Return `null` from methods typed as non-nullable

### Resource Management
- ! Use `using` declarations or `using` blocks for all `IDisposable` resources
- ! Implement `IAsyncDisposable` for types holding async resources
- ! Use `await using` for async disposal
- ⊗ Call `.Dispose()` manually in a `finally` block (use `using` instead)
- ⊗ Implement finalizers unless wrapping unmanaged resources directly

### Error Handling
- ! Throw specific exception types: `ArgumentNullException`, `InvalidOperationException`, etc.
- ! Use `ArgumentNullException.ThrowIfNull()` (C# 10+) for guard clauses
- ! Include context in exception messages (what failed, relevant IDs)
- ⊗ Catch `Exception` or `SystemException` broadly — catch the most specific type
- ⊗ Swallow exceptions (empty catch blocks)
- ⊗ Use exceptions for flow control
- ~ Use Result/OneOf patterns for expected failures in domain logic
- ~ Log at the handling boundary, not at every catch-and-rethrow

### Async/Await
- ! Use `async`/`await` for all I/O-bound operations
- ! Return `Task`/`ValueTask` — never `async void` (except event handlers)
- ! Use `CancellationToken` in all async public APIs
- ! Pass `CancellationToken` through the entire call chain
- ⊗ Use `.Result` or `.Wait()` on tasks (deadlock risk)
- ⊗ Use `Task.Run()` to wrap sync-over-async (hides problems)
- ~ Use `ValueTask` for hot-path methods that often complete synchronously
- ~ Use `ConfigureAwait(false)` in library code (not in app/UI code)

### Dependency Injection
- ! Use constructor injection; ⊗ service locator pattern (`IServiceProvider.GetService`)
- ! Register services with appropriate lifetimes: `Singleton`, `Scoped`, `Transient`
- ! Inject interfaces, not implementations
- ⊗ Inject `IServiceProvider` into business logic classes
- ~ Use `IOptions<T>` / `IOptionsSnapshot<T>` for configuration binding
- ≉ Use `static` helper classes for behavior that should be injected

### Collections & LINQ
- ! Prefer immutable collections for shared/public data: `IReadOnlyList<T>`, `IReadOnlyDictionary<K,V>`
- ! Use LINQ for declarative transforms; ⊗ for side-effectful iterations
- ~ Materialize queries early to avoid multiple enumeration (`.ToList()`, `.ToArray()`)
- ~ Use `Span<T>` / `ReadOnlySpan<T>` for performance-critical slicing
- ⊗ Return `IEnumerable<T>` backed by a deferred query from public APIs without documentation

### Database (EF Core)
- ! Use parameterized queries (EF Core does this automatically)
- ! Use `AsNoTracking()` for read-only queries
- ! Use explicit transactions for multi-step writes
- ~ Use repository pattern or query objects; ≉ scatter `DbContext` calls across controllers
- ~ Use migrations for schema evolution
- ⊗ Use raw SQL with string interpolation (SQL injection risk — use `FromSqlInterpolated`)

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging (Serilog or Microsoft.Extensions.Logging) for production
- ~ Sentry.io for error tracking
- ~ Prometheus/Grafana or Application Insights for metrics
- ? OpenTelemetry .NET for distributed tracing

### Safety
- ⊗ Hardcode secrets, keys, or credentials in source
- ! Use User Secrets (dev), environment variables, or Azure Key Vault (prod)
- ! Validate all external input (model binding validation, FluentValidation)
- ~ Scan dependencies with `dotnet list package --vulnerable` or Snyk/OWASP

## Commands

See [commands.md](./commands.md).

## Patterns

### Testing (xUnit + FluentAssertions + NSubstitute)
```csharp
public class CalculatorTests {
    private readonly Calculator _sut = new();

    [Fact] public void Add_ReturnsSum() => _sut.Add(2, 3).Should().Be(5);

    [Theory] [InlineData(0,1,1)] [InlineData(-1,1,0)]
    public void Add_Parameterized(int a, int b, int expected) =>
        _sut.Add(a, b).Should().Be(expected);

    [Fact] public void Divide_ByZero_Throws() =>
        ((Action)(() => _sut.Divide(10, 0))).Should().Throw<DivideByZeroException>();
}

public class UserServiceTests {
    private readonly IUserRepository _repo = Substitute.For<IUserRepository>();
    private readonly UserService _sut;
    public UserServiceTests() => _sut = new UserService(_repo);

    [Fact] public async Task GetByIdAsync_ExistingUser_ReturnsUser() {
        var expected = new User(1, "Alice");
        _repo.GetByIdAsync(1).Returns(expected);
        (await _sut.GetByIdAsync(1)).Should().Be(expected);
        await _repo.Received(1).GetByIdAsync(1);
    }
}
```

### Records, Primary Constructors & Pattern Matching
```csharp
public record UserDto(long Id, string Name, string Email);

public class CreateOrderRequest {
    public required string ProductId { get; init; }
    public required int Quantity { get; init; }
    public string? Notes { get; init; }
}

public abstract record Result<T>;
public record Success<T>(T Value) : Result<T>;
public record Failure<T>(string Error, Exception? Cause = null) : Result<T>;

string Describe<T>(Result<T> r) => r switch {
    Success<T> s => $"OK: {s.Value}", Failure<T> f => $"Error: {f.Error}", _ => "Unknown"
};

// Primary constructor DI (C# 12)
public class UserService(IUserRepository repo, ILogger<UserService> logger) {
    public async Task<User?> GetByIdAsync(long id, CancellationToken ct = default) =>
        await repo.GetByIdAsync(id, ct);
}
```

### Async/Await & Resources
```csharp
// CancellationToken through entire chain
public async Task<IReadOnlyList<Order>> GetOrdersAsync(long userId, CancellationToken ct = default) {
    await using var conn = await _dataSource.OpenConnectionAsync(ct);
    return await conn.QueryAsync<Order>("SELECT * FROM orders WHERE user_id = @Id",
        new { Id = userId }).ToListAsync(ct);
}

// using declarations for IDisposable/IAsyncDisposable
await using var stream = File.OpenRead(path);
using var reader = new StreamReader(stream);
var content = await reader.ReadToEndAsync();

// Minimal API
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/users/{id}", async (long id, IUserService svc, CancellationToken ct) =>
    await svc.GetByIdAsync(id, ct) is { } user ? Results.Ok(user) : Results.NotFound());
app.Run();
```

## Build Configuration

**`.csproj` key settings**:
- ! `<TargetFramework>net8.0</TargetFramework>`
- ! `<Nullable>enable</Nullable>`, `<ImplicitUsings>enable</ImplicitUsings>`
- ! `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`
- ! `<AnalysisLevel>latest-recommended</AnalysisLevel>`
- ! `StyleCop.Analyzers` as `PrivateAssets="all"` PackageReference

**Test project deps**: `Microsoft.NET.Test.Sdk`, `xunit`, `xunit.runner.visualstudio`, `NSubstitute`, `FluentAssertions`, `coverlet.collector`

**`.editorconfig` key rules**: `indent_size = 4`, `file_scoped` namespaces, `simple_using_statement`, `require_accessibility_modifiers = always`, `_camelCase` private fields

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **Verbose constructors**: Use primary constructors (C# 12) or records
- ≉ **Manual null guards**: Use `ArgumentNullException.ThrowIfNull()`
- ≉ **`IEnumerable<T>` as public return**: Materialize or use `IReadOnlyList<T>`
- ≉ **God classes**: Keep <500 lines; extract services/handlers
- ≉ **`static` utility classes**: Inject via DI for testability

## Compliance Checklist

- ! XML doc comments on all public APIs
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Use xUnit + FluentAssertions + NSubstitute
- ! Nullable reference types enabled; `TreatWarningsAsErrors` in CI
- ! Records for data carriers; primary constructors for simple DI
- ! `async`/`await` with `CancellationToken` for all I/O
- ! `using` declarations for all `IDisposable`/`IAsyncDisposable`
- ⊗ `async void`, `.Result`/`.Wait()`, service locator, null-forgiving `null!`
- ! Run `task check` before commit
