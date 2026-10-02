# ADR: Deployment and infrastructure

Status: current — built
Date: 2026-10-02
Component record: [components/deployment.md](../components/deployment.md)

## Context
Run the agent as one container on AWS ECS Fargate (behind CloudFront in dev, a load balancer in production),
with the model key in a secret store and stdout shipped to CloudWatch. No database, no disk, no build
step. Render remains the POC host for demos.

## Decisions
- **No build step.** The container runs the same command as `npm start`; what runs in the container is
  what runs locally.
- **Catalogs ship in the image.** The feed cannot be reached from CI, so the committed catalogs are the
  source.
- **Secrets from Parameter Store, never from env files.** The key is read at task start by the execution
  role; `.env` never enters the build context.
- **Public IP without NAT in dev only.** Cheap and enough while the security group limits ingress.
- **CloudFront for HTTPS in dev.** The dev account has no hosted zone or certificate, and its other apps use
  CloudFront's own address. The frontend is an https page, which may not call an http API (mixed content), and
  CloudFront gives HTTPS without a domain.
- **No load balancer in dev.** It is a fixed monthly cost for one task. The price is that the task's address
  changes on every restart and CloudFront's origin is re-pointed by hand; production has a load balancer.
- **60-second CloudFront response timeout (300-second ALB idle timeout in production).** An SSE answer can take
  several seconds between events, and the stream sends no heartbeat.
- **WAF as the cost guard in production, a spending limit in dev.** Every query spends model tokens; a rate
  rule per IP is the guard against a script running up the bill, and IP restriction is impossible in production.
  Dev skips the WAF's monthly fee and relies on a spending limit at the model provider.
- **Images tagged by git sha.** Rollback is a revision change, not a rebuild.

## Related
- Related: api, logging, catalogs.
