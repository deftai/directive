# Deploy via Vercel API

Deploy to Vercel using the REST API for custom automation and programmatic deployments.

## Quick Start

```bash
curl -X POST https://api.vercel.com/v13/deployments \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "myapp", "gitSource": {"type": "github", "repo": "user/repo"}}'
```

## References

- [API Documentation](https://vercel.com/docs/rest-api)
