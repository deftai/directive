# Deploy via Multi-Region

Deploy your applications globally across Fly.io's 30+ regions for low latency, high availability, and disaster recovery. Run close to your users worldwide.

## Overview

Fly.io makes global deployment simple:
- **30+ Regions**: Deploy worldwide with one command
- **Automatic Routing**: Users connect to nearest region
- **Built-In Load Balancing**: Distribute traffic intelligently
- **Data Replication**: Keep data close to users
- **Disaster Recovery**: Automatic failover between regions

## Available Regions

### North America
- `iad` - Ashburn, Virginia (US East)
- `ord` - Chicago, Illinois
- `dfw` - Dallas, Texas
- `sea` - Seattle, Washington  
- `sjc` - San Jose, California
- `lax` - Los Angeles, California
- `yyz` - Toronto, Canada
- `ewr` - Secaucus, NJ (US East)

### Europe
- `lhr` - London, United Kingdom
- `ams` - Amsterdam, Netherlands
- `fra` - Frankfurt, Germany
- `cdg` - Paris, France
- `mad` - Madrid, Spain
- `waw` - Warsaw, Poland
- `arn` - Stockholm, Sweden

### Asia Pacific
- `nrt` - Tokyo, Japan
- `hkg` - Hong Kong
- `sin` - Singapore
- `syd` - Sydney, Australia
- `bom` - Mumbai, India
- `scl` - Santiago, Chile

### South America
- `gru` - São Paulo, Brazil
- `scl` - Santiago, Chile

### Africa & Middle East
- `jnb` - Johannesburg, South Africa

## Quick Start

### View Available Regions

```bash
# List all Fly.io regions
fly platform regions

# Output shows code, name, and gateway status
```

### Deploy to Multiple Regions

```bash
# Deploy initial app
fly launch

# Add regions
fly regions add lhr  # London
fly regions add nrt  # Tokyo
fly regions add syd  # Sydney

# Scale to run in all regions
fly scale count 3 --region iad,lhr,syd
```

### Check Current Deployment

```bash
# List app regions
fly regions list

# Show all instances
fly status --all

# See which regions have instances
fly scale show
```

## Configuration

### Set Primary Region

```toml
# fly.toml
app = "my-global-app"
primary_region = "iad"  # Primary region for writes

[env]
  PRIMARY_REGION = "iad"
```

```bash
# Set via CLI
fly regions set iad --primary
```

### Configure Backup Regions

```bash
# Add backup regions for failover
fly regions backup lhr ord
```

### Region Groups

```toml
# fly.toml - Deploy to region groups
[regions]
  primary = "iad"
  backup = ["ord", "dfw"]
```

## Scaling Strategies

### Uniform Distribution

```bash
# Deploy equal instances to each region
fly scale count 6 --region iad,lhr,nrt,syd

# Results in:
# - 2 instances in IAD
# - 2 instances in LHR  
# - 1 instance in NRT
# - 1 instance in SYD
```

### Weighted Distribution

```bash
# More instances in high-traffic regions
fly scale count 3 --region iad  # 3 in US East
fly scale count 2 --region lhr  # 2 in London
fly scale count 1 --region syd  # 1 in Sydney
```

### Auto-Scaling Per Region

```toml
# fly.toml
[autoscaling]
  min_machines_running = 1
  max_machines_running = 10

# This applies per region
# With 3 regions: min 3, max 30 total instances
```

## Data and State Management

### Stateless Applications

```toml
# fly.toml for stateless apps
app = "stateless-api"
primary_region = "iad"

# No volumes needed
# All regions serve traffic equally

[[services]]
  internal_port = 8080
  protocol = "tcp"
  
  [[services.ports]]
    handlers = ["http"]
    port = 80
```

### Distributed Databases

```bash
# Create multi-region Postgres
fly postgres create --region iad,lhr,syd

# Attach to app
fly postgres attach my-postgres-app

# Automatic read replicas in each region
```

### Volumes and Persistent Storage

```bash
# Create volumes in each region
fly volumes create data --region iad --size 10
fly volumes create data --region lhr --size 10
fly volumes create data --region syd --size 10

# Fly will place instances with their volumes
fly scale count 3
```

```toml
# fly.toml with volumes
[mounts]
  source = "data"
  destination = "/data"

# One instance per volume
```

### Redis at the Edge

```bash
# Use Upstash Redis for multi-region caching
fly redis create

# Automatically replicates globally
```

## Routing and Load Balancing

### Anycast Routing

Fly.io uses Anycast - users automatically connect to nearest region:

```
User in UK → Routes to LHR
User in US → Routes to IAD
User in Japan → Routes to NRT
```

No configuration needed!

### Internal Routing

```toml
# fly.toml
[private_network]
  name = "my-app-net"

# Instances can communicate across regions
# via .internal DNS (e.g., my-app.internal)
```

### Sticky Sessions

```toml
# fly.toml
[[services]]
  internal_port = 8080
  
  [[services.ports]]
    handlers = ["http"]
    port = 80
    
  # Enable sticky sessions
  [services.concurrency]
    type = "connections"
    hard_limit = 200
    soft_limit = 100
    
  [services.http_options.response]
    [services.http_options.response.headers]
      fly-force-instance-id = "true"  # Sticky sessions
```

## High Availability Patterns

### Active-Active (Multi-Region Writes)

```toml
# All regions serve reads and writes
app = "active-active-app"
primary_region = "iad"

# Use conflict-free data structures (CRDTs)
# Or database with multi-master replication
```

```bash
# Deploy to all regions
fly regions add iad lhr syd nrt
fly scale count 8
```

### Active-Passive (Read Replicas)

```bash
# Primary region for writes
fly regions set iad --primary

# Secondary regions for reads only
fly regions add lhr syd --backup

# Application routes writes to primary
# Reads can go to any region
```

### Regional Failover

```toml
# fly.toml
[deploy]
  strategy = "rolling"
  
  [deploy.max_unavailable]
    count = 1  # Only take down one instance at a time

[[services]]
  [[services.tcp_checks]]
    interval = "15s"
    timeout = "2s"
    grace_period = "5s"
    restart_limit = 3  # Auto-restart on failure
```

## Database Strategies

### Fly Postgres Multi-Region

```bash
# Create Postgres with replicas
fly postgres create \
  --name my-db \
  --region iad,lhr,syd \
  --initial-cluster-size 3

# Attach to application
fly postgres attach my-db

# Automatic failover enabled
```

### LiteFS for SQLite

```toml
# fly.toml with LiteFS for distributed SQLite
[mounts]
  source = "litefs"
  destination = "/var/lib/litefs"

[env]
  LITEFS_CLOUD_TOKEN = "your-token"

# SQLite replicated across regions
```

### External Database with Replicas

```bash
# Use external database with read replicas
fly secrets set DATABASE_URL=postgres://primary...
fly secrets set READ_REPLICA_IAD=postgres://replica-iad...
fly secrets set READ_REPLICA_LHR=postgres://replica-lhr...

# App routes based on FLY_REGION environment variable
```

## Latency Optimization

### Check Latency Between Regions

```bash
# From your local machine
fly ping my-app.fly.dev

# Between regions (from running instance)
fly ssh console -C "curl -w '%{time_total}' https://my-app.internal/health"
```

### Optimal Region Selection

```javascript
// In your application
const FLY_REGION = process.env.FLY_REGION;

// Route to nearest database replica
const databaseUrl = process.env[`DATABASE_${FLY_REGION.toUpperCase()}`] 
  || process.env.DATABASE_URL;
```

### CDN and Asset Caching

```toml
# fly.toml - Cache static assets
[[services]]
  [[services.ports]]
    handlers = ["http"]
    port = 80
    
  [services.http_options]
    compress = true
    
  [services.http_options.response.headers]
    Cache-Control = "public, max-age=31536000"
```

## Monitoring Multi-Region Deployments

### View Status Across Regions

```bash
# See all instances by region
fly status --all

# JSON output for scripting
fly status --json | jq '.allocations[] | {region, status}'
```

### Regional Metrics

```bash
# Open Grafana dashboard
fly dashboard

# Filter by region in Grafana
```

### Logs from Specific Region

```bash
# Filter logs by region
fly logs --region iad

# View logs from all regions
fly logs
```

## Disaster Recovery

### Automatic Failover

```bash
# Fly automatically routes around failed instances
# No configuration needed

# View failover events
fly events
```

### Manual Region Removal

```bash
# Remove unhealthy region
fly regions remove iad

# Traffic automatically routes to other regions

# Re-add when healthy
fly regions add iad
fly scale count 3 --region iad
```

### Backup and Recovery

```bash
# Snapshot volumes in each region
fly volumes snapshots create VOLUME_ID

# Restore in different region if needed
fly volumes create data --snapshot-id SNAPSHOT_ID --region lhr
```

## Cost Optimization

### Region Selection

```bash
# Deploy only to regions you need
# More regions = more cost

# Start with primary market
fly regions add iad  # US customers

# Add as needed
fly regions add lhr  # European customers
fly regions add syd  # Asia-Pacific customers
```

### Instance Scaling

```bash
# Run minimum instances
fly scale count 1 --region iad  # Primary
fly scale count 0 --region lhr  # Only scale up when needed

# Use autoscaling
fly autoscale set min=1 max=10
```

## Best Practices

1. **Start Small**: Begin with 1-2 regions, expand based on traffic
2. **Choose Primary Wisely**: Primary region near main database
3. **Monitor Latency**: Track response times per region
4. **Use Read Replicas**: Keep reads local, centralize writes
5. **Health Checks**: Ensure automatic failover works
6. **Test Failover**: Regularly test disaster recovery
7. **Cache Aggressively**: Reduce database queries
8. **Use Private Network**: For inter-region communication
9. **Monitor Costs**: Watch per-region resource usage
10. **Deploy in Waves**: Roll out to one region at a time

## Common Patterns

### Global Read, Regional Write

```javascript
// Route writes to primary region
if (operation === 'write') {
  const primaryUrl = process.env.PRIMARY_DATABASE_URL;
  await database.connect(primaryUrl).write(data);
} else {
  // Reads from local replica
  const localReplica = process.env[`DATABASE_${FLY_REGION}`];
  return await database.connect(localReplica).read();
}
```

### Active-Active with Conflict Resolution

```javascript
// Use CRDTs or timestamp-based resolution
const writeToAllRegions = async (data) => {
  data.timestamp = Date.now();
  data.region = FLY_REGION;
  
  // Write locally
  await localDB.save(data);
  
  // Replicate to other regions asynchronously
  replicateToRegions(data);
};
```

### Region-Specific Configuration

```toml
# fly.toml
[env]
  LOG_LEVEL = "info"

[processes]
  web = "node server.js"

# Override per region if needed via secrets
# fly secrets set CONFIG_IAD=value --region iad
```

## Troubleshooting

### Uneven Traffic Distribution

```bash
# Check instance health
fly status --all

# Restart unhealthy instances
fly restart --region iad

# Check health checks
fly checks list
```

### High Latency in Specific Region

```bash
# Test from that region
fly ssh console --region lhr -C "curl localhost:8080/health"

# Check database connection
fly ssh console --region lhr -C "ping database.internal"

# Consider adding database replica in that region
```

### Instance Not Starting in Region

```bash
# Check events
fly events --region iad

# View detailed status
fly status --json | jq '.allocations[] | select(.region=="iad")'

# Try manual allocation
fly scale count 2 --region iad
```

## References

- [Fly.io Regions](https://fly.io/docs/reference/regions/)
- [Multi-Region Postgres](https://fly.io/docs/postgres/high-availability-and-global-replication/)
- [LiteFS for SQLite](https://fly.io/docs/litefs/)
- [Anycast Routing](https://fly.io/docs/reference/anycast/)
- [Private Networking](https://fly.io/docs/reference/private-networking/)
