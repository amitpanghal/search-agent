# ADR: Deployment and infrastructure

Status: current
Last verified: 2026-10-01 against eb4aae8

## Purpose
Run the agent as one container on AWS ECS Fargate (behind CloudFront in dev, a load balancer in production),
with the model key in a secret store and stdout shipped to CloudWatch. No database, no disk, no build
step. Render remains the POC host for demos.

## Input and output
- In: the repo at a commit, an OpenAI key in Parameter Store, the AWS account and VPC.
- Out (dev): `https://<distribution>.cloudfront.net` serving `POST /query`, with one log group.
- Out (production, planned): `https://<domain>` on a load balancer, with alarms.

## How it works
1. Image (`Dockerfile`): `node:24-slim`, production dependencies only, `src/` and `catalogData/` copied
   in, run as the `node` user, `tsx` runs the TypeScript directly. Prompts and catalogs sit at the repo
   layout inside the image. `--build-arg COMMIT` stamps the commit on every log record. Built for arm64.
2. `.dockerignore` keeps `.env`, git, docs, scripts, planning and scratch out of the build context.
3. Task definition (`deploy/task-definition.dev.json`): Fargate, 0.5 vCPU, 1 GB, arm64, port 3000,
   `LLM_PROVIDER=openai` with the model and its prices as environment, the key as a secret from
   `/search-agent/dev/OPENAI_API_KEY`, logs to `/ecs/search-agent-dev` via the awslogs driver.
4. Network (dev): the DevApex Sandbox account, its own VPC with two public subnets and no NAT gateway; the task
   has a public IP so it reaches OpenAI and the feed. Its security group accepts port 3000 only from
   CloudFront's prefix list.
5. Edge (dev): CloudFront serves HTTPS on its own `*.cloudfront.net` certificate and forwards over HTTP straight
   to the task's public DNS name on port 3000; no load balancer. Caching off, every viewer header but Host
   passed on (the CORS preflight needs them), origin response timeout 60 seconds, keep-alive 4 seconds (below
   Node's 5-second idle close). No WAF in dev: a spending limit on the dev OpenAI project caps a runaway client.
   Production puts a WAF (per-IP rate rule, IP reputation list, bot control) on its load balancer.
6. Roles: an execution role with the ECS task execution policy plus `ssm:GetParameters` on the one
   parameter.
7. Redeploy is a new push and "force new deployment". Rollback is a task definition revision naming the
   previous image tag.

Region `eu-north-1`; names and steps in `docs/DEPLOY-DEV.md` (as built) and `docs/DEPLOY-PROD.md` (planned).
Dev is manual console work plus one `docker push`; production deploys through CI.

Render (`render.yaml`): a free web service in Frankfurt on `npm start` with Bedrock credentials entered in
the dashboard. `GET /` exists so a keepalive pinger stops the free instance from sleeping.

## Key decisions and why
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
  Dev skips the WAF's monthly fee and relies on a spending limit on its OpenAI project.
- **Images tagged by git sha.** Rollback is a revision change, not a rebuild.

## Invariants
- The log record's `commit` is set on every deploy; null means the build skipped the build argument.
- The eval gate must pass on the exact image sha before a production go-live (`docs/DEPLOY-PROD.md` checklist).

## Limits
- Production is planned, not built: private subnets with NAT, no public IP, immutable tags, two tasks over
  two zones, WAF bot control, 90-day retention, alarms, CI/CD with manual approval, and a guardrails task for
  operator ids and quotas.
- Dev: the app is down after every task restart (redeploy, crash) until CloudFront's origin is re-pointed to the
  new task. The CloudFront → task hop is plain HTTP, any CloudFront distribution can reach the task (the
  prefix list is shared), and there is no rate limit: the OpenAI spending limit is the only cap.
- Open decisions: production account and domain, CI system, who provisions the VPC, final model provider.
- The two CloudWatch alarms from the logging design are not wired yet.

## Where to look
- `Dockerfile`, `.dockerignore`, `deploy/task-definition.dev.json`, `render.yaml`; the runbooks in
  `docs/DEPLOY-DEV.md` and `docs/DEPLOY-PROD.md`; alarms and retention in `planning/logging.md`.
- Related: api, logging, catalogs.
