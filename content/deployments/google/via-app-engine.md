# Deploy via App Engine

Deploy applications using Google App Engine. Fully managed PaaS with automatic scaling, load balancing, and monitoring.

## Overview

App Engine provides:
- **Managed Platform**: Zero infrastructure management
- **Auto-scaling**: Automatic traffic-based scaling
- **Multiple Runtimes**: Python, Java, Node.js, Go, PHP, Ruby
- **Built-in Services**: Memcache, Task Queue, Cron
- **Traffic Splitting**: Gradual rollouts

## Quick Start

```bash
# Deploy application
gcloud app deploy

# View application
gcloud app browse
```

## app.yaml Configuration

```yaml
runtime: python311

instance_class: F2

automatic_scaling:
  min_instances: 1
  max_instances: 10
  target_cpu_utilization: 0.65

env_variables:
  APP_ENV: "production"
```

## References

- [App Engine Documentation](https://cloud.google.com/appengine/docs)
