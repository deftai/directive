# Delphi / Object Pascal Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: Delphi 12+/Object Pascal, RAD Studio; GUI: VCL (Windows), FMX (cross-platform); DB: FireDAC; Testing: DUnitX

## Standards

### Documentation
- ! XML documentation comments (`///`) for all public types, methods, and properties
- ! Unit header comment: purpose, author, date, dependencies
- ~ Document preconditions, postconditions, and exceptions on public methods
- ~ Use `{$REGION}` / `{$ENDREGION}` to organize long units

### Testing
See [testing.md](../coding/testing.md).

- ! Use DUnitX for all new test projects
- ≉ Use legacy DUnit for new code (maintain existing DUnit suites only)
- Files: `Test*.pas` or `*Tests.pas`

### Coverage
- ! ≥85% coverage
- ! Count src/\*
- ! Exclude entry points, generated code, DFM/FMX form logic

### Style
- ! Follow [Embarcadero Object Pascal Style Guide](https://docwiki.embarcadero.com/RADStudio/en/Delphi's_Object_Pascal_Style_Guide)
- ! Use PascalCase (InfixCaps) for all identifiers; ⊗ underscores (except header translations)
- ! Reserved words and keywords in lowercase (`begin`, `end`, `string`, `nil`)
- ! Two-space indentation (no tabs)
- ⊗ Hungarian notation (except header translations)
- ~ Use [Pascal Analyzer](https://www.peganza.com/) or [FixInsight](https://www.yourkit.com/) for static analysis

### Naming Conventions
- ! Types prefixed with `T`: `TCustomer`, `TOrderStatus`
- ! Interfaces prefixed with `I`: `IRepository`, `ILogger`
- ! Exception types prefixed with `E`: `EInvalidArgument`, `ENotFound`
- ! Private fields prefixed with `F`: `FName`, `FCount`
- ! Enumeration members prefixed with 2–3 char mnemonic: `TColor = (clRed, clGreen, clBlue)`
- ! Component variables prefixed by type abbreviation: `btnSubmit`, `edtName`, `lblTitle`
- ~ Constants in PascalCase (not ALL_CAPS): `const MaxRetries = 3;`
- ~ Descriptive names; prefer `ObjectPointer` over `ObjPtr`

### Types
- ! Use strong typing: enumerations, records, distinct types over raw integers/strings
- ! Use generics (`TList<T>`, `TDictionary<K,V>`, `TObjectList<T>`) over untyped containers
- ⊗ Use `Variant` / `OleVariant` except when required for COM interop
- ⊗ Use untyped containers (`TList`, `TStringList` for non-string data)
- ~ Use `TArray<T>` over dynamic array declarations
- ~ Use `Double` for floating-point; ≉ use `Real` (backward compat only)
- ~ Use `NativeInt`/`NativeUInt` for pointer-sized integers

### Memory Management
- ! Every object you create, you must free (clear ownership model)
- ! Use `FreeAndNil` over bare `Free` for field cleanup in destructors
- ! Override `Destroy` (not `Free`); always mark with `override`
- ! Use `try..finally` to guarantee cleanup of locally created objects
- ⊗ Call `Destroy` directly; always use `Free` or `FreeAndNil`
- ~ Use TComponent ownership (`AOwner` parameter) for form/component lifecycles
- ~ Use interfaces (reference counting) for shared/cross-boundary objects
- ~ Use managed records (`class operator Initialize/Finalize`) for RAII patterns (Delphi 10.4+)
- ≉ Use `GetMem`/`FreeMem` unless writing low-level or performance-critical code

### Interfaces
- ! Use interfaces for abstraction, testability, and dependency injection
- ! Declare interfaces in a shared unit separate from implementations
- ~ Use interface delegation (`implements` keyword) to compose behavior
- ~ Prefer interface references over class references for cross-module boundaries
- ⊗ Mix interface references and object references to the same instance (prevents double-free / ref-count issues)

### Error Handling
- ! Use exceptions for exceptional/unexpected errors
- ! Derive custom exceptions from `Exception` or `EArgumentException`, etc.
- ! Use `try..except` with specific exception types; ⊗ bare `except` without re-raise
- ! Use `try..finally` for resource cleanup (separate from `try..except`)
- ⊗ Silently swallow exceptions (empty `except` blocks)
- ~ Use `EAbort` / `Abort` for non-error flow control (e.g., cancel operations)
- ~ Log exceptions with context before re-raising

### Concurrency
- ! Use `TTask` / `TParallel` (Parallel Programming Library) for new async work
- ! Never access VCL/FMX controls from background threads; use `TThread.Synchronize` or `TThread.Queue`
- ~ Use `TThreadPool` for managing concurrent workloads
- ~ Use `TMonitor` or `TCriticalSection` for shared state protection
- ⊗ Use `Suspend`/`Resume` on threads (deprecated, unsafe)
- ≉ Directly subclass `TThread` when PPL tasks suffice

### Database (FireDAC)
- ! Use parameterized queries; ⊗ string concatenation for SQL
- ! Use `TFDConnection` with connection definitions (not hard-coded connection strings)
- ~ Use `TFDQuery` over `TFDTable` for production code
- ~ Wrap multi-step operations in explicit transactions
- ⊗ Use BDE (Borland Database Engine) — fully deprecated

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging (CodeSite, SmartInspect, or custom structured logger) for production
- ~ Sentry.io (via REST) or equivalent for error tracking
- ? OpenTelemetry (via REST integration) for distributed tracing

### Safety
- ⊗ Hardcode API keys or secrets in source or shipped binaries
- ! Validate all external input (user input, file data, network responses)
- ~ Use `{$WARN}` directives to treat warnings as errors in CI
- ~ Enable range checking (`{$R+}`) and overflow checking (`{$Q+}`) in debug builds

## Commands

See [commands.md](./commands.md).

## Patterns

### Testing (DUnitX)
```pascal
unit TestCalculator;
interface
uses DUnitX.TestFramework, Calculator;
type
  [TestFixture]
  TTestCalculator = class
  private
    FSut: TCalculator;
  public
    [Setup]    procedure Setup;
    [TearDown] procedure TearDown;
    [Test]     procedure Add_TwoPositiveNumbers_ReturnsSum;
    [Test] [TestCase('Zero','0,1,1')] [TestCase('Neg','-1,1,0')]
    procedure Add_Parameterized(const A, B, Expected: Integer);
  end;
implementation
procedure TTestCalculator.Setup; begin FSut := TCalculator.Create end;
procedure TTestCalculator.TearDown; begin FreeAndNil(FSut) end;
procedure TTestCalculator.Add_TwoPositiveNumbers_ReturnsSum;
begin Assert.AreEqual(5, FSut.Add(2, 3)) end;
procedure TTestCalculator.Add_Parameterized(const A, B, Expected: Integer);
begin Assert.AreEqual(Expected, FSut.Add(A, B)) end;
initialization
  TDUnitX.RegisterTestFixture(TTestCalculator);
end.
```

### Interface-Based Design
```pascal
unit Services.Interfaces;
interface
type
  ILogger = interface
    ['{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}']
    procedure Info(const Msg: string);
    procedure Error(const Msg: string; E: Exception = nil);
  end;
  IRepository<T: class> = interface
    ['{B2C3D4E5-F6A7-8901-BCDE-F12345678901}']
    function GetById(const Id: Integer): T;
    function GetAll: TArray<T>;
    procedure Save(const Entity: T);
    procedure Delete(const Id: Integer);
  end;
implementation
end.
```

### Resource Cleanup & Generics
```pascal
procedure ProcessFile(const FileName: string);
var Stream: TFileStream; Reader: TStreamReader;
begin
  Stream := TFileStream.Create(FileName, fmOpenRead or fmShareDenyWrite);
  try
    Reader := TStreamReader.Create(Stream);
    try while not Reader.EndOfStream do ProcessLine(Reader.ReadLine);
    finally FreeAndNil(Reader) end;
  finally FreeAndNil(Stream) end;
end;

var Customers: TObjectList<TCustomer>;
begin
  Customers := TObjectList<TCustomer>.Create(True); // OwnsObjects
  try
    for var C in Customers do DoWork(C);
  finally Customers.Free end;
end;
```

### Async with PPL
```pascal
procedure TMainForm.btnProcessClick(Sender: TObject);
begin
  btnProcess.Enabled := False;
  TTask.Run(procedure var R: string; begin
    R := PerformHeavyWork;
    TThread.Queue(nil, procedure begin lblResult.Caption := R; btnProcess.Enabled := True end);
  end);
end;
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **`Application.ProcessMessages` in loops**: Use PPL/threads
- ≉ **Published fields without properties**: Use properties
- ≉ **Circular unit references**: Extract shared types to common unit

## Compliance Checklist

- ! Follow Embarcadero Object Pascal Style Guide
- ! PascalCase identifiers; `T`/`I`/`E`/`F` prefixes
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Use DUnitX for unit tests
- ! Use `try..finally` for resource cleanup; `FreeAndNil` in destructors
- ! Use generics and interfaces for type safety and abstraction
- ⊗ Use `Variant`, `with`, global state, or BDE
- ⊗ Access UI from background threads
- ! Run `task check` before commit
