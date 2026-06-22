# TUI Agent Guidelines

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Scope:** Terminal User Interfaces (TUIs) with interactive components, event handling, layout management.

## Framework Selection

**Python Projects:**
- ! Use Textual (https://textual.textualize.io/)
- Rich integration, reactive system, CSS-like styling, component model
- Examples: process monitors, log viewers, configuration tools, dev dashboards

**TypeScript/JavaScript Projects:**
- ! Use ink (https://github.com/vadimdemedes/ink)
- React-like component model, hooks, JSX/TSX support
- Examples: CLI installers, build watchers, interactive prompts

**Other Languages:**
- Rust: ratatui + crossterm
- Go: bubbletea + lipgloss

## Core Architecture

**Component Structure:**
- ! Single responsibility per component
- ! Composable widgets (App → Screens → Widgets → Primitives)
- ! Clear separation: UI logic vs business logic
- ~ Keep components <150 lines; split if larger

**State Management:**
- ! Reactive data binding (Textual reactive properties, ink useState/useReducer)
- ! Centralized state for shared data
- ! Immutable updates (return new state, don't mutate)
- ⊗ Global mutable state outside framework

**Event Handling:**
- ! Framework event system (Textual `on_*` methods, ink hooks)
- ! Async event handlers for I/O operations
- ! Debounce high-frequency events (key repeats, resize)
- ~ Command pattern for complex actions

## Textual-Specific (Python)

**Components:**
- ! Inherit from `Widget`, `Screen`, or primitives (`Static`, `Button`, `Input`, `DataTable`, etc.)
- ! Use `reactive` for reactive properties: `count = reactive(0)`
- ! Implement lifecycle methods: `compose()`, `on_mount()`, `on_show()`

**Styling:**
- ! CSS-like styling in `*.tcss` files or inline
- ! Use design tokens for consistency: `$primary`, `$surface`, etc.
- ! Responsive layouts: `grid`, `horizontal`, `vertical` containers
- ~ Dark/light theme support via CSS variables

**Async Patterns:**
- ! Use `async def` for I/O operations
- ! Workers for background tasks: `self.run_worker(task, exclusive=True)`
- ! Timers for periodic updates: `self.set_interval(1.0, self.update)`
- ⊗ Blocking operations in event handlers

**Key Bindings:**
```python
BINDINGS = [
    Binding("q", "quit", "Quit"),
    Binding("ctrl+c", "quit", "Quit", show=False),
]
```

## ink-Specific (TypeScript)

**Components:**
- ! Functional components with hooks
- ! `useState` for local state, `useReducer` for complex state
- ! `useEffect` for side effects (cleanup on unmount)
- ! `useInput` for key handling

**Layout:**
- ! Flexbox-based layout via `<Box>` component
- ! Props: `flexDirection`, `justifyContent`, `alignItems`, `padding`, `margin`
- ! `<Text>` for content, `<Newline>` for line breaks
- ~ Use `<Static>` for non-interactive output above interactive UI

**Hooks Pattern:**
```typescript
const [state, setState] = useState(initialState);
useEffect(() => { /* setup */ return () => { /* cleanup */ }; }, [deps]);
useInput((input, key) => { if (key.escape) process.exit(0); });
```

**Rendering:**
- ! Use `render(<App />)` from ink
- ! `waitUntilExit()` for async CLIs
- ⊗ Multiple render calls to same stdout

## Performance

**Rendering:**
- ! Throttle updates (max 30-60 FPS): `@throttle(0.033)` (Textual) or debounce (ink)
- ! Virtual scrolling for large lists (Textual `DataTable`, ink custom)
- ~ Lazy loading for expensive components
- ⊗ Re-render entire tree on every state change

**Data Handling:**
- ! Paginate or stream large datasets
- ! Background workers for heavy computation
- ~ Memoize expensive calculations (ink `useMemo`)
- ⊗ Load unbounded data into memory

## Testing

See testing.md for universal requirements (! ≥85% coverage, fuzzing, integration tests).

**Textual Testing:**
```python
async def test_app():
    app = MyApp()
    async with app.run_test() as pilot:
        await pilot.press("j", "j", "k")  # Simulate keys
        assert app.query_one("#status").renderable == "Expected"
        await pilot.click("#button")
```

**ink Testing:**
- Use `ink-testing-library` or snapshot tests
- Render component, check output string, simulate stdin
```typescript
const {lastFrame, stdin} = render(<App />);
expect(lastFrame()).toContain("Welcome");
stdin.write("j"); // Simulate keypress
```

**Integration:**
- ! Test full user workflows (navigation, input, output)
- ! Test error states (network failures, invalid input)
- ~ Snapshot tests for layout regression detection
- ⊗ Unit test UI without framework test harness

## Error Handling

**Display:**
- ! User-friendly error messages in UI (modal, notification, status bar)
- ! Log technical details to file (don't dump stack traces in TUI)
- ! Recoverable errors: show message, continue
- ! Fatal errors: show message, wait for keypress, exit gracefully

**Patterns:**
```python
# Textual
try:
    await risky_operation()
except Exception as e:
    self.notify(f"Error: {e}", severity="error")
    log.exception("Detailed error")
```
```typescript
// ink
try {
  await riskyOperation();
} catch (error) {
  setError(error.message); // Display in UI
  console.error(error); // Log to stderr
}
```

## Accessibility

- ! Keyboard navigation for all interactive elements
- ! Clear focus indicators (highlight, border change)
- ! ARIA-like labels for screen reader compatibility (Textual has some support)
- ~ Support standard shortcuts: Tab (next), Shift+Tab (prev), Enter (activate), Esc (cancel)
- ~ Configurable key bindings

## Commands & Tasks

```bash
task tui:dev          # ! Dev mode with hot reload
task tui:run          # Run TUI app
task tui:test         # Run TUI tests (≥85% coverage)
task tui:console      # Console for debugging (Python/Textual only)
```

## Best Practices

**Design:**
- ! Responsive to terminal resize events
- ! Graceful degradation for small terminals (min width/height checks)
- ~ Consistent color scheme (use theme/design tokens)
- ~ Status bar for context (current mode, help hints)
- ≉ Assume 80x24 terminal without checking

**User Experience:**
- ! Instant visual feedback for user actions
- ! Loading indicators for async operations
- ! Help screen (show key bindings, context-sensitive help)
- ~ Exit confirmation for destructive actions
- ⊗ Silent failures (always show feedback)

**Code Organization:**
```
src/
├── app.py|tsx           # Main app component
├── screens/             # Top-level screens
├── widgets/             # Reusable widgets
├── styles.tcss          # Textual styles (Python)
├── theme.ts             # Theme constants (TypeScript)
└── __tests__/           # Tests
```

## Anti-Patterns

⊗ Blocking I/O in render or event handlers → use async/workers
⊗ Direct terminal manipulation (print, ANSI codes) → use framework
⊗ Polling for state changes → use reactive/event-driven patterns
⊗ Hardcoded layouts → use flexible containers
⊗ Unhandled exceptions in UI code → wrap in try/catch, show errors
⊗ Testing by manual inspection only → automate with framework test tools

## Documentation

! Add to README.md:
- Framework choice (Textual or ink)
- `task tui:dev` for development
- `task tui:run` to launch
- Key bindings reference
- Screenshot or demo GIF

## References

**Textual:**
- Docs: https://textual.textualize.io/
- Widget reference: https://textual.textualize.io/widget_gallery/
- Tutorial: https://textual.textualize.io/tutorial/

**ink:**
- Docs: https://github.com/vadimdemedes/ink
- Components: https://github.com/vadimdemedes/ink#built-in-components
- Testing: https://github.com/vadimdemedes/ink-testing-library

**Examples:**
- Textual: https://github.com/Textualize/textual/tree/main/examples
- ink: https://github.com/vadimdemedes/ink/tree/master/examples
