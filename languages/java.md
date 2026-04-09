# Java Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: Java 21+ (LTS), Maven/Gradle; Web: Spring Boot 3+; Testing: JUnit 5 + Mockito + AssertJ; Analysis: Checkstyle, SpotBugs, Error Prone

## Standards

### Documentation
- ! Javadoc on all public classes, interfaces, methods, and constants
- ! Document `@param`, `@return`, `@throws` for public/protected methods
- ~ Use `@since` tags when adding public API to existing libraries
- ~ Use `{@code}` and `{@link}` for inline references

### Testing
See [testing.md](../coding/testing.md).

- ! Use JUnit 5 (`@Test`, `@ParameterizedTest`, `@Nested`)
- ! Use Mockito for mocking; AssertJ for fluent assertions
- ≉ Use JUnit 4 for new code (maintain existing suites only)
- Files: `*Test.java` or `*Tests.java` in `src/test/java`

### Coverage
- ! ≥85% coverage
- ! Count src/main/\*
- ! Exclude entry points, generated code, framework config

### Style
- ! Follow [Google Java Style Guide](https://google.github.io/styleguide/javaguide.html)
- ! Use Checkstyle (project `checkstyle.xml` required)
- ! Use SpotBugs or Error Prone for static analysis
- ! Column limit: 100 characters
- ! 2 or 4 space indentation (pick one, enforce via formatter)

### Naming Conventions
- ! `PascalCase` for classes, interfaces, enums, records, annotations
- ! `camelCase` for methods, fields, local variables, parameters
- ! `UPPER_SNAKE_CASE` for `static final` constants
- ! Package names all lowercase: `com.example.myapp.service`
- ! Test classes named `{ClassName}Test`: `UserServiceTest`
- ~ Interfaces without `I` prefix; use nouns/adjectives: `Repository`, `Serializable`
- ⊗ Hungarian notation or type prefixes

### Modern Language Features (Java 21+)
- ! Use `record` for immutable data carriers (DTOs, value objects)
- ! Use `sealed` classes/interfaces for restricted type hierarchies
- ! Use pattern matching in `switch` and `instanceof`
- ! Use text blocks (`"""`) for multi-line strings (SQL, JSON, etc.)
- ~ Use `var` for local variables when type is obvious from context
- ~ Use virtual threads (`Executors.newVirtualThreadPerTaskExecutor()`) for I/O-bound concurrency
- ≉ Use `var` when it obscures the type or reduces readability

### Types & Null Safety
- ! Use `Optional<T>` for return types that may be absent; ⊗ return `null` from public methods
- ! Use `@Nullable`/`@NonNull` annotations (JSpecify or JSR 305) on API boundaries
- ⊗ Use raw generic types (`List` instead of `List<String>`)
- ⊗ Use `Object` where a specific type or generic is appropriate
- ~ Prefer immutable collections (`List.of()`, `Map.of()`, `Set.of()`, `Collections.unmodifiable*`)
- ~ Use `enum` for fixed sets of constants; ⊗ string/int constants for enumerable values

### Records & Sealed Types
- ! Use `record` instead of manual POJO/DTO boilerplate
- ! Use `sealed` for closed hierarchies (event types, result types, AST nodes)
- ~ Use compact constructors in records for validation
- ⊗ Add mutable state to records (they are immutable by design)

### Resource Management
- ! Use try-with-resources for all `AutoCloseable` resources
- ⊗ Manually call `.close()` in a `finally` block (use try-with-resources instead)
- ! Close streams, connections, readers/writers on all code paths
- ~ Use `Cleaner` or `PhantomReference` for native resource cleanup (not `finalize()`)
- ⊗ Override `finalize()` — deprecated and removed in Java 18+

### Error Handling
- ! Use checked exceptions for recoverable errors; unchecked for programming bugs
- ! Catch the most specific exception type, not `Exception` or `Throwable`
- ! Include context in exception messages (what failed, relevant IDs/values)
- ⊗ Swallow exceptions (empty catch blocks)
- ⊗ Use exceptions for flow control
- ~ Create domain-specific exception hierarchies extending `RuntimeException`
- ~ Use `Optional` instead of throwing for "not found" scenarios in query methods
- ~ Log exceptions at the boundary where they are handled, not where they are caught and rethrown

### Collections & Streams
- ! Prefer `List.of()`, `Map.of()`, `Set.of()` for immutable collections
- ! Use Streams for transformation pipelines; ⊗ for simple iterations with side effects
- ~ Prefer `Stream.toList()` (Java 16+) over `Collectors.toList()` for unmodifiable results
- ≉ Modify collections during iteration; use `Iterator.remove()` or build a new collection
- ⊗ Use `Vector`, `Hashtable`, `Stack` — use `ArrayList`, `HashMap`, `ArrayDeque` instead

### Concurrency
- ! Use virtual threads (Java 21+) for I/O-bound workloads
- ! Use `ReentrantLock` over `synchronized` when using virtual threads (avoids carrier thread pinning)
- ! Use `ExecutorService` with try-with-resources; ⊗ create raw `Thread` instances
- ~ Use `CompletableFuture` for async composition when virtual threads are not appropriate
- ~ Use `ConcurrentHashMap`, `CopyOnWriteArrayList` for concurrent data structures
- ⊗ Use `Thread.stop()`, `Thread.suspend()`, `Thread.resume()` — all deprecated/removed
- ≉ Use `ThreadLocal` heavily with virtual threads (high memory overhead at scale)

### Dependency Injection
- ! Use constructor injection; ⊗ field injection (untestable, hides dependencies)
- ! Keep constructors focused — inject interfaces, not implementations
- ~ Use `@Qualifier` or custom annotations to disambiguate beans
- ≉ Use `@Autowired` on fields; prefer `final` fields with constructor injection

### Database
- ! Use parameterized queries / prepared statements; ⊗ string concatenation for SQL
- ! Use connection pooling (HikariCP)
- ~ Use Spring Data JPA or jOOQ; ≉ raw JDBC for application code
- ~ Wrap multi-step operations in explicit `@Transactional` boundaries
- ⊗ Use `Statement` with user-supplied input (SQL injection risk)

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging (SLF4J + Logback/Log4j2) for production
- ~ Sentry.io for error tracking
- ~ Micrometer for metrics
- ? OpenTelemetry Java for distributed tracing

### Safety
- ⊗ Hardcode secrets, keys, or credentials in source
- ! Validate all external input (user, file, network)
- ! Use `SecurityManager`-independent security practices (removed in Java 24)
- ~ Keep dependencies up to date; scan with OWASP Dependency-Check or Snyk

## Commands

See [commands.md](./commands.md).

## Patterns

### Testing (JUnit 5 + AssertJ + Mockito)
```java
class CalculatorTest {
    private Calculator sut;
    @BeforeEach void setUp() { sut = new Calculator(); }

    @Test void addPositiveNumbers() { assertThat(sut.add(2, 3)).isEqualTo(5); }

    @ParameterizedTest @CsvSource({"0,1,1", "-1,1,0", "100,200,300"})
    void addParameterized(int a, int b, int expected) {
        assertThat(sut.add(a, b)).isEqualTo(expected);
    }

    @Nested class WhenDividingByZero {
        @Test void throwsArithmeticException() {
            assertThatThrownBy(() -> sut.divide(10, 0))
                .isInstanceOf(ArithmeticException.class);
        }
    }
}

@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    @Mock UserRepository userRepository;
    @InjectMocks UserService userService;

    @Test void findById_existingUser_returnsUser() {
        var expected = new User(1L, "alice");
        when(userRepository.findById(1L)).thenReturn(Optional.of(expected));
        assertThat(userService.findById(1L)).isPresent().contains(expected);
        verify(userRepository).findById(1L);
    }
}
```

### Records, Sealed Types & Pattern Matching
```java
public record UserDto(long id, String name, String email) {
    public UserDto {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("name required");
    }
}

public sealed interface Result<T> permits Success, Failure {
    record Success<T>(T value) implements Result<T> {}
    record Failure<T>(String error, Exception cause) implements Result<T> {}
}

String describe(Result<?> r) { return switch (r) {
    case Result.Success<?> s -> "OK: " + s.value();
    case Result.Failure<?> f -> "Error: " + f.error();
}; }

// instanceof pattern matching
if (shape instanceof Circle c) return Math.PI * c.radius() * c.radius();

// switch pattern matching (Java 21+)
return switch (obj) {
    case Integer i when i < 0 -> "Negative: " + i;
    case Integer i -> "Integer: " + i;
    case String s -> "String: " + s.toUpperCase();
    case null -> "null";
    default -> "Unknown: " + obj;
};
```

### Virtual Threads & Resources
```java
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    var futures = urls.stream().map(url -> executor.submit(() -> fetchUrl(url))).toList();
    for (var f : futures) process(f.get());
}

// ReentrantLock (not synchronized) with virtual threads
private final ReentrantLock lock = new ReentrantLock();
void safeUpdate() { lock.lock(); try { /* critical */ } finally { lock.unlock(); } }

// try-with-resources
try (var conn = ds.getConnection();
     var stmt = conn.prepareStatement("SELECT * FROM users WHERE id = ?")) {
    stmt.setLong(1, userId);
    try (var rs = stmt.executeQuery()) { if (rs.next()) return Optional.of(mapUser(rs)); }
}
return Optional.empty();
```

## Build Configuration

**Key requirements** (Maven or Gradle):
- ! Java 21+ toolchain, UTF-8 encoding
- ! Test deps: `junit-jupiter`, `assertj-core`, `mockito-junit-jupiter`
- ! JaCoCo with `minimum = 0.85` line coverage
- ! SpotBugs plugin for static analysis

**Gradle** (`build.gradle.kts`):
```kotlin
plugins { java; jacoco; id("com.github.spotbugs") version "6.0.0" }
java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
dependencies {
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")
    testImplementation("org.assertj:assertj-core:3.26.0")
    testImplementation("org.mockito:mockito-junit-jupiter:5.14.0")
}
tasks.test { useJUnitPlatform() }
tasks.jacocoTestCoverageVerification {
    violationRules { rule { limit { minimum = "0.85".toBigDecimal() } } }
}
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **Checked exceptions for everything**: Reserve for truly recoverable conditions
- ≉ **God classes**: Keep <500 lines; extract service/strategy/helper
- ≉ **`Collectors.toList()`**: Prefer `Stream.toList()` (Java 16+)

## Compliance Checklist

- ! Javadoc on all public APIs
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Use JUnit 5 + AssertJ + Mockito
- ! Use records for data carriers; sealed types for closed hierarchies
- ! Use virtual threads for I/O-bound concurrency (Java 21+)
- ! Try-with-resources for all `AutoCloseable`; ⊗ manual `.close()`
- ⊗ Return `null` from public methods; raw types; field injection
- ⊗ `synchronized` with virtual threads
- ! Run `task check` before commit
