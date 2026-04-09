# Dart Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md)

**Stack**: Dart 3.x+; Framework: Flutter (mobile/web) or standalone; Testing: `package:test` / `flutter_test`; Lint: `analysis_options.yaml` + custom_lint; Format: `dart format`; Docs: dartdoc

## Standards

### Documentation
- ! dartdoc comments (`///`) on all public classes, functions, properties, and libraries
- ! Document parameters, return values, and exceptions for public API
- ! Library-level doc comments (`/// {@category ...}`) for package organization
- ~ Use `[ClassName]` and `[methodName]` for cross-references in doc comments
- ~ Include code examples in `/// ```dart` blocks

### Testing
See [testing.md](../coding/testing.md).

- ! Use `package:test` (Dart) or `flutter_test` (Flutter) for unit tests
- ! Place tests in `test/` directory mirroring `lib/` structure
- ! Test widget trees with `testWidgets()` and `WidgetTester` (Flutter)
- ~ Use `mockito` or `mocktail` for mocking dependencies
- ~ Use golden tests for UI regression testing (Flutter)

### Coverage
- ! ≥80% coverage (measured via `dart test --coverage` or `flutter test --coverage`)
- ! Count lib/**
- ! Exclude generated files (`*.g.dart`, `*.freezed.dart`), entry points

### Style
- ! Follow [Effective Dart](https://dart.dev/effective-dart) guidelines
- ! Use `analysis_options.yaml` with recommended lints enabled
- ! Use `dart format` (or `flutter format`) for all code
- ! 2-space indentation
- ! Line length ≤80 characters
- ! Enable `strict-casts`, `strict-inference`, `strict-raw-types` in analysis options

### Naming Conventions
- ! `lowerCamelCase` for variables, functions, parameters, named parameters
- ! `UpperCamelCase` for classes, enums, typedefs, extensions, mixins
- ! `lowerCamelCase` for library/package names and file names
- ! `SCREAMING_SNAKE_CASE` for compile-time constants only when following Flutter convention
- ! Prefix private members with `_`: `_internalState`
- ! Prefix boolean variables/getters with `is`, `has`, `can`: `isLoading`, `hasError`
- ⊗ Hungarian notation or type prefixes

### Null Safety
- ! Use sound null safety (Dart 3.x enforces this)
- ! Use `?` for nullable types only when null is a valid state
- ! Use `late` only when initialization is guaranteed before access
- ! Prefer `??` (if-null) and `?.` (null-aware) over null checks
- ⊗ Force-unwrap (`!`) without prior null check or assertion
- ≉ `late` as a workaround for poor initialization design

### Immutability
- ! Use `final` for variables that are assigned once
- ! Use `const` for compile-time constants and constructors
- ! Prefer immutable data classes (use `freezed` or manual `copyWith`)
- ≉ Mutable state where `final` + rebuild pattern suffices (esp. Flutter)

### Classes & Types
- ! Use `sealed class` (Dart 3) for exhaustive type hierarchies
- ! Use `enum` with members for fixed sets of values
- ! Use extension types for zero-cost wrappers
- ! Use mixins for shared behavior across unrelated classes
- ~ Use `typedef` for complex function signatures
- ⊗ Deep inheritance hierarchies (>3 levels) — prefer composition

### Async & Concurrency
- ! Use `async`/`await` for asynchronous operations
- ! Always handle errors from Futures (`try`/`catch` or `.catchError`)
- ! Use `Stream` for reactive data flows; `StreamController` for custom streams
- ! Close `StreamController` and cancel `StreamSubscription` to avoid leaks
- ⊗ Fire-and-forget Futures without error handling
- ~ Use `Isolate` for CPU-intensive work (keeps UI responsive in Flutter)
- ~ Use `compute()` helper for simple isolate tasks in Flutter

### State Management (Flutter)
- ~ Choose one state management approach per project and document it
- ~ Options: Riverpod, Bloc/Cubit, Provider, signals
- ! Separate business logic from UI (no business logic in `build()`)
- ! Dispose controllers, streams, and subscriptions in `dispose()`
- ⊗ Calling `setState` from outside the widget or after disposal

### Dependencies
- ! Pin dependency versions in `pubspec.yaml` (use `^` for semver ranges)
- ! Use `pubspec.lock` committed for applications (not for packages)
- ! Minimize dependencies; prefer `dart:*` core libraries
- ~ Use `dependency_overrides` only for testing, never in production
- ~ Run `dart pub outdated` regularly

### Code Generation
- ! Use `build_runner` for code generation (`json_serializable`, `freezed`, etc.)
- ! Commit generated files or document regeneration in task commands
- ! Exclude generated files from lint and coverage

### Security
- ⊗ Hardcode secrets or credentials in source (esp. Flutter — compiled but extractable)
- ! Validate all external inputs (user data, API responses, deep links)
- ~ Use `flutter_secure_storage` for sensitive data on device
- ~ Use certificate pinning for critical API connections

### Telemetry
- ~ Use `package:logging` or structured logger for backend Dart
- ~ Use Firebase Crashlytics / Sentry for Flutter crash reporting
- ? OpenTelemetry for backend Dart services

## Commands

See [commands.md](./commands.md).

## Patterns

### Sealed Class + Pattern Matching (Dart 3)
```dart
sealed class Result<T> { const Result(); }
class Success<T> extends Result<T> { final T data; const Success(this.data); }
class Failure<T> extends Result<T> { final String message; const Failure(this.message); }

String display(Result<User> r) => switch (r) {
  Success(data: final u) => 'Welcome, ${u.name}',
  Failure(message: final m) => 'Error: $m',
};
```

### Testing (Flutter Widget)
```dart
testWidgets('Counter increments', (tester) async {
  await tester.pumpWidget(const MyApp());
  expect(find.text('0'), findsOneWidget);
  await tester.tap(find.byIcon(Icons.add));
  await tester.pump();
  expect(find.text('1'), findsOneWidget);
});
```

### Repository Pattern
```dart
abstract interface class UserRepository {
  Future<User?> findById(int id);
  Future<List<User>> findAll({int limit = 20, int offset = 0});
}

class ApiUserRepository implements UserRepository {
  final HttpClient _client;
  ApiUserRepository(this._client);

  @override
  Future<User?> findById(int id) async {
    final response = await _client.get(Uri.parse('/users/$id'));
    if (response.statusCode == 404) return null;
    return User.fromJson(jsonDecode(response.body));
  }
}
```

### Extension Types (Dart 3)
```dart
extension type UserId(int value) { factory UserId.parse(String s) => UserId(int.parse(s)); }
extension type Email(String value) { bool get isValid => value.contains('@'); }
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **`late` as lazy init workaround**: Design proper initialization
- ≉ **Deep inheritance (>3 levels)**: Prefer composition/mixins
- ≉ **`dynamic` type**: Use specific types; `Object?` if truly unknown
- ≉ **`print()` for logging**: Use `package:logging`

## Compliance Checklist

- ! dartdoc on all public API
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Unit + widget tests; ≥80% coverage
- ! `dart format` + `dart analyze` with strict options enforced
- ! Effective Dart conventions; sound null safety; `final`/`const` by default
- ! Sealed classes for exhaustive hierarchies; pattern matching
- ⊗ `!` without check, fire-and-forget Futures, `dynamic`, business logic in `build()`
- ! Run `task check` before commit
