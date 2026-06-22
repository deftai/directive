# Deploy via Google Kubernetes Engine (GKE)

Deploy containerized applications using GKE. Managed Kubernetes with Google Cloud integration.

## Quick Start

```bash
# Create cluster
gcloud container clusters create mycluster \
  --zone us-central1-a \
  --num-nodes 3

# Get credentials
gcloud container clusters get-credentials mycluster \
  --zone us-central1-a

# Deploy application
kubectl apply -f deployment.yaml
```

## References

- [GKE Documentation](https://cloud.google.com/kubernetes-engine/docs)
