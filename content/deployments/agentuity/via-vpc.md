# Deploy via Private VPC / On-Premises

Deploy Agentuity agents to your own infrastructure for maximum control, security, and compliance. Run in your private cloud, VPC, or on-premises data center with the same Agentuity developer experience.

## Overview

Agentuity supports deployment to:
- **Private VPC**: AWS VPC, Azure VNet, GCP VPC
- **On-Premises**: Your own data centers
- **Hybrid**: Mix of cloud and on-prem
- **Air-Gapped**: Completely disconnected environments

All using the same SDK, same CLI, same developer experience as Agentuity Cloud.

## Use Cases

- **Enterprise Security**: Keep data within your security perimeter
- **Regulatory Compliance**: Meet data residency requirements (GDPR, HIPAA, SOC 2)
- **Data Sovereignty**: Ensure data never leaves specific geographic regions
- **Hybrid Architecture**: Connect cloud agents with on-prem data sources
- **Air-Gapped Environments**: Deploy in disconnected networks

## Prerequisites

### Infrastructure Requirements

- **Kubernetes Cluster**: K8s 1.24+ (EKS, AKS, GKE, or self-hosted)
- **Container Registry**: Private registry for agent images
- **Load Balancer**: For ingress traffic
- **Storage**: Persistent storage for agent state
- **Networking**: VPN or Direct Connect (for hybrid)

### Software Requirements

- `kubectl` configured for your cluster
- `helm` 3.0+ for chart installation
- Agentuity CLI installed
- Docker or container runtime

## Architecture

```
┌─────────────────────────────────────────┐
│         Your VPC / Data Center          │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │   Agentuity Control Plane         │  │
│  │   (Agent Management, Monitoring)  │  │
│  └──────────────────────────────────┘  │
│                 │                        │
│  ┌──────────────┴──────────────────┐   │
│  │   Agent Runtime Cluster          │   │
│  │  ┌─────┐  ┌─────┐  ┌─────┐      │   │
│  │  │Agent│  │Agent│  │Agent│      │   │
│  │  │  1  │  │  2  │  │  3  │      │   │
│  │  └─────┘  └─────┘  └─────┘      │   │
│  └──────────────────────────────────┘  │
│                 │                        │
│  ┌──────────────┴──────────────────┐   │
│  │   Built-in Services              │   │
│  │   (Storage, DB, Queue)           │   │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
         │
         ▼
  Agentuity Console
  (Optional, for monitoring)
```

## Deployment Methods

### Method 1: Helm Chart (Recommended)

#### 1. Add Agentuity Helm Repository

```bash
helm repo add agentuity https://charts.agentuity.com
helm repo update
```

#### 2. Create Values File

```yaml
# agentuity-values.yaml

# Deployment mode
mode: vpc  # or 'on-prem', 'hybrid'

# Cluster configuration
cluster:
  name: my-agentuity-cluster
  region: us-east-1  # For VPC deployments

# Agent runtime
runtime:
  replicas: 3
  resources:
    requests:
      memory: "2Gi"
      cpu: "1"
    limits:
      memory: "4Gi"
      cpu: "2"

# Storage configuration
storage:
  type: persistent  # or 's3', 'azure-blob', 'gcs'
  size: 100Gi
  storageClass: fast-ssd

# Database
database:
  type: postgres
  host: your-postgres.internal
  port: 5432
  database: agentuity
  # Credentials via secrets

# Networking
ingress:
  enabled: true
  className: nginx
  hosts:
    - agents.yourcompany.internal
  tls:
    enabled: true
    secretName: agentuity-tls

# Security
security:
  networkPolicy:
    enabled: true
  podSecurityPolicy:
    enabled: true
  rbac:
    enabled: true

# Monitoring
monitoring:
  prometheus:
    enabled: true
  grafana:
    enabled: true

# Agentuity Console connection (optional)
console:
  enabled: false  # Set true to connect to Agentuity Console
  endpoint: https://console.agentuity.com
  apiKey: ${AGENTUITY_API_KEY}
```

#### 3. Install Agentuity

```bash
# Create namespace
kubectl create namespace agentuity

# Install with Helm
helm install agentuity agentuity/agentuity \
  --namespace agentuity \
  --values agentuity-values.yaml

# Check installation
kubectl get pods -n agentuity
```

### Method 2: Terraform

```hcl
# main.tf

module "agentuity_vpc" {
  source = "agentuity/vpc-deployment/aws"
  version = "1.0.0"

  cluster_name = "agentuity-prod"
  vpc_id = aws_vpc.main.id
  subnet_ids = aws_subnet.private[*].id
  
  instance_type = "m5.xlarge"
  min_size = 3
  max_size = 10

  database_config = {
    engine = "postgres"
    instance_class = "db.r5.large"
    allocated_storage = 100
  }

  storage_config = {
    type = "ebs"
    size = 500
    iops = 3000
  }

  tags = {
    Environment = "production"
    ManagedBy = "terraform"
  }
}
```

```bash
terraform init
terraform plan
terraform apply
```

### Method 3: Docker Compose (Development/Single Node)

```yaml
# docker-compose.yml

version: '3.8'

services:
  agentuity-runtime:
    image: agentuity/runtime:latest
    ports:
      - "3500:3500"
    environment:
      - AGENTUITY_MODE=on-prem
      - DATABASE_URL=postgres://user:pass@postgres:5432/agentuity
      - REDIS_URL=redis://redis:6379
    volumes:
      - ./agents:/app/agents
      - agent-data:/data
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: agentuity
      POSTGRES_USER: agentuity
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  agent-data:
  postgres-data:
  redis-data:
```

```bash
docker-compose up -d
```

## Configuration

### Network Configuration

#### VPC Peering (AWS)

```bash
# Create VPC peering connection
aws ec2 create-vpc-peering-connection \
  --vpc-id vpc-agentuity \
  --peer-vpc-id vpc-production

# Update route tables
aws ec2 create-route \
  --route-table-id rtb-agentuity \
  --destination-cidr-block 10.0.0.0/16 \
  --vpc-peering-connection-id pcx-xxxxx
```

#### Private Link (AWS)

```yaml
# VPC Endpoint Service
privateLink:
  enabled: true
  serviceId: vpce-svc-xxxxx
  allowedPrincipals:
    - arn:aws:iam::123456789:root
```

#### VPN Configuration (On-Prem)

```bash
# Configure site-to-site VPN
# Connect on-prem network to Agentuity cluster
# Ensure proper routing for agent traffic
```

### Security Configuration

#### Network Policies

```yaml
# network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agentuity-agent-policy
  namespace: agentuity
spec:
  podSelector:
    matchLabels:
      app: agentuity-agent
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
      - podSelector:
          matchLabels:
            app: agentuity-gateway
      ports:
        - protocol: TCP
          port: 8080
  egress:
    - to:
      - podSelector:
          matchLabels:
            app: postgres
      ports:
        - protocol: TCP
          port: 5432
```

#### Service Mesh (Optional)

```bash
# Install Istio for advanced traffic management
istioctl install --set profile=default

# Enable for Agentuity namespace
kubectl label namespace agentuity istio-injection=enabled
```

### Storage Configuration

#### Persistent Volumes

```yaml
# pv.yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: agentuity-agent-storage
spec:
  capacity:
    storage: 100Gi
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  storageClassName: fast-ssd
  nfs:
    server: nfs.internal.company.com
    path: /exports/agentuity
```

## Agent Deployment

### Deploy Agent to VPC

```bash
# Configure CLI for VPC deployment
agentuity config set endpoint https://agents.yourcompany.internal
agentuity config set mode vpc

# Deploy agent
cd my-agent
agentuity deploy --target vpc

# Agent deploys to your VPC cluster
```

### Multi-Environment

```bash
# Configure multiple environments
agentuity config add-context production \
  --endpoint https://agents-prod.internal \
  --mode vpc

agentuity config add-context staging \
  --endpoint https://agents-staging.internal \
  --mode vpc

# Switch contexts
agentuity config use-context production

# Deploy
agentuity deploy
```

## Hybrid Deployment

### Cloud Control Plane + VPC Agents

```yaml
# agentuity.yaml
mode: hybrid

# Control plane in Agentuity Cloud
controlPlane:
  type: cloud
  endpoint: https://console.agentuity.com

# Agents run in your VPC
agentRuntime:
  type: vpc
  cluster: arn:aws:eks:us-east-1:123456789:cluster/agentuity
  
# Secure tunnel for communication
tunnel:
  type: wireguard
  endpoint: vpn.yourcompany.com
```

### Agent-to-Agent Communication

```typescript
// Agents in VPC can call agents in Cloud
import { createAgent } from '@agentuity/runtime';

const vpcAgent = createAgent('vpc-agent', {
  handler: async (ctx) => {
    // Call cloud-hosted agent
    const result = await ctx.callAgent('cloud-agent', {
      data: 'sensitive data stays in VPC'
    });
    return result;
  }
});
```

## Monitoring & Operations

### Observability

```yaml
# Enable observability stack
monitoring:
  prometheus:
    enabled: true
    retention: 30d
    
  grafana:
    enabled: true
    dashboards:
      - agentuity-agents
      - agentuity-infrastructure
      
  loki:
    enabled: true  # Log aggregation
    
  tempo:
    enabled: true  # Distributed tracing
```

### Alerts

```yaml
# alerts.yaml
groups:
  - name: agentuity-agents
    rules:
      - alert: HighAgentErrorRate
        expr: rate(agent_errors[5m]) > 0.05
        annotations:
          summary: "High error rate for {{ $labels.agent }}"
          
      - alert: AgentDown
        expr: up{job="agentuity-agent"} == 0
        for: 1m
        annotations:
          summary: "Agent {{ $labels.instance }} is down"
```

### Backup & Disaster Recovery

```bash
# Backup agent state
kubectl exec -n agentuity agentuity-0 -- \
  /opt/agentuity/bin/backup create

# Schedule automatic backups
kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: CronJob
metadata:
  name: agentuity-backup
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: agentuity/backup:latest
            args: ["--target", "s3://backups/agentuity"]
EOF
```

## Compliance & Security

### Data Residency

```yaml
# Ensure data stays in specific region
dataResidency:
  region: eu-west-1
  enforceStrict: true
  allowedRegions:
    - eu-west-1
    - eu-central-1
```

### Encryption

```yaml
# Enable encryption at rest
encryption:
  atRest:
    enabled: true
    provider: aws-kms  # or azure-keyvault, google-kms
    keyId: arn:aws:kms:...
    
  inTransit:
    enabled: true
    minTLSVersion: "1.3"
```

### Audit Logging

```yaml
# Enable comprehensive audit logs
auditLog:
  enabled: true
  destination: s3://audit-logs/agentuity
  events:
    - agent_deploy
    - agent_invoke
    - config_change
    - secret_access
```

## Troubleshooting

### Agent Won't Deploy

```bash
# Check cluster connectivity
kubectl cluster-info

# Verify Agentuity pods
kubectl get pods -n agentuity

# Check logs
kubectl logs -n agentuity deployment/agentuity-runtime

# Test network connectivity
kubectl run -it --rm debug --image=busybox --restart=Never -- \
  wget -O- http://agentuity-runtime:3500/health
```

### Performance Issues

```bash
# Check resource usage
kubectl top pods -n agentuity

# Scale up
kubectl scale deployment/agentuity-runtime \
  --replicas=5 -n agentuity

# Check database performance
kubectl exec -it postgres-0 -n agentuity -- \
  psql -c "SELECT * FROM pg_stat_activity;"
```

## Best Practices

1. **Network Isolation**: Use network policies to restrict traffic
2. **Secrets Management**: Use Vault or cloud secret managers
3. **Resource Limits**: Set appropriate CPU/memory limits
4. **Monitoring**: Enable comprehensive observability
5. **Backup**: Regular backups of agent state and config
6. **Updates**: Keep Agentuity runtime updated
7. **Documentation**: Document your VPC architecture

## Next Steps

- **Connect to Cloud Console**: Optional monitoring dashboard
- **Multi-Region**: Deploy across multiple regions
- **Disaster Recovery**: Set up DR environment
- **CI/CD**: See `via-github-actions.md` for automation
- **Multi-Cloud**: See `via-gravity-network.md` for multi-cloud

## References

- [VPC Deployment Guide](https://agentuity.dev/deployment/vpc)
- [Kubernetes Best Practices](https://agentuity.dev/deployment/kubernetes)
- [Security Hardening](https://agentuity.dev/security)
- [Enterprise Support](https://agentuity.com/enterprise)
