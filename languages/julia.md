# Julia Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md)

**Stack**: Julia 1.10+; Packages: Pkg.jl; Testing: `Test` stdlib + Aqua.jl; Docs: Documenter.jl; Format: JuliaFormatter.jl; Lint: JET.jl / Aqua.jl

## Standards

### Documentation
- ! Docstrings (triple-quoted `"""..."""`) on all exported functions, types, and modules
- ! Document arguments, return values, and examples in docstrings
- ! Use Documenter.jl for package documentation with `makedocs()`
- ~ Use `jldoctest` blocks for testable examples in docstrings
- ~ Cross-reference with `` [`OtherFunction`](@ref) `` syntax

### Testing
See [testing.md](../coding/testing.md).

- ! Use `Test` standard library (`@test`, `@testset`, `@test_throws`)
- ! Place tests in `test/runtests.jl` (entry point) with modular test files
- ! Test type stability with `@inferred` for performance-critical functions
- ~ Use Aqua.jl for package quality checks (ambiguities, unbound args, piracy)
- ~ Use `@test_logs` for testing logging output

### Coverage
- ! ≥80% coverage (measured via Coverage.jl or Codecov integration)
- ! Count src/**
- ! Exclude scripts, notebooks, generated code

### Style
- ! Use JuliaFormatter.jl with project `.JuliaFormatter.toml` checked in
- ! 4-space indentation
- ! Line length ≤92 characters (Julia convention)
- ! Follow [Julia Style Guide](https://docs.julialang.org/en/v1/manual/style-guide/)
- ~ Use `BlueStyle` or `SciMLStyle` formatting preset

### Naming Conventions
- ! `snake_case` for functions and variables: `compute_mean`, `max_iterations`
- ! `PascalCase` for types (structs), modules, and abstract types: `DataProcessor`, `AbstractModel`
- ! `SCREAMING_SNAKE_CASE` for global constants
- ! Mutating functions end with `!`: `sort!`, `push!`, `normalize!`
- ! Predicate functions start with `is`/`has`: `isvalid`, `haskey`
- ! Type parameters: single uppercase letters or short descriptive: `T`, `S`, `ElType`
- ⊗ Prefixing types with `Abstract` — use `Abstract` as a prefix for abstract types only

### Type System
- ! Use abstract types to define interfaces and hierarchies
- ! Use parametric types for generic data structures
- ! Annotate function arguments with types for public API (dispatch + documentation)
- ! Use `Union{T, Nothing}` instead of sentinel values for optional data
- ~ Use `Val{x}` for compile-time dispatch on values
- ≉ Over-constraining argument types — accept the broadest useful type
- ≉ Type annotations on local variables (let inference work)

### Multiple Dispatch
- ! Design functions around multiple dispatch: define methods for different type combinations
- ! Keep method signatures specific; avoid `::Any` arguments in exported functions
- ! Use dispatch instead of `if typeof(x) == ...` branches
- ⊗ Type piracy (adding methods to types you don't own for functions you don't own)
- ~ Use trait-based dispatch patterns for interface polymorphism

### Performance
- ! Write type-stable functions (verify with `@code_warntype`)
- ! Avoid global variables in hot paths; use `const` or pass as arguments
- ! Pre-allocate output arrays; use in-place operations (`mul!`, `ldiv!`)
- ! Use `@views` for array slicing to avoid copies
- ~ Use `@inbounds` only after bounds-checking correctness is verified
- ~ Profile with `@time`, `@allocated`, `BenchmarkTools.@btime`
- ≉ Abstract-typed containers (`Vector{Any}`) in performance-critical code
- ⊗ Type-unstable code in inner loops

### Modules & Packages
- ! One module per package; module name matches package name
- ! Use `export` for public API; keep internal functions unexported
- ! Use `Pkg.jl` for dependency management; `Project.toml` + `Manifest.toml`
- ! Specify compat bounds in `Project.toml` for all dependencies
- ~ Use submodules for large packages
- ⊗ `using PackageName` in package code — use `import` or qualified access

### Error Handling
- ! Use exceptions (`throw`, `error`) for exceptional conditions
- ! Define custom exception types inheriting from `Exception`
- ! Use `try`/`catch`/`finally` with specific exception types
- ⊗ Catching `Exception` broadly without rethrowing
- ~ Use return values (`nothing`, `Union{T, Nothing}`) for expected missing data

### Reproducibility
- ! Commit `Manifest.toml` for applications (not for packages)
- ! Use `Pkg.instantiate()` for reproducible environments
- ! Set random seeds (`Random.seed!`) for stochastic code; document in scripts
- ~ Use DrWatson.jl for scientific project management

### Security
- ⊗ Hardcode secrets or credentials in source
- ! Validate all external inputs (file paths, user data, network)
- ~ Use environment variables for secrets (`ENV["API_KEY"]`)

### Telemetry
- ~ Use `Logging` stdlib (`@info`, `@warn`, `@error`) with structured messages
- ~ Use `LoggingExtras.jl` for log routing and formatting
- ? OpenTelemetry via HTTP/REST bridge for distributed systems

## Commands

See [commands.md](./commands.md).

## Patterns

### Multiple Dispatch
```julia
struct Circle radius::Float64 end
struct Rectangle width::Float64; height::Float64 end

area(c::Circle) = π * c.radius^2
area(r::Rectangle) = r.width * r.height
```

### Testing
```julia
using Test
@testset "area" begin
    @test area(Circle(1.0)) ≈ π
    @test area(Rectangle(3.0, 4.0)) == 12.0
    @inferred area(Circle(1.0))  # type stability
end
```

### Parametric Types
```julia
struct BoundedBuffer{T}
    data::Vector{T}; capacity::Int
    function BoundedBuffer{T}(cap::Int) where {T}
        cap > 0 || throw(ArgumentError("capacity must be positive"))
        new{T}(Vector{T}(), cap)
    end
end

function push!(buf::BoundedBuffer{T}, item::T) where {T}
    length(buf.data) >= buf.capacity && throw(OverflowError("buffer full"))
    Base.push!(buf.data, item)
end
```

### In-Place Operations
```julia
"Normalize vector `v` in-place."
function normalize!(v::AbstractVector{<:AbstractFloat})
    n = norm(v)
    n == 0 && throw(ArgumentError("cannot normalize zero vector"))
    v ./= n
end
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **Over-constrained argument types**: Accept broadest useful type
- ≉ **`eval`/`@eval` at runtime**: Prefer compile-time metaprogramming
- ≉ **Non-`const` globals**: Forces runtime type checks
- ≉ **Array slicing without `@views`**: Creates unnecessary copies

## Compliance Checklist

- ! Docstrings on all exported functions/types with examples
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! `Test` stdlib + Aqua.jl; ≥80% coverage
- ! JuliaFormatter + JET.jl enforced
- ! Julia style guide; `snake_case` functions; `!` suffix for mutating
- ! Type-stable code; verified with `@code_warntype`
- ! Compat bounds in `Project.toml` for all dependencies
- ⊗ Type piracy, type-unstable loops, `Vector{Any}`, `using` in packages
- ! Run `task check` before commit
