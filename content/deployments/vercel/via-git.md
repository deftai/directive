# Deploy via Git Integration

Deploy to Vercel using Git integration with GitHub, GitLab, or Bitbucket. Automatic deployments and preview URLs.

## Quick Start

1. Import project in Vercel dashboard
2. Configure framework preset
3. Push to deploy automatically

## Configuration

```json
// vercel.json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite"
}
```

## References

- [Git Integration Documentation](https://vercel.com/docs/deployments/git)
