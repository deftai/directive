# Telemetry Standards

Logging, tracing, metrics, and error tracking for production systems.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Scope:** Observability, monitoring, and debugging across all modes.

**⚠️ See also**: [main.md](../../main.md) | [coding.md](../coding/coding.md)

## Mode-Specific Requirements

### fun Mode (Learning/Prototyping)

**Logging:**
- ? Use print() or basic logging
- ? Structured logging optional

**Error Tracking:**
- ? Optional

**Tracing:**
- ? Optional

**Metrics:**
- ? Optional

### fast Mode (Development - Default)

**Logging:**
- ~ Structured logging (structlog, loguru, zerolog)
- ~ Log levels: DEBUG, INFO, WARN, ERROR
- ~ Include context: timestamp, level, message, request_id

**Error Tracking:**
- ~ Use Sentry.io or equivalent
- ~ Sample rate: 10-50% in dev, 100% errors
- ~ Capture stack traces

**Tracing:**
- ? Optional for debugging
- ~ Use for complex workflows

**Metrics:**
- ~ Basic metrics (request count, latency)
- ? Custom business metrics

### pro Mode (Production)

**Logging:**
- ! Structured logging mandatory
- ! Log levels: INFO, WARN, ERROR (⊗ DEBUG in production)
- ! Include: timestamp, level, message, trace_id, span_id, user_id, request_id
- ! Log rotation and retention policy

**Error Tracking:**
- ! Sentry.io or equivalent mandatory
- ! Sample rate: 100% errors, 10-20% transactions
- ! Release tracking and source maps
- ! User feedback integration

**Tracing:**
- ! Distributed tracing (OpenTelemetry, logfire, Sentry)
- ! Instrument critical paths
- ! Trace sampling: 1-10% in production
- ! Include: service name, operation name, duration, tags

**Metrics:**
- ! RED metrics (Rate, Error, Duration)
- ! System metrics (CPU, memory, disk)
- ! Business metrics (orders, users, revenue)
- ! Alerting on SLOs/SLIs

## Recommended Tools

**Structured Logging:**
- Python: logfire (pro), structlog (fast/pro), loguru (fast)
- Go: zerolog, zap
- TypeScript: pino, winston
- C++: spdlog

**Error Tracking:**
- Sentry.io (all languages, all modes)
- Rollbar, Bugsnag (alternatives)

**Tracing:**
- OpenTelemetry (all languages, pro mode)
- logfire (Python, pro mode)
- Sentry (all languages, fast/pro mode)

**Metrics:**
- Prometheus (self-hosted)
- Datadog, New Relic (SaaS)
- OpenTelemetry metrics

## Logging Best Practices

**Structure:**
- ! JSON format for machine parsing
- ! Human-readable format for development
- ! Consistent field names across services

**Content:**
- ! Include context: timestamp, level, logger name, message
- ~ Include identifiers: user_id, request_id, trace_id, span_id
- ~ Include metadata: environment, version, host
- ⊗ Log sensitive data (PII, secrets, passwords)

**Levels:**
- **DEBUG**: Detailed diagnostic information (fun/fast only)
- **INFO**: General informational messages
- **WARN**: Warning messages, potentially harmful situations
- **ERROR**: Error events, but application continues
- **FATAL**: Severe errors causing shutdown

**Examples:**
```python
# Good
log.info("order_created", order_id=order.id, user_id=user.id, total=order.total)

# Bad
log.info(f"Order {order.id} created by {user.email} for ${order.total}")  # Not structured
log.debug(f"Password: {password}")  # Sensitive data
```

## Tracing Best Practices

**Span Naming:**
- ! Use verb + noun: `process_order`, `validate_user`, `fetch_data`
- ! Include operation type: `http.request`, `db.query`, `cache.get`
- ⊗ Generic names: `process`, `handle`, `do_work`

**Span Attributes:**
- ~ Add business context: order_id, user_id, amount
- ~ Add technical context: http.method, http.status_code, db.statement
- ~ Add errors: error=true, error.message, error.type
- ⊗ Add sensitive data

**Sampling:**
- ! Sample strategically to control costs
- ~ 100% errors, 1-10% success in production
- ~ Higher rate for critical paths
- ? Adaptive sampling based on latency

## Metrics Best Practices

**RED Metrics (Mandatory in pro):**
- **Rate**: Requests per second
- **Error**: Error rate (%)
- **Duration**: Latency (p50, p95, p99)

**Naming:**
- ! Use descriptive names: `http_requests_total`, `order_processing_duration_seconds`
- ! Include units: `_seconds`, `_bytes`, `_total`
- ! Use labels for dimensions: method, status, endpoint

**Types:**
- **Counter**: Monotonically increasing (requests, errors)
- **Gauge**: Current value (memory, queue depth)
- **Histogram**: Distribution (latency, size)
- **Summary**: Similar to histogram (p50, p95, p99)

## Error Tracking

**What to Track:**
- ! All unhandled exceptions
- ! Explicit error captures (validation failures, business logic errors)
- ~ Performance issues (slow queries, timeouts)
- ~ User feedback (bug reports, feature requests)

**Context:**
- ! Stack trace
- ! Request data (sanitized)
- ! User context (ID, not PII)
- ! Environment (version, host, OS)
- ~ Breadcrumbs (previous events)

**Sentry Configuration:**
```python
import sentry_sdk

sentry_sdk.init(
    dsn="https://...@sentry.io/...",
    environment="production",
    release="my-app@1.2.3",
    traces_sample_rate=0.1,
    profiles_sample_rate=0.1,
    before_send=sanitize_data,  # ! Remove PII
)
```

## Integration Patterns

**Context Propagation:**
- ! Propagate trace_id and span_id across service boundaries
- ! Use W3C Trace Context headers
- ! Include trace_id/span_id in logs for correlation

**Alerting:**
- ! Alert on error rate spikes
- ! Alert on latency degradation (p95 > threshold)
- ! Alert on critical business metrics
- ~ Use runbooks for common issues

## Anti-Patterns

- ⊗ Logging in tight loops (performance impact)
- ⊗ Logging sensitive data (PII, secrets, passwords)
- ⊗ Using string formatting instead of structured logging
- ⊗ No sampling in high-traffic production (cost explosion)
- ⊗ Ignoring errors silently
- ⊗ Missing context (no trace_id, request_id)
- ⊗ Generic span/metric names
- ⊗ Over-instrumenting (trace everything)

## Mode Decision Matrix

| Feature | fun | fast | pro |
|---------|-----|------|-----|
| Structured Logging | ? | ~ | ! |
| Error Tracking | ? | ~ | ! |
| Distributed Tracing | ? | ? | ! |
| Metrics (RED) | ? | ~ | ! |
| Log Rotation | ? | ~ | ! |
| Alerting | ? | ? | ! |
| PII Sanitization | ? | ~ | ! |
| Source Maps | ? | ~ | ! |
| Release Tracking | ? | ~ | ! |

## Testing Telemetry

**Development:**
- ~ Use local exporters (console, file)
- ~ Test with sampling=1.0
- ~ Verify context propagation

**Staging:**
- ~ Mirror production config
- ~ Test alerting thresholds
- ~ Validate dashboards

**Production:**
- ! Gradual rollout of telemetry changes
- ! Monitor telemetry overhead (<5% CPU)
- ! Validate data quality

## LLM-specific observability (#481)

LLM applications carry observability needs that conventional request/response tracing does not address. Poisoning, prompt drift, output schema regressions, and token-budget exhaustion are invisible to standard logging unless the prompt and response are captured verbatim and the model + token telemetry is recorded alongside the call. This section extends the general telemetry guidance for projects that call LLM APIs (see [../patterns/llm-app.md](../patterns/llm-app.md) for the full LLM-application standards; this section is the observability slice).

**Per-call audit log (mandatory in pro mode; recommended in fast mode):**
- ! Log every LLM call: model identifier, prompt hash, response hash, latency, token count (input + output), tool calls invoked
- ! Store prompt/response pairs in a queryable audit log, separate from application logs — application logs carry pointers/hashes only; the audit log carries the verbatim content
- ! Log tool invocations alongside the LLM call that produced them so the audit trail `(prompt -> response -> tool call -> outcome)` is recoverable as a single chain
- ⊗ MUST NOT log raw secrets or PII that leaked into the prompt; redact at log-write time, not at log-read time (the general `⊗ Log sensitive data` rule applies equally to LLM audit logs)

**Token budget tracking:**
- ~ Track token budgets per session and per user — budget exhaustion is a denial-of-service vector AND a cost-attack vector
- ~ Emit a metric on every LLM call: `llm_tokens_total{model, kind="input|output", user_id, session_id}`
- ~ Alert on per-user token spikes (anomaly detection on the distribution; a sudden 10x in tokens/hour for one user is a probe signal)

**Latency histograms per model/prompt variant:**
- ~ Record latency as a histogram dimensioned by `{model, prompt_variant}` so a slow-down on one prompt template is visible without polluting the model-wide aggregate
- ~ Track p50/p95/p99 separately for streaming vs. non-streaming calls (streaming p99 is end-of-first-token; non-streaming p99 is end-of-full-response — conflating them hides regressions)

**Evaluation harness logging:**
- ~ Record evaluation-harness results in the audit log so output quality can be tracked over time (regression detection on the model output distribution, not just the application's behavior)
- ~ Tag each eval run with the prompt-template version and the model identifier so a quality regression can be traced to either a prompt edit or a provider model update

**Anomaly detection on output distributions:**
- ~ Track output-length distribution per prompt variant; a sudden shift (longer outputs, shorter outputs, or higher variance) is a probe signal worth investigating
- ~ Track refusal-rate per prompt variant; an unexpected refusal-rate change typically points at a provider-side policy update or a prompt drift
- ~ Alert when a deployed prompt template diverges from the reviewed baseline (the **prompt drift detector**); a code review approved one prompt, a runtime change to that prompt without review is a regression signal

**Cross-references:**
- [../patterns/llm-app.md](../patterns/llm-app.md) `## LLM-specific observability` -- the full standards body this section anchors to
- [../coding/coding.md](../coding/coding.md) `## Calling LLM APIs (#481)` -- short addendum cross-linking the patterns file

## References

- OpenTelemetry: https://opentelemetry.io/
- Sentry.io: https://sentry.io/
- logfire: https://pydantic.dev/logfire
- structlog: https://www.structlog.org/
- zerolog: https://github.com/rs/zerolog
