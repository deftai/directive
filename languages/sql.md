# SQL Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md)

**Stack**: ANSI SQL (dialect-agnostic defaults); Adapts to: PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, Oracle; Migrations: Flyway / Liquibase / framework-native; Lint: sqlfluff

## Standards

### Documentation
- ! Comment every non-trivial query, view, function, and stored procedure
- ! Document purpose, parameters, and return values for stored procedures/functions
- ! Include a data dictionary or schema docs for every database
- ~ Use inline comments (`--`) for clause-level explanations in complex queries

### Testing
See [testing.md](../coding/testing.md).

- ! Test migrations up and down (rollback)
- ! Test stored procedures, functions, and triggers with known inputs/outputs
- ~ Use test fixtures or seed data scripts for reproducible integration tests
- ~ Test edge cases: NULLs, empty sets, boundary values, large datasets

### Style & Formatting
- ! UPPERCASE for SQL keywords: `SELECT`, `FROM`, `WHERE`, `JOIN`, `INSERT`, `UPDATE`
- ! Lowercase for identifiers (tables, columns, aliases): `users`, `created_at`
- ! One clause per line for readability (`SELECT`, `FROM`, `WHERE`, `JOIN` each on own line)
- ! Indent continuation lines (subqueries, `AND`/`OR`, `CASE` branches)
- ! Use sqlfluff (or equivalent) for automated linting
- ! Line length ≤120 characters
- ~ Align `ON` clauses vertically when multiple joins are present

### Naming Conventions
- ! `snake_case` for all identifiers: tables, columns, indexes, constraints
- ! Singular nouns for table names: `user`, `order`, `product` (not `users`, `orders`)
- ! Descriptive column names: `created_at`, `is_active`, `total_amount`
- ! Prefix boolean columns with `is_`, `has_`, or `can_`: `is_active`, `has_shipped`
- ! Name primary keys `id` or `{table}_id`; foreign keys `{referenced_table}_id`
- ! Name indexes: `ix_{table}_{column(s)}`
- ! Name constraints: `pk_{table}`, `fk_{table}_{ref_table}`, `uq_{table}_{column}`, `ck_{table}_{rule}`
- ⊗ Reserved words as identifiers (even if quoted)
- ⊗ Abbreviations in names unless universally understood (`id`, `url`, `ip`)

### Queries
- ! Use explicit column lists — ⊗ `SELECT *` in application code or views
- ! Use explicit `JOIN` syntax — ⊗ implicit joins (comma-separated `FROM`)
- ! Qualify column names with table aliases in multi-table queries
- ! Use short, meaningful aliases: `u` for `user`, `o` for `order`
- ! Use `COALESCE()` over vendor-specific null functions (`NVL`, `IFNULL`) where portable
- ~ Use CTEs (`WITH`) for complex queries instead of deeply nested subqueries
- ~ Use `EXISTS` over `IN` for correlated subqueries (better optimizer hints)
- ≉ `SELECT DISTINCT` to mask duplicate-producing joins — fix the join instead
- ≉ `ORDER BY` column position (`ORDER BY 1, 2`) — use column names

### Parameterization & Security
- ! Use parameterized queries / prepared statements for all dynamic values
- ⊗ String concatenation for query building (SQL injection vector)
- ⊗ Interpolating user input directly into SQL
- ! Validate and sanitize inputs at the application layer before query execution
- ! Apply least-privilege: application accounts get only required permissions
- ~ Use row-level security (RLS) where supported for multi-tenant data

### Schema Design
- ! Every table has a primary key
- ! Use appropriate data types: don't store dates as strings, money as floats, etc.
- ! Define foreign key constraints for referential integrity
- ! Add `NOT NULL` constraints where business logic requires a value
- ! Add `CHECK` constraints for domain validation (e.g., `CHECK (quantity >= 0)`)
- ~ Normalize to 3NF minimum; denormalize deliberately with documentation
- ~ Add `created_at` and `updated_at` timestamps to mutable tables
- ~ Use `UUID` or `BIGINT` for primary keys (prefer `UUID` for distributed systems)
- ≉ Store JSON blobs where relational columns would serve better
- ⊗ Use `FLOAT`/`DOUBLE` for monetary values — use `DECIMAL`/`NUMERIC`

### Indexing
- ! Index all foreign key columns
- ! Index columns used in `WHERE`, `JOIN`, `ORDER BY` if query frequency justifies it
- ! Review and document index strategy per table
- ~ Use composite indexes that match query patterns (leftmost prefix rule)
- ~ Use partial/filtered indexes for frequently queried subsets
- ≉ Over-index: each index adds write overhead — justify with query patterns
- ⊗ Index every column "just in case"

### Migrations
- ! Use versioned, sequential migration files (not ad-hoc DDL)
- ! Every migration must be reversible (up + down)
- ! Test migrations against a copy of production schema before deploying
- ! Use transactions for DDL where supported (PostgreSQL)
- ~ Use idempotent migrations (`IF NOT EXISTS`, `IF EXISTS`) for resilience
- ⊗ Modify or delete previously applied migration files

### Transactions & Concurrency
- ! Use explicit transactions for multi-statement operations
- ! Keep transactions as short as possible
- ! Choose appropriate isolation level for the use case
- ~ Use `SELECT ... FOR UPDATE` when reading rows that will be updated
- ⊗ Long-running transactions that hold locks across user interactions
- ⊗ Implicit autocommit for multi-step business operations

### Performance
- ! Use `EXPLAIN` / `EXPLAIN ANALYZE` to validate query plans for critical queries
- ! Avoid N+1 query patterns — use joins or batch queries
- ! Paginate large result sets (`LIMIT`/`OFFSET` or keyset pagination)
- ~ Prefer keyset pagination (`WHERE id > ?`) over `OFFSET` for large tables
- ~ Use materialized views or caching for expensive, infrequently-changing aggregations
- ≉ Functions on indexed columns in `WHERE` clauses (defeats index usage)
- ⊗ Cartesian joins (missing `ON` / `WHERE` clause)
- ⊗ Unbounded `SELECT` without `LIMIT` on large tables in application code

### Stored Procedures & Functions
- ~ Keep business logic in the application layer; use procedures for data-intensive ops
- ! Document parameters, return types, and side effects
- ! Handle errors explicitly (`RAISE` / `SIGNAL` / `THROW`)
- ⊗ Deeply nested stored procedure call chains (hard to debug and test)

### Telemetry
- ~ Log slow queries (configure slow query log threshold)
- ~ Monitor index usage and table bloat
- ? Use query tagging (comments with trace IDs) for distributed tracing

## Commands

```bash
task db:migrate          # Run pending migrations
task db:rollback         # Roll back last migration
task db:seed             # Load seed/fixture data
task db:reset            # Drop, create, migrate, seed
task db:lint             # Lint SQL with sqlfluff (or `task sql:lint`)
task db:format           # Format SQL with sqlfluff fix (or `task sql:fmt`)
task db:schema           # Dump current schema
task quality             # All quality checks
```

**Note**: Single-language projects ! use generic names. Multi-language projects ! use namespaced names. See [taskfile.md](../tools/taskfile.md#naming-conventions).

## Patterns

### Parameterized Query (Application Code)
```sql
-- CORRECT: parameterized
SELECT id, email, created_at
FROM user
WHERE email = $1
  AND is_active = TRUE;

-- Framework equivalent (pseudocode):
-- db.query("SELECT id, email FROM user WHERE email = $1", [user_email])
```

### CTE for Readability
```sql
WITH active_orders AS (
    SELECT o.user_id, COUNT(*) AS order_count, SUM(o.total_amount) AS total_spent
    FROM order AS o
    WHERE o.status = 'active'
      AND o.created_at >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY o.user_id
)
SELECT u.id, u.email, ao.order_count, ao.total_spent
FROM user AS u
INNER JOIN active_orders AS ao ON ao.user_id = u.id
WHERE ao.total_spent > 100.00
ORDER BY ao.total_spent DESC;
```

### Migration (Flyway-style)
```sql
-- V2__add_user_preferences.sql

-- Up
CREATE TABLE IF NOT EXISTS user_preference (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES user (id) ON DELETE CASCADE,
    key         VARCHAR(100) NOT NULL,
    value       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_preference_key UNIQUE (user_id, key)
);

CREATE INDEX ix_user_preference_user_id ON user_preference (user_id);

-- Down (in separate file or rollback section)
-- DROP TABLE IF EXISTS user_preference;
```

### Keyset Pagination
```sql
-- Efficient pagination for large tables (avoids OFFSET scan)
SELECT id, email, created_at
FROM user
WHERE created_at < $1   -- last seen timestamp
  AND id < $2            -- tiebreaker
ORDER BY created_at DESC, id DESC
LIMIT 25;
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **`HAVING` without `GROUP BY`**: Use `WHERE` for row-level filters
- ≉ **Nested subqueries >2 levels deep**: Refactor with CTEs
- ≉ **`NOT IN` with nullable columns**: Use `NOT EXISTS` instead (NULL semantics)

## Compliance Checklist

- ! Parameterized queries for all user-facing data access
- ! Explicit column lists, explicit `JOIN` syntax, qualified column names
- ! Primary key on every table; foreign keys with constraints
- ! Versioned migrations; tested up and down
- ! `EXPLAIN ANALYZE` reviewed for high-traffic queries
- ! sqlfluff lint passes; keywords uppercase, identifiers lowercase `snake_case`
- ⊗ `SELECT *`, implicit joins, string concatenation in queries, `FLOAT` for money
- ! Run `task db:lint` before commit
