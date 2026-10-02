# Deployment and infrastructure

Component record: how this component works today. The decisions behind it: [adr/deployment.md](../adr/deployment.md).
Last verified: 2026-10-02 against 19912c9 (+ the DeepSeek switch)

## Purpose
Run the agent as one container on AWS ECS Fargate (behind CloudFront in dev, a load balancer in production),
with the model key in a secret store and stdout shipped to CloudWatch. No database, no disk, no build
step. Render remains the POC host for demos.

## Input and output
- In: the repo at a commit, the model provider's API key in Parameter Store, the AWS account and VPC.
- Out (dev): `https://<distribution>.cloudfront.net` serving `POST /query`, with one log group.
- Out (production, planned): `https://<domain>` on a load balancer, with alarms.

## How it works
1. Image (`Dockerfile`): `node:24-slim`, production dependencies only, `src/` and `catalogData/` copied
   in, run as the `node` user, `tsx` runs the TypeScript directly. Prompts and catalogs sit at the repo
   layout inside the image. `--build-arg COMMIT` stamps the commit on every log record. Built for arm64.
2. `.dockerignore` keeps `.env`, git, docs, scripts, planning and scratch out of the build context.
3. Task definition (`deploy/task-definition.dev.json`): Fargate, 0.5 vCPU, 1 GB, arm64, port 3000,
   `LLM_PROVIDER=deepseek` with the model and its prices as environment, the key as a secret from
   `/search-agent/dev/DEEPSEEK_API_KEY`, logs to `/ecs/search-agent-dev` via the awslogs driver.
4. Network (dev): the DevApex Sandbox account, its own VPC with two public subnets and no NAT gateway; the task
   has a public IP so it reaches the model provider and the feed. Its security group accepts port 3000 only from
   CloudFront's prefix list.
5. Edge (dev): CloudFront serves HTTPS on its own `*.cloudfront.net` certificate and forwards over HTTP straight
   to the task's public DNS name on port 3000; no load balancer. Caching off, every viewer header but Host
   passed on (the CORS preflight needs them), origin response timeout 60 seconds, keep-alive 4 seconds (below
   Node's 5-second idle close). No WAF in dev: a spending limit at the model provider caps a runaway client.
   Production puts a WAF (per-IP rate rule, IP reputation list, bot control) on its load balancer.
6. Roles: an execution role with the ECS task execution policy plus `ssm:GetParameters` on the one
   parameter.
7. Redeploy is a new push and "force new deployment". Rollback is a task definition revision naming the
   previous image tag.

Region `eu-north-1`; names and steps in `docs/DEPLOY-DEV.md` (as built) and `docs/DEPLOY-PROD.md` (planned).
Dev is manual console work plus one `docker push`; production deploys through CI.

Render (`render.yaml`): a free web service in Frankfurt on `npm start` with Bedrock credentials entered in
the dashboard. `GET /` exists so a keepalive pinger stops the free instance from sleeping.

## Invariants
- The log record's `commit` is set on every deploy; null means the build skipped the build argument.
- The eval gate must pass on the exact image sha before a production go-live (`docs/DEPLOY-PROD.md` checklist).

## Limits
- Production is planned, not built: private subnets with NAT, no public IP, immutable tags, two tasks over
  two zones, WAF bot control, 90-day retention, alarms, CI/CD with manual approval, and a guardrails task for
  operator ids and quotas.
- Dev: the app is down after every task restart (redeploy, crash) until CloudFront's origin is re-pointed to the
  new task. The CloudFront → task hop is plain HTTP, any CloudFront distribution can reach the task (the
  prefix list is shared), and there is no rate limit: the provider spending limit is the only cap.
- Open decisions: production account and domain, CI system, who provisions the VPC, final model host.
  DeepSeek's own API is China-hosted and for dev only; production serves the same model from another host
  (OpenRouter, Fireworks or DeepInfra) through `DEEPSEEK_BASE_URL`, or moves to Bedrock with a task role.
- The two CloudWatch alarms from the logging design are not wired yet.

## Where to look
- `Dockerfile`, `.dockerignore`, `deploy/task-definition.dev.json`, `render.yaml`; the runbooks in
  `docs/DEPLOY-DEV.md` and `docs/DEPLOY-PROD.md`; alarms and retention in `planning/logging.md`.
- Related: api, logging, catalogs.
