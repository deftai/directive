# Deploy via Cloud Functions

Deploy serverless functions using Google Cloud Functions. Event-driven compute with automatic scaling.

## Quick Start

```bash
# Deploy HTTP function
gcloud functions deploy myfunction \
  --runtime python311 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point hello_world

# Deploy event-driven function
gcloud functions deploy myfunction \
  --runtime nodejs18 \
  --trigger-topic my-topic
```

## References

- [Cloud Functions Documentation](https://cloud.google.com/functions/docs)
