# Deploy via Git Integration

Deploy to Netlify using Git integration with GitHub, GitLab, or Bitbucket. Automatic deploys on every push.

## Quick Start

1. Connect repository in Netlify dashboard
2. Configure build settings  
3. Push to trigger automatic deployment

## Build Configuration

```toml
# netlify.toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "18"
```

## References

- [Git Integration Documentation](https://docs.netlify.com/site-deploys/create-deploys/)
