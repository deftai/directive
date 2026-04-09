# Python Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also** (load only when needed):
- [../main.md](../main.md) - General AI guidelines
- [../PROJECT.md](../PROJECT.md) - For project-specific overrides
- [../coding/testing.md](../coding/testing.md) - When writing tests

**Stack**: Python 3.11+, pytest; Web: Flask/FastAPI; CLI: typer[all]; TUI: textual[dev]

## Standards

### Documentation
- ! PEP 257 docstrings for all public APIs

### Testing
See [../coding/testing.md](../coding/testing.md) for universal requirements.

- ! Use pytest + pytest-cov + pytest-mock
- Files: `test_*.py` or `*_test.py`

### Coverage
- ! ≥85% coverage
- ! Count src/\*
- ! Exclude entry points, scripts, generated code

### Style
- ! Follow PEP 8 via ruff + black + isort

### Type Hints
- ! Use PEP 484 type hints on all functions/methods
- ! Pass mypy strict mode

### Data Validation
- ~ Use Pydantic BaseModel for data crossing module/API boundaries
- ⊗ Raw dicts/lists for shared, persisted, or returned data
- ~ Use `strict=True`, `extra='forbid'` for data models
- ~ Use `frozen=True` for immutable shared data
- ~ Layered validation: type constraints → field validators → model validators
- ! Swarm/parallel work: strict + frozen mandatory

## Commands

See [commands.md](./commands.md).

## Patterns

### Testing
**Parametrize**: `@pytest.mark.parametrize("a,b",[(1,2)])`, add `ids=[]` for names
**Fixtures**: `@pytest.fixture; yield val; cleanup()` for setup/teardown
**HTTP**: Flask: `app.test_client()`; FastAPI: `TestClient(app)`
**Mock**: `mocker.patch("mod.X")` or `@patch("mod.X")`
**Class**: `@pytest.fixture(autouse=True)` in class for shared setup
**Property Testing**: `hypothesis` for property-based tests
**Factories**: `pydantic-factories` for test data generation

### Data Models
**Pydantic BaseModel**:
```python
from pydantic import BaseModel, ConfigDict, Field, field_validator

class User(BaseModel):
    model_config = ConfigDict(
        strict=True,        # ! Type coercion off
        extra='forbid',     # ! Reject unknown fields
        frozen=True,        # ~ Immutable (recommended for shared data)
    )
    
    id: int = Field(..., gt=0)
    username: str = Field(..., min_length=3, max_length=32)
    
    @field_validator('username')
    @classmethod
    def validate_username(cls, v: str) -> str:
        if not v.isalnum():
            raise ValueError("username must be alphanumeric")
        return v
```

**Immutable Functional Style**:
```python
def process_order(order: Order) -> ProcessedOrder:
    # Immutable transformation
    data = order.model_dump()
    # ... pure transformations ...
    return ProcessedOrder(**data)
```

### Performance

**Validation:**
- ~ Use `model_validate_json()` over `json.loads()` + `model_validate()` (faster)
- ~ Reuse `TypeAdapter` instances for repeated validations
- ~ Use `fail_fast=True` on sequences to short-circuit bad items (Pydantic 2.8+)
- ~ Move heavy validators to Field constraints for hot paths

**Extreme Performance:**
- ? Consider `msgspec` for extreme perf needs (but prefer Pydantic for most)

**Telemetry:**
- See [../tools/telemetry.md](../tools/telemetry.md) for recommendations
- ~ Structured logging (structlog) for production
- ~ Sentry.io for error tracking
- ? logfire or OpenTelemetry for distributed tracing

## pyproject.toml

```toml
[project]
requires-python=">=3.11"
dependencies=["flask>=3.0.0"]  # or fastapi/typer[all]/textual[dev]
[dependency-groups]  # PEP 735 — uv syncs these by default
dev=["pytest>=7.4","pytest-cov>=4.1","pytest-mock>=3.12","hypothesis>=6.0","black>=23","isort>=5.12","ruff>=0.1","mypy>=1.7","pydantic>=2.0"]
[project.optional-dependencies]
prod=["pydantic>=2.0","logfire>=0.1"]  # ~ Observability for production
[tool.pytest.ini_options]
testpaths=["tests"]
python_files=["test_*.py","*_test.py"]
addopts="--cov=src --cov-report=html --cov-report=term-missing"
[tool.coverage.run]
omit=["*/tests/*","*/venv/*","*/.venv/*"]
[tool.coverage.report]
fail_under=85
[tool.black]
line-length=100
[tool.isort]
profile="black"
line_length=100
[tool.ruff]
line-length=100
select=["E","F","W","I","N","UP","B","A","C4","DTZ","T10","PIE","PT","RET","SIM"]
[tool.mypy]
python_version="3.11"
warn_return_any=true
warn_unused_configs=true
disallow_untyped_defs=true
```

## Compliance Checklist

- ! Follow PEP 257 (docstrings) and PEP 484 (type hints)
- ! See [../coding/testing.md](../coding/testing.md) for testing requirements
- ~ Use Pydantic for data validation
- ! Run `task check` before commit
