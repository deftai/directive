# AWS Deployment Module

Deft guidance for deploying applications to Amazon Web Services.

## Status

- ! Optional module
- ~ Good for Deft usage

## Overview

AWS offers comprehensive deployment options from serverless to full infrastructure control.

## Deployment Methods

| File | Method | Best For |
|------|--------|----------|
| `via-lambda.md` | AWS Lambda / SAM | Serverless functions, event-driven APIs (default for serverless) |
| `via-app-runner.md` | AWS App Runner | Simple containerized web apps, minimal configuration (default for containers) |
| `via-ecs-fargate.md` | ECS Fargate | Production containers, complex apps, full orchestration |
| `via-elastic-beanstalk.md` | Elastic Beanstalk | Traditional PaaS, multi-language support, managed infrastructure |

## Quick Decision Guide

- **Default serverless**: `via-lambda.md` — SAM or Serverless Framework for functions and APIs
- **Default containers**: `via-app-runner.md` — simplest path from code/image to HTTPS endpoint
- **Complex containers**: `via-ecs-fargate.md` — when you need load balancers, VPC, advanced orchestration
- **Traditional apps**: `via-elastic-beanstalk.md` — PaaS for Python, Node.js, Java, .NET, PHP, Ruby, Go

## References

- [AWS Deployment Options](https://aws.amazon.com/products/compute/)
- [AWS Lambda Documentation](https://docs.aws.amazon.com/lambda/)
- [AWS App Runner Documentation](https://docs.aws.amazon.com/apprunner/)
- [AWS Elastic Beanstalk Documentation](https://docs.aws.amazon.com/elasticbeanstalk/)
- [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/)
- [AWS EKS Documentation](https://docs.aws.amazon.com/eks/)
- [AWS Amplify Documentation](https://docs.amplify.aws/)
