# Deploy via Azure Kubernetes Service (AKS)

Deploy containerized applications using Azure Kubernetes Service. Managed Kubernetes with integrated Azure services, auto-scaling, and advanced orchestration.

## Overview

AKS provides managed Kubernetes:
- **Managed Control Plane**: Azure handles K8s master nodes
- **Integrated Services**: Azure Monitor, Container Registry, Key Vault
- **Auto-scaling**: Cluster and pod autoscaling
- **Security**: Azure AD integration, RBAC, network policies
- **Cost Optimization**: Multiple node pools, spot instances

## Prerequisites

- Azure account with subscription
- Azure CLI installed
- kubectl installed
- Docker for local development
- Container images in registry

## Quick Start

### 1. Install Tools

```bash
# Install kubectl
az aks install-cli

# Verify
kubectl version --client
```

### 2. Create AKS Cluster

```bash
# Create resource group
az group create --name myapp-rg --location eastus

# Create AKS cluster
az aks create \
  --resource-group myapp-rg \
  --name myapp-cluster \
  --node-count 2 \
  --enable-managed-identity \
  --generate-ssh-keys \
  --attach-acr myregistry

# Get credentials
az aks get-credentials \
  --resource-group myapp-rg \
  --name myapp-cluster
```

### 3. Deploy Application

```bash
# Create deployment
kubectl create deployment myapp \
  --image=myregistry.azurecr.io/myapp:latest

# Expose as service
kubectl expose deployment myapp \
  --type=LoadBalancer \
  --port=80 \
  --target-port=8080

# Check status
kubectl get services
```

## Kubernetes Manifests

### Deployment

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
      - name: myapp
        image: myregistry.azurecr.io/myapp:latest
        ports:
        - containerPort: 8080
        env:
        - name: APP_ENV
          value: "production"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
```

### Service

```yaml
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp
spec:
  type: LoadBalancer
  selector:
    app: myapp
  ports:
  - port: 80
    targetPort: 8080
```

### Ingress

```yaml
# ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: myapp
            port:
              number: 80
```

## ACR Integration

### Create and Configure ACR

```bash
# Create ACR
az acr create \
  --resource-group myapp-rg \
  --name myregistry \
  --sku Standard

# Build and push image
az acr build \
  --registry myregistry \
  --image myapp:latest \
  --file Dockerfile .

# Attach ACR to AKS
az aks update \
  --resource-group myapp-rg \
  --name myapp-cluster \
  --attach-acr myregistry
```

## Auto-scaling

### Horizontal Pod Autoscaler

```yaml
# hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

### Cluster Autoscaler

```bash
# Enable cluster autoscaler
az aks update \
  --resource-group myapp-rg \
  --name myapp-cluster \
  --enable-cluster-autoscaler \
  --min-count 1 \
  --max-count 5
```

## Helm Deployment

### Install Helm Chart

```bash
# Add Helm repo
helm repo add myrepo https://charts.example.com
helm repo update

# Install chart
helm install myapp myrepo/myapp \
  --set image.repository=myregistry.azurecr.io/myapp \
  --set image.tag=latest \
  --set replicaCount=3
```

### Create Custom Chart

```bash
# Create chart
helm create myapp

# Edit values.yaml, then install
helm install myapp ./myapp
```

## CI/CD with GitHub Actions

```yaml
# .github/workflows/aks-deploy.yml
name: Deploy to AKS

on:
  push:
    branches: [main]

env:
  AZURE_RESOURCE_GROUP: myapp-rg
  AKS_CLUSTER: myapp-cluster
  ACR_NAME: myregistry
  IMAGE_NAME: myapp

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}
      
      - name: Build and push to ACR
        run: |
          az acr build \
            --registry ${{ env.ACR_NAME }} \
            --image ${{ env.IMAGE_NAME }}:${{ github.sha }} \
            --file Dockerfile .
      
      - uses: azure/aks-set-context@v3
        with:
          resource-group: ${{ env.AZURE_RESOURCE_GROUP }}
          cluster-name: ${{ env.AKS_CLUSTER }}
      
      - uses: azure/k8s-deploy@v4
        with:
          manifests: |
            k8s/deployment.yaml
            k8s/service.yaml
          images: |
            ${{ env.ACR_NAME }}.azurecr.io/${{ env.IMAGE_NAME }}:${{ github.sha }}
```

## Monitoring

### Enable Azure Monitor

```bash
az aks enable-addons \
  --resource-group myapp-rg \
  --name myapp-cluster \
  --addons monitoring
```

### View Logs

```bash
# Pod logs
kubectl logs -f deployment/myapp

# All pods
kubectl logs -l app=myapp --all-containers=true
```

## Secrets Management

### Azure Key Vault Integration

```bash
# Enable Key Vault add-on
az aks enable-addons \
  --resource-group myapp-rg \
  --name myapp-cluster \
  --addons azure-keyvault-secrets-provider

# Create Key Vault
az keyvault create \
  --name myapp-kv \
  --resource-group myapp-rg \
  --location eastus
```

```yaml
# secretproviderclass.yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: azure-keyvault
spec:
  provider: azure
  parameters:
    keyvaultName: myapp-kv
    objects: |
      array:
        - |
          objectName: db-password
          objectType: secret
    tenantId: <tenant-id>
```

## Best Practices

1. **Use Namespaces**: Organize workloads
2. **Resource Limits**: Set requests and limits
3. **Health Checks**: Configure liveness and readiness probes
4. **Network Policies**: Control pod-to-pod traffic
5. **Use Helm**: Package and version deployments
6. **Enable Monitoring**: Azure Monitor for containers
7. **RBAC**: Use Azure AD integration
8. **Multiple Node Pools**: Separate workload types
9. **Spot Instances**: Save costs for non-critical workloads
10. **GitOps**: Use Flux or ArgoCD

## Troubleshooting

```bash
# Check cluster health
az aks show \
  --resource-group myapp-rg \
  --name myapp-cluster

# Node issues
kubectl get nodes
kubectl describe node <node-name>

# Pod issues
kubectl get pods
kubectl describe pod <pod-name>
kubectl logs <pod-name>
```

## Cost Optimization

```bash
# Use Standard tier for production
# Enable cluster autoscaler
# Use spot node pools for dev/test
# Right-size node VMs
# Scale to zero during off-hours
```

## References

- [AKS Documentation](https://docs.microsoft.com/azure/aks/)
- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [Helm Documentation](https://helm.sh/docs/)
- [AKS Best Practices](https://docs.microsoft.com/azure/aks/best-practices)
