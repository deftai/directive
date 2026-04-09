# Go Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [telemetry.md](../tools/telemetry.md)

## Standards

### Documentation
- ! Follow [go.dev/doc/comment](https://go.dev/doc/comment)
- ! All exported symbols have doc comments (complete sentences)

### Testing
See [testing.md](../coding/testing.md).

- ! Use Testify (assert/require)
- Files: `*_test.go`, functions: `TestFuncName(t *testing.T)`

### Coverage
- ! ≥85% coverage
- ! Count internal/\* + pkg/\*
- ! Exclude entry points, utilities, generated code

### Telemetry
- See [telemetry.md](../tools/telemetry.md)
- ~ Structured logging (zerolog) for production
- ~ Sentry.io for error tracking
- ? OpenTelemetry for distributed tracing

## Commands

See [commands.md](./commands.md).

## 🔧 Patterns

**Table-Driven Tests**:

```go
tests := []struct{name string; input, want Type; wantErr bool}{
    {"case1", input1, want1, false},
    {"error", input2, want2, true},
}
for _, tt := range tests {
    t.Run(tt.name, func(t *testing.T) {
        got, err := Fn(tt.input)
        if tt.wantErr { assert.Error(t, err); return }
        assert.NoError(t, err)
        assert.Equal(t, tt.want, got)
    })
}
```

**HTTP**: `w := httptest.NewRecorder(); req, _ := http.NewRequest("GET", "/path", nil); handler.ServeHTTP(w, req); assert.Equal(t, http.StatusOK, w.Code)`

**Interface**: Define consumer-side, mock with function fields

## Compliance Checklist

- ! Follow go.dev/doc/comment for all exported symbols
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! Run `task check` before commit
