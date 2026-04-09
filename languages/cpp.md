# C++ Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: C++20/23, CMake 3.25+, Catch2/GoogleTest, GSL (Guidelines Support Library); CLI: CLI11; TUI: FTXUI; Async: Asio/libcoro

## Standards

### Documentation
- ! Doxygen comments for all public APIs (classes, functions, namespaces)

### Testing
See [testing.md](../coding/testing.md).

- ! Use Catch2 or GoogleTest (+ GoogleMock for mocking)
- Files: `test_*.cpp` or `*_test.cpp`

### Coverage
- ! ≥85% coverage
- ! Count src/\*
- ! Exclude main, examples, generated code

### Style
- ! Use clang-format (Google/LLVM/Mozilla style)
- ! Use clang-tidy for linting

### Types
- ~ Use strong typing (enums, type aliases)
- ~ Prefer `std::optional`/`std::variant`/`std::expected` for expected errors

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging (spdlog) for production
- ~ Sentry.io for error tracking
- ? OpenTelemetry C++ for distributed tracing

### Safety
- ! Avoid buffer overflows
- ~ Use GSL (`gsl::span`, `gsl::not_null`, `gsl::owner`)
- ⊗ Use raw arrays or naked pointers for ownership

### Interfaces
- ! Design clear, minimal interfaces
- ~ Use abstract base classes or concepts for polymorphism

## Commands

See [commands.md](./commands.md).

## Patterns

### Testing
- **Catch2**: `TEST_CASE("desc", "[tag]") { SECTION("case") { REQUIRE(result == expected); } }`
- **GoogleTest**: `TEST(Suite, Name) { EXPECT_EQ(actual, expected); ASSERT_TRUE(cond); }`
- **GoogleMock**: `MOCK_METHOD(RetType, MethodName, (Args...), (override));` + `EXPECT_CALL(...)`

### Core Patterns
- **RAII**: ! Use smart pointers (`std::unique_ptr`, `std::shared_ptr`); ⊗ raw `new`/`delete`
- **Error Handling**: ~ Use `std::expected<T,E>` for expected errors (file not found, parse failure); ~ exceptions with RAII for bugs/resource exhaustion
- **Containers**: ! Use `std::vector`, `std::array`, `std::span`; ⊗ C arrays
- **String Views**: ~ Use `std::string_view` for read-only params
- **Bounds Safety**: ! Use `.at()` for checked access or range-based loops; ~ use `gsl::span` for array views
- **Const Correctness**: ! Mark methods `const` when they don't modify state; ~ use `const&` for input params
- **Namespaces**: ! Organize code in namespaces; ⊗ `using namespace` in headers
- **Modern Loops**: ~ Use `for (const auto& item : container)` instead of manual indexing
- **Initialization**: ~ Use brace-init `{}` over `()` to avoid narrowing/most-vexing-parse
- **Templates**: ~ Use concepts (C++20) to constrain template parameters
- **Rule of Zero/Five**: ~ Let compiler generate special members OR define all 5

## Build Configuration

**CMake essentials**:
- ! C++20/23, CMake 3.25+
- ! Warnings: `-Wall -Wextra -Wpedantic -Werror`
- ! Coverage: `--coverage` flag when `ENABLE_COVERAGE=ON`
- ! Dependencies: `find_package(Microsoft.GSL)`, `find_package(Catch2 3)` or `GTest`

**clang-format**: BasedOnStyle: Google/LLVM/Mozilla, ColumnLimit: 100, PointerAlignment: Left

**clang-tidy**: Enable clang-diagnostic, clang-analyzer, cppcoreguidelines, modernize, performance, readability; WarningsAsErrors: "*"

## GSL (Guidelines Support Library)

~ Use GSL for bounds and null safety:

- **gsl::span<T>**: Array view with bounds checking (instead of pointer+size)
- **gsl::not_null<T*>**: Non-nullable pointer guarantee (no null checks needed)
- **gsl::owner<T*>**: Ownership annotation (prefer smart pointers)

**Installation**: `find_package(Microsoft.GSL CONFIG REQUIRED)` in CMake

## Interface Design

~ Follow C++ Core Guidelines:

- **I.1**: Make interfaces explicit (clear preconditions/postconditions)
- **I.2**: Avoid non-const global variables (use const or pass as params)
- **I.4**: Use strong typing (`enum class Status`, `struct UserId`, not raw ints)
- **I.11**: Never transfer ownership by raw pointer (use `std::unique_ptr<T>`)
- **I.13**: Don't pass arrays as single pointers (use `gsl::span<T>`)

**Polymorphism**: ~ Abstract base classes OR concepts (C++20)
## Compliance Checklist

- ! Include Doxygen comments for all public APIs
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Use clang-format and clang-tidy
- ! Follow C++ Core Guidelines for interfaces, resource management, and safety
- ~ Use GSL types (`gsl::span`, `gsl::not_null`) for bounds/null safety
- ! Distinguish expected errors (`std::expected`) from exceptional errors (exceptions)
- ⊗ Use raw arrays, naked `new`/`delete`, or unchecked array access
- ! Run `task check` before commit
