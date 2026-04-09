# Rust Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md)

**Stack**: Rust (latest stable); Build: Cargo; Testing: built-in `#[test]` + proptest; Lint: clippy; Format: rustfmt; Docs: rustdoc

## Standards

### Documentation
- ! rustdoc comments (`///`) on all public items (functions, structs, enums, traits, modules)
- ! Include `# Examples` section with runnable doc-tests for public API
- ! Module-level docs (`//!`) explaining purpose and usage
- ~ Use `# Errors`, `# Panics`, `# Safety` sections where applicable
- ⊗ `#[allow(missing_docs)]` on public items without justification

### Testing
See [testing.md](../coding/testing.md).

- ! Unit tests in `#[cfg(test)] mod tests` at bottom of each module
- ! Integration tests in `tests/` directory for public API
- ! Use `#[should_panic]` or `assert!(result.is_err())` for error cases
- ~ Use proptest or quickcheck for property-based testing
- ~ Use doc-tests as living examples (they run during `cargo test`)

### Coverage
- ! ≥80% coverage (measured via cargo-tarpaulin or llvm-cov)
- ! Count src/**
- ! Exclude main.rs entry points, generated code, build scripts

### Style
- ! Run rustfmt on all code (project `rustfmt.toml` checked in)
- ! Run clippy with `#![deny(clippy::all)]` at crate level
- ! `#![deny(clippy::pedantic)]` for library crates
- ! 4-space indentation (rustfmt default)
- ! Line length ≤100 characters
- ~ Use `#![warn(clippy::nursery)]` for additional catches

### Naming Conventions
- ! `snake_case` for functions, methods, variables, modules, crate names
- ! `PascalCase` for types (structs, enums, traits), type parameters
- ! `SCREAMING_SNAKE_CASE` for constants and statics
- ! Prefix lifetime parameters with `'`: `'a`, `'input`
- ! Trait names: prefer adjective/verb forms: `Display`, `Iterator`, `Send`
- ⊗ Hungarian notation or type prefixes
- ~ Getter methods: use field name directly (`fn name(&self)` not `fn get_name`)

### Ownership & Borrowing
- ! Prefer borrowing (`&T`, `&mut T`) over cloning
- ! Use `Clone` only when ownership transfer is truly needed
- ! Prefer `&str` over `String` in function parameters
- ! Prefer `&[T]` over `Vec<T>` in function parameters
- ⊗ `.unwrap()` or `.expect()` in library code — return `Result` or `Option`
- ~ Use `Cow<'_, str>` when a function may or may not need to allocate
- ≉ Excessive `.clone()` to appease the borrow checker — redesign ownership

### Error Handling
- ! Use `Result<T, E>` for recoverable errors; define custom error types
- ! Use `thiserror` for library error types; `anyhow` for application error types
- ! Implement `std::error::Error` for all custom error types
- ! Use `?` operator for error propagation
- ⊗ `.unwrap()` in production code (except after infallible checks with comments)
- ⊗ `panic!()` for expected error conditions
- ~ Use `#[must_use]` on functions returning `Result` or important values

### Concurrency
- ! Use `Send` + `Sync` bounds correctly; understand their implications
- ! Prefer channels (`mpsc`, `crossbeam`) over shared mutable state
- ! Use `Arc<Mutex<T>>` or `Arc<RwLock<T>>` when shared state is necessary
- ⊗ `unsafe` to circumvent Send/Sync bounds
- ~ Use `tokio` or `async-std` for async I/O; avoid mixing runtimes
- ~ Prefer `RwLock` over `Mutex` for read-heavy workloads

### Unsafe Code
- ! Minimize `unsafe` blocks; isolate behind safe abstractions
- ! Document `# Safety` section explaining invariants for every `unsafe fn`
- ! Document `// SAFETY:` comment on every `unsafe` block explaining why it's sound
- ⊗ `unsafe` without clear justification and safety proof
- ~ Use `#![forbid(unsafe_code)]` for crates that don't need it

### Dependencies
- ! Pin dependencies in `Cargo.lock` (always commit for binaries)
- ! Audit dependencies with `cargo-audit`
- ! Minimize dependency count; prefer `std` library functionality
- ~ Use `cargo-deny` to enforce license and duplicate dependency policies
- ≉ `*` version specifiers in `Cargo.toml`

### Performance
- ! Use iterators and zero-cost abstractions over manual loops where idiomatic
- ! Prefer stack allocation; use `Box<T>` only when heap is necessary
- ~ Use `#[inline]` sparingly and only with benchmarks to justify
- ~ Profile with `criterion` for benchmarks; `perf` or `flamegraph` for profiling
- ≉ Premature optimization over readability

### Macros
- ~ Prefer functions and generics over macros when possible
- ! Document all `macro_rules!` with examples
- ! Keep macro complexity minimal; extract logic into functions
- ⊗ Macros that generate non-obvious control flow

### Security
- ⊗ Hardcode secrets or credentials in source
- ! Validate all external inputs (file paths, network data, user input)
- ! Use `secrecy` crate for sensitive values (keys, tokens)
- ~ Use `zeroize` for clearing secrets from memory

### Telemetry
- ~ Use `tracing` crate for structured, async-aware logging
- ~ Use `tracing-opentelemetry` for distributed tracing
- ? Use `metrics` crate for Prometheus-compatible metrics

## Commands

See [commands.md](./commands.md).

## Patterns

### Error Handling (thiserror)
```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("config not found: {path}")] ConfigNotFound { path: String },
    #[error("invalid config: {0}")] InvalidConfig(String),
    #[error(transparent)] Io(#[from] std::io::Error),
}

pub fn load_config(path: &str) -> Result<Config, AppError> {
    if !std::path::Path::new(path).exists() {
        return Err(AppError::ConfigNotFound { path: path.to_string() });
    }
    let content = std::fs::read_to_string(path)?;
    parse_config(&content).map_err(AppError::InvalidConfig)
}
```

### Testing (Table-Driven)
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_parse_amount() {
        let cases = [("100", Ok(100)), ("0", Ok(0)), ("-5", Err("negative")), ("abc", Err("invalid"))];
        for (input, expected) in cases {
            match expected {
                Ok(val) => assert_eq!(parse_amount(input).unwrap(), val, "{input}"),
                Err(msg) => assert!(parse_amount(input).unwrap_err().to_string().contains(msg), "{input}"),
            }
        }
    }
}
```

### Builder Pattern
```rust
#[derive(Debug, Default)]
pub struct RequestBuilder { url: String, timeout: Option<u64>, headers: Vec<(String, String)> }

impl RequestBuilder {
    pub fn new(url: impl Into<String>) -> Self { Self { url: url.into(), ..Default::default() } }
    pub fn timeout(mut self, secs: u64) -> Self { self.timeout = Some(secs); self }
    pub fn header(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.headers.push((k.into(), v.into())); self
    }
    pub fn build(self) -> Result<Request, BuildError> { Ok(Request { /* ... */ }) }
}
```

### Structured Logging (tracing)
```rust
#[instrument(skip(db), fields(user_id = %user_id))]
pub async fn get_user(db: &Pool, user_id: i64) -> Result<User, AppError> {
    info!("fetching user");
    let user = db.query_one("SELECT ...", &[&user_id]).await?;
    if user.is_inactive() { warn!("inactive user accessed"); }
    Ok(user)
}
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **`Arc<Mutex<T>>` as first resort**: Consider channels/message passing
- ≉ **Stringly-typed errors**: Use `thiserror`
- ≉ **God-struct with many `Option` fields**: Use builder pattern or state types
- ≉ **`Box<dyn Error>` in libraries**: Define specific error enums

## Compliance Checklist

- ! rustdoc on all public items with examples
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Unit + integration tests; ≥80% coverage
- ! rustfmt + clippy (pedantic for libs) enforced
- ! Custom error types via thiserror/anyhow; no `.unwrap()` in production
- ! `unsafe` minimized, documented, and justified
- ! `Cargo.lock` committed (binaries); `cargo-audit` clean
- ⊗ `.unwrap()`, `panic!()`, unguarded `unsafe`, excessive `.clone()`
- ! Run `task check` before commit
