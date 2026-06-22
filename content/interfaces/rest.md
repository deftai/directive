# REST API Design

Resource-based, stateless, standard HTTP methods, JSON by default.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Core Architecture

REST APIs are resource-based, stateless, and use standard HTTP methods with JSON as the default format. Design resources as nouns, use HTTP verbs for operations, and maintain strict statelessness with token-based authentication.

## URIs

- ! Use nouns, ⊗ use verbs (`/products` not `/getProducts`)
- ~ Use plural nouns for collections (`/users` not `/user`)
- ! Lowercase with hyphens (⊗ underscores)
- ~ Limit nesting to 1-2 levels; beyond that use query params
- ! Use reserved chars correctly: `/` hierarchy, `?` queries, `#` fragments

```
GET /products                     # Collection
GET /products/123                 # Single resource
GET /products/123/reviews         # Nested (max 2 levels)
GET /products?category=electronics&sort=price  # Filtering/sorting
```

## HTTP Methods

! Use methods per RFC 7231/9110 semantics:

- **GET**: Retrieve (idempotent, safe, cacheable)
- **POST**: Create (not idempotent)
- **PUT**: Replace entire resource (idempotent)
- **PATCH**: Partial update (not idempotent)
- **DELETE**: Remove (idempotent)
- **HEAD**: Headers only (idempotent, safe, cacheable)
- **OPTIONS**: Allowed methods (idempotent, safe)

```
GET /users/123              # Retrieve
POST /users                 # Create
PUT /users/123              # Replace
PATCH /users/123            # Update fields
DELETE /users/123           # Remove
```

## Status Codes

! Use standard HTTP status codes (RFC 7231):

**2xx Success**:
- ! `200 OK` for successful GET/PUT/PATCH
- ! `201 Created` for POST; ~ include Location header
- ~ `204 No Content` for DELETE or PUT with no body

**3xx Redirection**:
- ? `301 Moved Permanently`, `304 Not Modified` as appropriate

**4xx Client Error**:
- ! `400 Bad Request` for malformed/validation errors
- ! `401 Unauthorized` for missing/invalid auth
- ! `403 Forbidden` for authenticated but not authorized
- ! `404 Not Found` for nonexistent resource
- ? `422 Unprocessable Entity` for semantic errors

**5xx Server Error**:
- ~ `500 Internal Server Error` for generic errors
- ~ `502 Bad Gateway` for upstream failure
- ! `503 Service Unavailable` for temporary unavailability

## Request/Response

- ! Use JSON (`application/json`) by default
- ? Support other formats via content negotiation

```http
POST /users
Content-Type: application/json
{"name": "Alice", "email": "alice@example.com"}

HTTP/1.1 201 Created
Location: /users/456
{"id": 456, "name": "Alice", "email": "alice@example.com"}
```

**Error format**:
```json
{"error": {"code": "VALIDATION_ERROR", "message": "...", "details": [...]}}
```

## Statelessness

- ! Be stateless; each request contains all needed info
- ⊗ Maintain client session state on server
- ! Use token auth in headers: `Authorization: Bearer <token>`
- ! Client manages its own state
- ⊗ Use session cookies for state

## Collections

~ Support filtering, sorting, pagination for collections:

- **Filtering**: `?category=electronics&brand=apple`
- **Sorting**: `?sort=price` (asc), `?sort=-price` (desc)
- **Pagination**: `?page=2&size=20` (~ page-based; offset-based optional)
- ~ Include metadata: `{"data": [...], "page": 2, "total": 450, "links": {...}}`

## Versioning

- ! Implement versioning from day one
- URI: `/v1/products` (most common)
- Header: `API-Version: 2` (cleaner)
- Content negotiation: `Accept: application/vnd.example.v2+json` (purist)
- ~ Follow semantic versioning: vMAJOR.MINOR.PATCH
- ! Give 6-12 months deprecation notice; ! document migration path

## Caching

~ Use HTTP cache headers (RFC 9111) for cacheable resources:

- **Cache-Control**: `Cache-Control: public, max-age=3600, must-revalidate`
- **ETag**: `ETag: "abc123"` + conditional `If-None-Match` → `304 Not Modified`
- **Last-Modified**: `Last-Modified` + conditional `If-Modified-Since`
- Only GET/HEAD may be cached; ⊗ cache POST/PUT/DELETE

## Security

**Transport**:
- ! Public APIs use HTTPS; local/internal APIs may use HTTP

**Authentication**:
- ! Public APIs implement auth; ~ local APIs implement auth; prototypes may defer initially
- ~ OAuth 2.0 for user auth, JWT for stateless, API keys for service-to-service

**Authorization**:
- ~ Implement RBAC

**Security Headers**:
- ~ Include: `Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`

**Input Validation**:
- ! Validate all inputs (type, format, range)
- ! Sanitize to prevent SQL injection, XSS
- ~ Use allow-lists; ≉ rely on deny-lists alone

**Rate Limiting** (~ implement):
- `X-RateLimit-*` headers; ~ sliding window; ! return `429 Too Many Requests`

## Performance

- ~ Support compression: `Accept-Encoding: gzip, brotli`
- ? Support sparse fieldsets: `?fields=id,name,email`
- ~ Large resources support Range requests: `206 Partial Content`
- ~ Long-running tasks use async pattern: POST → `201` + Location → GET status

## Documentation

- ! Provide comprehensive documentation; ~ use OpenAPI/Swagger
- ! Include: all endpoints, schemas, auth methods, error codes, rate limits, versioning, changelog
- ? Use tools: Swagger UI, ReDoc, or Postman

## HATEOAS

? Implement HATEOAS (hypermedia links guide navigation):

```json
{"id": 123, "links": [
  {"rel": "self", "href": "/products/123"},
  {"rel": "reviews", "href": "/products/123/reviews"}
]}
```

Trade-off: flexibility vs response size

## Testing

See [testing.md](../coding/testing.md) for universal requirements.

- ! Unit tests: individual endpoints, edge cases
- ! Integration tests: full workflows, realistic scenarios
- ~ Load tests: JMeter, Gatling, k6
- ! Security tests: SQL injection, XSS, auth bypass (OWASP ZAP, Burp Suite)

## Monitoring

- ! Implement monitoring; ~ track: uptime, response times, error rates, request volume, rate limits, auth failures
- ~ Use correlation IDs (`X-Request-ID`) for tracing

## Anti-patterns

- ⊗ Verbs in URIs (`/getUsers`)
- ⊗ Non-standard status codes (`200 OK` with error in body)
- ⊗ Session state on server
- ⊗ Different data types from same endpoint
- ⊗ Deep nesting (`/a/1/b/2/c/3/d/4`)
- ⊗ Ignoring HTTP method semantics
- ⊗ No versioning from start
- ⊗ Exposing internal DB structure directly

## Summary

1. ! Resources as nouns, HTTP methods as verbs
2. ! JSON for requests/responses
3. ! Stateless with token auth
4. ! Standard HTTP status codes
5. ! Version from day one
6. ~ Filter, sort, paginate collections
7. ~ Cache with ETags/Cache-Control
8. ! HTTPS for public APIs
9. ~ Rate limit
10. ! Document with OpenAPI
11. ! Test: unit, integration, security
12. ! Monitor health, performance, usage
