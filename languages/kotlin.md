# Kotlin Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md)

**Stack**: Kotlin 2.0+; Build: Gradle (Kotlin DSL); Testing: JUnit 5 + kotest; Lint: detekt; Format: ktfmt/ktlint; Docs: KDoc

## Standards

### Documentation
- ! KDoc (`/** */`) on all public classes, functions, properties, and interfaces
- ! Document `@param`, `@return`, `@throws`, `@sample` for public API
- ! Module-level `package-info.kt` or `README.md` per module
- ~ Use `@see` for cross-references; `@sample` for linking to example code

### Testing
See [testing.md](../coding/testing.md).

- ! Use JUnit 5 (`@Test`, assertions) or kotest (spec-style)
- ! Place tests in `src/test/kotlin/` mirroring source package structure
- ! Test edge cases: nulls, empty collections, boundary values
- ~ Use MockK for mocking; avoid PowerMock
- ~ Use kotest property-based testing for algorithmic code

### Coverage
- ! ≥80% coverage (measured via JaCoCo or Kover)
- ! Count src/main/kotlin/**
- ! Exclude entry points, generated code, DI configuration

### Style
- ! Follow [Kotlin Coding Conventions](https://kotlinlang.org/docs/coding-conventions.html)
- ! Use detekt for static analysis (project `detekt.yml` checked in)
- ! Use ktfmt or ktlint for formatting
- ! 4-space indentation, no tabs
- ! Line length ≤120 characters

### Naming Conventions
- ! `camelCase` for functions, properties, local variables, parameters
- ! `PascalCase` for classes, interfaces, objects, type aliases, enums
- ! `SCREAMING_SNAKE_CASE` for `const val` and compile-time constants
- ! `camelCase` for enum values (Kotlin convention) or `SCREAMING_SNAKE_CASE` if Java-interop heavy
- ! Prefix backing properties with `_`: `private val _items` → `val items`
- ⊗ Hungarian notation or type prefixes (`strName`, `iCount`)

### Null Safety
- ! Use Kotlin's type system: `T` for non-null, `T?` for nullable
- ! Prefer safe calls (`?.`) and Elvis (`?:`) over `!!`
- ⊗ `!!` (non-null assertion) in production code without precondition check
- ! Use `requireNotNull()` / `checkNotNull()` with descriptive messages
- ~ Use `let`/`also`/`run` scoping functions for null-safe chaining
- ≉ Platform types (`T!`) leaking into public API — annotate explicitly

### Idiomatic Kotlin
- ! Use data classes for value objects (immutable DTOs)
- ! Use sealed classes/interfaces for restricted hierarchies
- ! Use `when` expression (exhaustive) over `if-else` chains for type/enum dispatch
- ! Use extension functions to add behavior without inheritance
- ! Use `val` (immutable) by default; `var` only when mutation is required
- ! Use scope functions (`let`, `apply`, `with`, `run`, `also`) appropriately
- ⊗ Java-style getters/setters — use Kotlin properties
- ≉ `companion object` as a dumping ground — extract to top-level or utility

### Coroutines & Concurrency
- ! Use structured concurrency: `coroutineScope`, `supervisorScope`
- ! Never launch unstructured coroutines (`GlobalScope.launch`)
- ! Use `Dispatchers.IO` for I/O, `Dispatchers.Default` for CPU
- ! Use `Flow` for reactive streams; `StateFlow`/`SharedFlow` for state
- ⊗ `GlobalScope` — always use a structured scope
- ⊗ `runBlocking` in production code (except at top-level entry points)
- ~ Use `withContext` for dispatcher switching inside a coroutine
- ~ Cancel coroutines cooperatively; check `isActive` in long computations

### Error Handling
- ! Use exceptions for exceptional conditions; `Result` or sealed classes for expected failures
- ! Define custom exception hierarchies for domain errors
- ! Always catch specific exceptions, not `Exception` or `Throwable`
- ⊗ Catching `Throwable` (swallows `CancellationException`, `OutOfMemoryError`)
- ⊗ Empty catch blocks
- ~ Use `runCatching` for functional error handling where appropriate

### Dependencies
- ! Use Gradle Kotlin DSL (`build.gradle.kts`)
- ! Pin dependency versions via version catalogs (`libs.versions.toml`)
- ! Minimize transitive dependencies; use `implementation` not `api` by default
- ~ Use `dependencyUpdates` plugin for version management
- ⊗ `compile` (deprecated) — use `implementation` or `api`

### Interop (Java)
- ! Annotate public API with `@JvmStatic`, `@JvmOverloads`, `@JvmField` where Java callers exist
- ! Use `@Nullable` / `@NotNull` annotations on Java code consumed by Kotlin
- ~ Keep Java interop surface minimal in Kotlin-first projects

### Security
- ⊗ Hardcode secrets or credentials in source
- ! Validate all external inputs
- ~ Use sealed classes for security-sensitive state machines (auth, permissions)

### Telemetry
- ~ Use SLF4J + Logback (or kotlin-logging) for structured logging
- ~ Use Micrometer for metrics
- ? OpenTelemetry for distributed tracing

## Commands

See [commands.md](./commands.md).

## Patterns

### Data Class + Sealed Hierarchy
```kotlin
data class User(val id: Long, val email: String, val name: String, val role: Role)

sealed interface Result<out T> {
    data class Success<T>(val data: T) : Result<T>
    data class Failure(val error: DomainError) : Result<Nothing>
}

sealed class DomainError(val message: String) {
    class NotFound(msg: String) : DomainError(msg)
    class Validation(msg: String) : DomainError(msg)
}
```

### Coroutines & Testing
```kotlin
class UserService(private val userRepo: UserRepository, private val audit: AuditLogService) {
    suspend fun getUser(id: Long): User = coroutineScope {
        val user = async { userRepo.findById(id) }
        val log = async { audit.log("user:read", id) }
        log.await(); user.await() ?: throw UserNotFoundException(id)
    }
}

// MockK test
class UserServiceTest {
    private val userRepo = mockk<UserRepository>()
    private val audit = mockk<AuditLogService>(relaxed = true)
    private val sut = UserService(userRepo, audit)

    @Test fun `returns user when found`() = runTest {
        coEvery { userRepo.findById(1L) } returns User(1L, "a@b.com", "Vis", Role.ADMIN)
        assertEquals("Vis", sut.getUser(1L).name)
    }

    @Test fun `throws when not found`() = runTest {
        coEvery { userRepo.findById(99L) } returns null
        assertThrows<UserNotFoundException> { sut.getUser(99L) }
    }
}
```

### Extension Functions
```kotlin
fun String.toSlug() = lowercase().replace(Regex("[^a-z0-9\\s-]"), "").replace(Regex("\\s+"), "-").trim('-')
fun <T> List<T>.secondOrNull(): T? = if (size >= 2) this[1] else null
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **`var` by default**: Use `val`; mutate only when necessary
- ≉ **`companion object` as dumping ground**: Use top-level functions
- ≉ **`if-else` for sealed dispatch**: Use exhaustive `when`
- ≉ **String templates in logging**: Use parameterized logging

## Compliance Checklist

- ! KDoc on all public API
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! JUnit 5 or kotest; ≥80% coverage via Kover/JaCoCo
- ! detekt + ktfmt/ktlint configured and enforced
- ! Kotlin coding conventions; null safety via type system
- ! Structured concurrency; no `GlobalScope`
- ⊗ `!!`, `GlobalScope`, catching `Throwable`, empty catches, `var` by default
- ! Run `task check` before commit
