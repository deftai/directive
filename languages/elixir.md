# Elixir Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md)

**Stack**: Elixir 1.16+ / OTP 26+; Build: Mix; Testing: ExUnit; Lint: Credo; Format: `mix format`; Docs: ExDoc; Types: Dialyxir

## Standards

### Documentation
- ! `@doc` and `@moduledoc` on all public modules and functions
- ! `@spec` typespecs on all public functions
- ! Include `## Examples` with `iex>` doctest blocks for public API
- ~ Use `@doc false` to explicitly hide internal public functions
- ~ Cross-reference with `{:link, module}` or backtick syntax

### Testing
See [testing.md](../coding/testing.md).

- ! Use ExUnit (`test`, `describe`, `assert`, `refute`)
- ! Place tests in `test/` mirroring `lib/` structure; files: `*_test.exs`
- ! Test happy paths, error cases, and edge cases
- ~ Use doctests (`doctest Module`) for example-based testing
- ~ Use `Mox` for mocking via behaviours (not concrete implementations)
- ~ Use property-based testing via `StreamData`

### Coverage
- ! ≥80% coverage (measured via `mix test --cover` or excoveralls)
- ! Count lib/**
- ! Exclude generated code, migrations, Phoenix boilerplate

### Style
- ! Run `mix format` on all code (project `.formatter.exs` checked in)
- ! Use Credo for static analysis (`mix credo --strict`)
- ! 2-space indentation
- ! Line length ≤98 characters (Elixir formatter default)
- ! Follow [Elixir Style Guide](https://github.com/christopheradams/elixir_style_guide)

### Naming Conventions
- ! `snake_case` for functions, variables, atoms, and file names
- ! `PascalCase` (CamelCase) for module names: `MyApp.UserService`
- ! `snake_case` for module file paths matching module name: `my_app/user_service.ex`
- ! Predicate functions end with `?`: `valid?`, `empty?`, `admin?`
- ! Dangerous/raising functions end with `!`: `fetch!`, `decode!`
- ! `SCREAMING_SNAKE_CASE` for module attributes used as constants (convention, not enforced)
- ⊗ Atoms with spaces or special characters unless protocol requires it

### Pattern Matching
- ! Use pattern matching for control flow (function heads, `case`, `with`)
- ! Prefer multi-clause functions over `if`/`cond` for type/shape dispatch
- ! Use `with` for chaining fallible operations with clear pattern matching
- ! Destructure in function arguments when possible
- ⊗ Nested `case` statements >2 levels deep — refactor into functions
- ≉ `if`/`else` when pattern matching is clearer

### Data & Immutability
- ! All data is immutable — embrace transformation pipelines
- ! Use structs (`%MyStruct{}`) for domain entities with enforced keys
- ! Use `@enforce_keys` for required struct fields
- ! Use maps for unstructured/dynamic data; keyword lists for options
- ~ Use Ecto embedded schemas for validated data structures
- ⊗ Atoms from user input (`String.to_atom/1`) — atom table is not garbage collected

### Pipe Operator
- ! Use `|>` for data transformation chains (≥2 steps)
- ! First argument flows through the pipe; design functions pipe-friendly
- ! One transformation per line in pipe chains
- ≉ Pipe chains >10 steps — extract named intermediate functions
- ≉ Pipes with anonymous functions — extract to named functions

### OTP & Concurrency
- ! Use OTP behaviours: `GenServer`, `Supervisor`, `Agent`, `Task`
- ! Supervision trees for all long-running processes
- ! Use `Task.async` / `Task.await` for concurrent one-off work
- ! Trap exits explicitly when needed; document why
- ! Design processes for "let it crash" — supervisors restart
- ⊗ Spawning bare processes without supervision in production
- ⊗ Shared mutable state outside of OTP processes
- ~ Use `Registry` for dynamic process naming
- ~ Use `GenStage` / `Broadway` for back-pressure and data pipelines

### Error Handling
- ! Use `{:ok, value}` / `{:error, reason}` tuples for expected failures
- ! Use `!` function variants that raise for unexpected/unrecoverable errors
- ! Use `with` for composing multiple `{:ok, _}` / `{:error, _}` chains
- ! Let processes crash on unexpected errors; supervisors handle recovery
- ⊗ Catching broad exceptions (`rescue Exception`) in normal flow
- ⊗ Returning bare `:error` without a reason

### Behaviours & Protocols
- ! Define `@callback` specs in behaviour modules
- ! Use behaviours for dependency injection / mocking boundaries
- ! Use protocols for polymorphic dispatch on data types
- ~ Use `defimpl` in the data type's module or in the protocol module (be consistent)

### Dependencies
- ! Manage via Mix (`mix.exs` deps); specify version constraints
- ! Use `mix.lock` committed for applications
- ! Minimize dependencies; prefer standard library and OTP
- ~ Run `mix hex.audit` for security advisories
- ~ Use `mix deps.audit` for outdated dependencies

### Phoenix (Web)
- ~ Follow Phoenix conventions: contexts for business logic, schemas for data
- ! Validate all inputs via Ecto changesets
- ! Use parameterized queries (Ecto handles this by default)
- ~ Use LiveView for real-time UI; channels for custom WebSocket protocols
- ⊗ Business logic in controllers — delegate to context modules

### Security
- ⊗ Hardcode secrets or credentials in source
- ! Use `Application.get_env` or `System.get_env` for secrets (runtime config)
- ! Validate all external inputs
- ⊗ `String.to_atom/1` on user input (denial-of-service vector)
- ~ Use `Plug.CSRFProtection` for web applications

### Telemetry
- ! Use `:telemetry` for instrumentation (Erlang standard)
- ~ Use `telemetry_metrics` + `telemetry_poller` for metrics collection
- ~ Use `Logger` with structured metadata
- ? OpenTelemetry via `opentelemetry_api` + `opentelemetry_exporter`

## Commands

See [commands.md](./commands.md).

## Patterns

### Pattern Matching & Pipelines
```elixir
defmodule MyApp.Parser do
  @spec parse_value(String.t(), atom()) :: {:ok, term()} | {:error, atom()}
  def parse_value(raw, :integer) do
    case Integer.parse(raw) do
      {val, ""} -> {:ok, val}
      _ -> {:error, :invalid_integer}
    end
  end
  def parse_value("true", :boolean), do: {:ok, true}
  def parse_value("false", :boolean), do: {:ok, false}
  def parse_value(_, :boolean), do: {:error, :invalid_boolean}
  def parse_value(raw, :string) when is_binary(raw), do: {:ok, raw}
  def parse_value(_, _), do: {:error, :unsupported_type}
end

# with pipeline for composed operations
def create_user(params) do
  with {:ok, v} <- validate_params(params),
       {:ok, user} <- Repo.insert(User.changeset(%User{}, v)),
       {:ok, _} <- Mailer.send_welcome(user) do
    {:ok, user}
  end
end
```

### GenServer
```elixir
defmodule MyApp.Counter do
  use GenServer
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, Keyword.get(opts, :initial, 0), name: __MODULE__)
  def increment, do: GenServer.call(__MODULE__, :increment)
  def value, do: GenServer.call(__MODULE__, :value)
  @impl true
  def init(initial), do: {:ok, initial}
  @impl true
  def handle_call(:increment, _from, n), do: {:reply, n + 1, n + 1}
  def handle_call(:value, _from, n), do: {:reply, n, n}
end
```

### Testing (ExUnit)
```elixir
defmodule MyApp.ParserTest do
  use ExUnit.Case, async: true
  doctest MyApp.Parser

  describe "parse_value/2" do
    test "parses integer" do assert {:ok, 42} = MyApp.Parser.parse_value("42", :integer) end
    test "rejects invalid" do assert {:error, _} = MyApp.Parser.parse_value("abc", :integer) end
    test "parses booleans" do
      assert {:ok, true} = MyApp.Parser.parse_value("true", :boolean)
      assert {:error, _} = MyApp.Parser.parse_value("yes", :boolean)
    end
  end
end
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **`if`/`else` over pattern matching**: Use multi-clause functions or `case`
- ≉ **Nested `case` >2 deep**: Refactor into named functions
- ≉ **Anonymous functions in pipes**: Extract to named functions
- ≉ **Long `with` chains (>5 clauses)**: Break into smaller functions

## Compliance Checklist

- ! `@doc`, `@moduledoc`, `@spec` on all public API
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! ExUnit + doctests; ≥80% coverage
- ! `mix format` + Credo (strict) + Dialyxir enforced
- ! Pattern matching and pipes for control flow; OTP for concurrency
- ! `{:ok, _}` / `{:error, reason}` tuples; `!` variants for raising
- ! Supervision trees for all production processes
- ⊗ Bare `spawn`, `String.to_atom/1` on input, broad `rescue`, logic in controllers
- ! Run `task check` before commit
