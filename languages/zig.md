# Zig Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md)

**Stack**: Zig (0.13+ / latest stable); Build: zig build; Testing: built-in `test`; Format: `zig fmt`; Docs: autodoc

## Standards

### Documentation
- ! Doc comments (`///`) on all public functions, types, and declarations
- ! Module-level doc comments (`//!`) explaining purpose
- ! Document error conditions and which errors a function can return
- ~ Include usage examples in doc comments for public API

### Testing
See [testing.md](../coding/testing.md).

- ! Use `test` blocks in source files for unit tests
- ! Use `std.testing.expect*` family for assertions
- ! Test error paths and edge cases (null, empty, boundary values)
- ~ Use `std.testing.allocator` (GeneralPurposeAllocator in test mode) to detect leaks
- ~ Place integration tests in `test/` directory

### Coverage
- ! ≥75% coverage (measured via zig build -Drelease-safe with kcov or similar)
- ! Count src/**
- ! Exclude build.zig, generated code

### Style
- ! Run `zig fmt` on all code before commit
- ! 4-space indentation
- ! Line length ≤100 characters
- ! One statement per line
- ~ Follow [Zig Style Guide](https://ziglang.org/documentation/master/#style-guide)

### Naming Conventions
- ! `camelCase` for functions, methods, local variables
- ! `PascalCase` for types (structs, enums, unions, error sets)
- ! `SCREAMING_SNAKE_CASE` for compile-time constants and `comptime` values
- ! `snake_case` for file names and module names
- ! Prefix unused variables with `_`
- ⊗ Abbreviations unless universally understood

### Memory Management
- ! Use allocator-passing pattern: accept `std.mem.Allocator` as parameter
- ! Pair every allocation with a deallocation (`defer allocator.free(...)`)
- ! Use `defer` / `errdefer` for deterministic cleanup
- ! Use `ArenaAllocator` for batch allocations with shared lifetime
- ⊗ Global allocators or hidden allocation
- ⊗ Ignoring allocation failures (`catch unreachable` without justification)
- ~ Use `GeneralPurposeAllocator` in tests to detect leaks

### Error Handling
- ! Use error unions (`!`) for all fallible functions
- ! Propagate errors with `try` (equivalent to Rust's `?`)
- ! Define specific error sets per function
- ! Use `errdefer` to clean up on error paths
- ⊗ `catch unreachable` without a safety comment explaining why
- ⊗ Discarding errors silently (`_ = fallibleFn()`)
- ~ Use error traces in debug builds for diagnostics
- ~ Return `error.OutOfMemory` from allocator failures, not panics

### Comptime
- ! Use `comptime` for compile-time computation where it eliminates runtime cost
- ! Prefer `comptime` generics over runtime polymorphism
- ! Keep `comptime` functions pure and side-effect free
- ~ Use `@compileError` for clear compile-time constraint violations
- ≉ Overuse of `comptime` that obscures readability

### Safety & Undefined Behavior
- ! Enable safety checks in debug/test builds (`-Drelease-safe` for testing)
- ! Validate all external inputs (buffer sizes, indices, pointers)
- ⊗ `@ptrCast` or `@intFromPtr` without safety justification comment
- ⊗ Accessing `undefined` memory
- ⊗ Index out of bounds (use slices with bounds checking)
- ~ Use `std.debug.assert` for invariants in debug builds

### Interop (C ABI)
- ! Use `extern "c"` for C interop functions
- ! Validate all pointers received from C code
- ! Use `[*c]` pointer types for C arrays; convert to slices immediately
- ~ Wrap C libraries in safe Zig abstractions
- ⊗ Exposing raw C pointers in public Zig API

### Dependencies
- ! Declare dependencies in `build.zig.zon`
- ! Pin dependency versions with hashes
- ~ Minimize external dependencies; prefer Zig standard library
- ~ Vendor critical dependencies when stability matters

### Performance
- ! Prefer slices over pointer arithmetic
- ! Use SIMD via `@Vector` for data-parallel operations where profiling justifies
- ~ Use `std.ArrayList` over manual buffer management
- ~ Profile before optimizing; use `std.time.Timer` or external profilers
- ≉ Premature optimization over clarity

### Security
- ⊗ Hardcode secrets or credentials in source
- ! Zero sensitive memory after use (`std.crypto.utils.secureZero`)
- ! Validate all buffer lengths before operations
- ~ Use `std.crypto` for cryptographic operations (not custom implementations)

### Telemetry
- ~ Use `std.log` for structured logging with scoped loggers
- ? Custom tracing via comptime-generated instrumentation

## Commands

See [commands.md](./commands.md).

## Patterns

### Allocator-Passing Pattern
```zig
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Config = struct {
    name: []const u8, values: []i32, allocator: Allocator,

    pub fn init(allocator: Allocator, name: []const u8) !Config {
        const name_copy = try allocator.dupe(u8, name);
        errdefer allocator.free(name_copy);
        return .{ .name = name_copy, .values = &[_]i32{}, .allocator = allocator };
    }

    pub fn deinit(self: *Config) void {
        self.allocator.free(self.name);
        if (self.values.len > 0) self.allocator.free(self.values);
    }
};
```

### Error Handling with errdefer
```zig
pub fn loadFile(allocator: Allocator, path: []const u8) ![]u8 {
    const file = std.fs.cwd().openFile(path, .{}) catch |err| { std.log.err("open {s}: {}", .{ path, err }); return err; };
    defer file.close();
    const stat = try file.stat();
    const buf = try allocator.alloc(u8, stat.size);
    errdefer allocator.free(buf);
    const n = try file.readAll(buf);
    if (n != stat.size) return error.IncompleteRead;
    return buf;
}
```

### Testing with Leak Detection
```zig
test "config init and deinit" {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer { const check = gpa.deinit(); try std.testing.expect(check == .ok); }
    const alloc = gpa.allocator();
    var config = try Config.init(alloc, "test");
    defer config.deinit();
    try std.testing.expectEqualStrings("test", config.name);
}
```

### Comptime Generics
```zig
pub fn BoundedArray(comptime T: type, comptime cap: usize) type {
    return struct {
        const Self = @This();
        items: [cap]T = undefined, len: usize = 0,
        pub fn append(self: *Self, item: T) !void {
            if (self.len >= cap) return error.Overflow;
            self.items[self.len] = item; self.len += 1;
        }
        pub fn slice(self: *const Self) []const T { return self.items[0..self.len]; }
    };
}
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **Manual pointer arithmetic**: Use slices
- ≉ **Overusing `anytype`**: Use specific types for better errors
- ≉ **Large functions**: Decompose into focused, testable units
- ≉ **`@ptrCast` chains**: Wrap C interop in safe abstractions

## Compliance Checklist

- ! Doc comments on all public declarations
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Unit tests with leak detection; ≥75% coverage
- ! `zig fmt` enforced; follows Zig style guide
- ! Allocator-passing pattern; `defer`/`errdefer` for all resources
- ! Error unions for fallible functions; specific error sets
- ⊗ Global allocators, `catch unreachable` without comment, ignored errors
- ! Run `task check` before commit
