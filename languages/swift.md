# Swift Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

**Stack**: Swift 5.9+/6.0+, SwiftPM; iOS: SwiftUI/UIKit; CLI: ArgumentParser; Testing: Swift Testing/XCTest

## Standards

### Documentation
- ! Follow [Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)
- ! Use Swift Markup comments (triple-slash `///`) for all public APIs
- ~ Document complexity of computed properties that are not O(1)

### Testing
See [testing.md](../coding/testing.md).

- ! Use Swift Testing (`@Test`, `#expect`) for new tests (Swift 6+)
- ~ Use XCTest for UI tests, performance tests, and legacy codebases
- Files: `*Tests.swift` or `*_Tests.swift`

### Coverage
- ! ≥85% coverage
- ! Count Sources/\*
- ! Exclude entry points, generated code, previews

### Style
- ! Use SwiftLint + SwiftFormat
- ! Column limit: 100 characters
- ! Follow [Google Swift Style Guide](https://google.github.io/swift/) or [Kodeco Style Guide](https://github.com/kodecocodes/swift-style-guide)

### Types
- ! Prefer `let` over `var` when value won't change
- ! Use strong typing (enums, type aliases, protocols)
- ⊗ Force unwrap (`!`) unless absolutely necessary
- ~ Use `guard let`/`if let` for optional unwrapping
- ~ Prefer `Result` or throwing functions for error handling

### Concurrency
- ! Use Swift Concurrency (`async`/`await`) over GCD for new code
- ! Use `actor` for shared mutable state
- ! Use `@MainActor` for UI-related code
- ~ Use `Sendable` to mark thread-safe types
- ⊗ Use `@unchecked Sendable` without careful consideration
- ~ Enable strict concurrency checking (`SWIFT_STRICT_CONCURRENCY=complete`)

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging (OSLog, swift-log) for production
- ~ Sentry.io for error tracking
- ? OpenTelemetry Swift for distributed tracing

## Commands

See [commands.md](./commands.md).

## Patterns

### Testing
```swift
// Swift Testing
@Test("login succeeds") func loginSuccess() async throws {
    let result = try await AuthService().login(email: "test@a.com", password: "valid")
    #expect(result.isSuccess)
}

@Test("prices", arguments: [(100, 0.1, 90), (200, 0.25, 150)])
func price(p: Int, d: Double, e: Int) { #expect(calculatePrice(p, discount: d) == e) }

// XCTest
final class UserTests: XCTestCase {
    var sut: UserService!
    override func setUp() { super.setUp(); sut = UserService() }
    override func tearDown() { sut = nil; super.tearDown() }
    func test_fetchUser() async throws {
        let user = try await sut.fetchUser(id: "123")
        XCTAssertEqual(user.name, "Test User")
    }
}
```

### Concurrency & Error Handling
```swift
actor Counter {
    private var value = 0
    func increment() -> Int { value += 1; return value }
}

@MainActor class ViewModel: ObservableObject {
    @Published var data: [Item] = []
    func loadData() async { data = await fetchItems() }
}

func fetchAll() async throws -> (User, [Post]) {
    async let user = fetchUser(); async let posts = fetchPosts()
    return try await (user, posts)
}

func loadConfig() throws -> Config {
    guard let data = FileManager.default.contents(atPath: path) else { throw ConfigError.fileNotFound(path) }
    return try JSONDecoder().decode(Config.self, from: data)
}
```

### Data Models
```swift
struct User: Codable, Sendable, Equatable { let id: UUID; let name: String; let email: String }
enum LoadingState<T: Sendable>: Sendable { case idle, loading, success(T), failure(Error) }
```

## Package.swift

Key settings: `swift-tools-version: 5.9`, platforms `.iOS(.v17)/.macOS(.v14)`, enable `StrictConcurrency`.

## Linter/Formatter Config

**`.swiftlint.yml`** key settings:
- Opt-in: `force_unwrapping`, `implicitly_unwrapped_optional`, `explicit_init`, `fatal_error_message`, `modifier_order`, `yoda_condition`
- Limits: line 120/150, type body 300/500, file 500/1000, function 50/100
- Excluded: `.build`, `DerivedData`, `Pods`, `Package.swift`

**`.swiftformat`** key settings:
- `--swiftversion 5.9`, `--indent 4`, `--maxwidth 100`
- `--wrapcollections before-first`, `--wraparguments before-first`
- Enabled: `isEmpty`, `redundantSelf`, `sortImports`, `trailingCommas`

## Compliance Checklist

- ! Follow Swift API Design Guidelines for all public APIs
- ! Use Swift Markup comments for documentation
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Use SwiftLint and SwiftFormat
- ! Use Swift Concurrency (`async`/`await`, `actor`) for async code
- ⊗ Force unwrap optionals without justification
- ! Run `task check` before commit
