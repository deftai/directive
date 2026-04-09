# C Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: C17/C23, CMake 3.25+, clang/GCC; Testing: Unity/cmocka; Analysis: clang-tidy, cppcheck, AddressSanitizer

## Standards

### Documentation
- ! Doxygen comments for all public APIs (functions, types, macros)
- ! File header: purpose, author, date, license
- ! Document preconditions, postconditions, return values, and error conditions
- ~ Use `/** */` Doxygen style; `//` for inline comments

### Testing
See [testing.md](../coding/testing.md).

- ! Use Unity (embedded/general) or cmocka (mocking) for unit tests
- ? Use Check or CUnit as alternatives
- Files: `test_*.c` or `*_test.c`

### Coverage
- ! ≥85% coverage
- ! Count src/\*
- ! Exclude entry points, generated code, vendor/third-party

### Style
- ! Use clang-format (project `.clang-format` required)
- ! Use clang-tidy for static analysis
- ~ Use cppcheck as supplementary static analysis
- ! Consistent brace style (K&R or Allman — pick one, enforce via clang-format)
- ! Column limit: 100 characters

### Naming Conventions
- ! `snake_case` for functions, variables, and file names
- ! `UPPER_SNAKE_CASE` for macros and constants
- ! `snake_case_t` suffix for `typedef` types: `typedef struct pixel pixel_t;`
- ! Prefix public API symbols with module/library name: `mylib_init()`, `mylib_destroy()`
- ~ Prefix static (file-scope) functions with `_` or keep unprefixed but `static`
- ⊗ Pollute global namespace with short, generic names

### Types & Integers
- ! Use `<stdint.h>` fixed-width types (`uint8_t`, `int32_t`, `size_t`) for portable code
- ! Use `size_t` for sizes, lengths, and array indices
- ! Use `bool` from `<stdbool.h>` (not `int` for boolean logic)
- ! Use `enum` for related constants; ⊗ `#define` chains for enumerable values
- ~ Use `const` aggressively for read-only data and pointer targets
- ⊗ Rely on implicit `int` (removed in C99+)
- ⊗ Assume `char` is signed or unsigned — use `unsigned char` or `uint8_t` for byte data

### Memory Management
- ! Every `malloc`/`calloc`/`realloc` has a corresponding `free` on all code paths
- ! Check return value of `malloc`/`calloc`/`realloc` for `NULL`
- ! Set pointers to `NULL` after `free` to prevent use-after-free
- ! Use `calloc` over `malloc` + `memset` for zero-initialized allocations
- ! Prefer stack allocation for small, fixed-size data
- ⊗ Use `realloc` on `NULL` without checking the return value
- ⊗ Cast the return value of `malloc` (unnecessary in C, hides missing `#include`)
- ~ Use a consistent allocation/deallocation pattern (init/destroy, open/close)
- ~ Use `memset_explicit()` (C23) to clear sensitive data before freeing
- ? Use arena/pool allocators for performance-critical paths

### Strings & Buffers
- ! Always bounds-check string operations; ⊗ `strcpy`, `strcat`, `sprintf`, `gets`
- ! Use `snprintf` over `sprintf`; `strncpy`/`strlcpy` over `strcpy`
- ! Null-terminate all strings explicitly when building manually
- ! Pass buffer size alongside buffer pointer in all function signatures
- ⊗ Use `gets()` — removed in C11
- ~ Use `strnlen` to safely determine string length on untrusted input

### Error Handling
- ! Check return values of all standard library and system calls
- ! Use a consistent error pattern: return codes (0 = success, negative = error) or errno
- ! Set `errno = 0` before calls that use it; check `errno` only after failure indication
- ! Document error codes for every public function
- ~ Use `goto cleanup` pattern for multi-resource cleanup (not deeply nested `if`s)
- ⊗ Silently ignore return values of I/O, allocation, or system calls

### Preprocessor
- ! Use include guards (`#ifndef`/`#define`/`#endif`) or `#pragma once` in all headers
- ! Wrap multi-statement macros in `do { ... } while(0)`
- ! Parenthesize all macro parameters: `#define MAX(a,b) ((a) > (b) ? (a) : (b))`
- ~ Prefer `static inline` functions over function-like macros when possible
- ⊗ Define macros that rely on implicit variable names from the calling context
- ⊗ Use `#define` to redefine standard library functions or keywords

### Concurrency
- ! Use `<threads.h>` (C11) or POSIX `<pthread.h>` for threading
- ! Protect shared data with mutexes; document locking order
- ! Use `_Atomic` types or `<stdatomic.h>` for lock-free shared variables
- ⊗ Use `volatile` as a synchronization mechanism (it is not one)
- ~ Prefer message-passing or work-queue patterns over shared mutable state
- ~ Use Thread Sanitizer (`-fsanitize=thread`) to detect races in CI

### Undefined Behavior
- ⊗ Rely on undefined behavior (signed overflow, null deref, out-of-bounds, etc.)
- ! Enable `-Wall -Wextra -Wpedantic -Werror` in CI builds
- ! Enable sanitizers in debug/CI: `-fsanitize=address,undefined`
- ~ Enable `-Wconversion -Wshadow -Wformat=2` for stricter checks
- ~ Use `_Static_assert` (C11) / `static_assert` (C23) for compile-time invariants

### Safety & Security
- ! Follow [SEI CERT C Coding Standard](https://wiki.sei.cmu.edu/confluence/display/c) for security-sensitive code
- ! Validate all external input (user, file, network)
- ⊗ Hardcode secrets, keys, or credentials in source
- ⊗ Use `system()` with user-supplied input
- ~ Use ASLR, stack canaries, and `-fstack-protector-strong` in production builds
- ? Follow MISRA C for safety-critical/embedded projects

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging to stderr/syslog for production
- ? Sentry Native SDK for crash reporting
- ? OpenTelemetry C for distributed tracing

## Commands

See [commands.md](./commands.md).

## Patterns

### Goto Cleanup
```c
int process_file(const char *path) {
    int result = -1;
    FILE *fp = NULL;
    char *buf = NULL;
    fp = fopen(path, "r");          if (!fp) goto cleanup;
    buf = malloc(BUF_SIZE);          if (!buf) goto cleanup;
    if (fread(buf, 1, BUF_SIZE, fp) == 0) goto cleanup;
    result = do_work(buf);
cleanup:
    free(buf);  // free(NULL) is safe
    if (fp) fclose(fp);
    return result;
}
```

### Opaque Types
```c
// mylib.h
typedef struct mylib_ctx mylib_ctx_t;
mylib_ctx_t *mylib_create(const char *config);
int          mylib_process(mylib_ctx_t *ctx, const void *data, size_t len);
void         mylib_destroy(mylib_ctx_t *ctx);
// mylib.c
struct mylib_ctx { int fd; size_t count; char name[64]; };
```

### Testing (Unity + cmocka)
```c
// Unity
#include "unity.h"
#include "calculator.h"
void setUp(void) {} void tearDown(void) {}
void test_add(void) { TEST_ASSERT_EQUAL_INT(5, calc_add(2, 3)); }
void test_overflow(void) { TEST_ASSERT_EQUAL_INT(CALC_ERR_OVERFLOW, calc_add(INT_MAX, 1)); }
int main(void) { UNITY_BEGIN(); RUN_TEST(test_add); RUN_TEST(test_overflow); return UNITY_END(); }

// cmocka (--wrap linker flag for mocking)
#include <cmocka.h>
int __wrap_socket_send(int fd, const void *buf, size_t len) {
    check_expected(fd); check_expected(len); return mock_type(int);
}
static void test_send_retries(void **state) {
    (void)state;
    expect_value(__wrap_socket_send, fd, 42); expect_value(__wrap_socket_send, len, 10);
    will_return(__wrap_socket_send, -1);
    expect_value(__wrap_socket_send, fd, 42); expect_value(__wrap_socket_send, len, 10);
    will_return(__wrap_socket_send, 10);
    assert_int_equal(0, network_send_with_retry(42, "0123456789", 10));
}
int main(void) {
    const struct CMUnitTest t[] = { cmocka_unit_test(test_send_retries) };
    return cmocka_run_group_tests(t, NULL, NULL);
}
```

### Macros & Static Assertions
```c
#define ARRAY_SIZE(arr) (sizeof(arr) / sizeof((arr)[0]))
#define LOG_ERROR(fmt, ...) do { fprintf(stderr, "[ERROR] %s:%d: " fmt "\n", __FILE__, __LINE__, ##__VA_ARGS__); } while (0)
static_assert(sizeof(int) >= 4);  // C23
_Static_assert(sizeof(uint32_t) == 4, "uint32_t must be 4 bytes");  // C11
_Static_assert(offsetof(struct packet, checksum) == 12, "checksum at offset 12");
```

## Build Configuration

**CMake** (3.25+): C17/C23 standard, extensions off, `-Wall -Wextra -Wpedantic -Werror -Wconversion -Wshadow -Wformat=2`; add sanitizers (`-fsanitize=address,undefined`) in Debug; optional `--coverage` flag.

**`.clang-format`**: `BasedOnStyle: LLVM`, `IndentWidth: 4`, `ColumnLimit: 100`, `BreakBeforeBraces: Linux`, `PointerAlignment: Right`, `SortIncludes: CaseInsensitive`

**`.clang-tidy`**: Enable `clang-diagnostic-*`, `clang-analyzer-*`, `cert-*`, `bugprone-*`, `performance-*`, `readability-*`, `misc-*`; `WarningsAsErrors: '*'`

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **Deep nesting**: Use functions or `goto cleanup`
- ≉ **Tagless typedef struct**: Include struct tag for forward declarations
- ≉ **Mixing signed/unsigned**: Explicit casts + `-Wconversion`
- ≉ **Global mutable state**: Pass state via struct pointers

## Compliance Checklist

- ! Doxygen comments for all public APIs
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Use clang-format and clang-tidy
- ! `-Wall -Wextra -Wpedantic -Werror` in CI
- ! Sanitizers enabled in debug/CI builds
- ! All allocations checked; all resources freed
- ! Bounds-checked string/buffer operations; ⊗ `strcpy`/`sprintf`/`gets`
- ! Follow SEI CERT C for security-sensitive code
- ⊗ Undefined behavior (signed overflow, null deref, out-of-bounds)
- ! Run `task check` before commit
