# Deploying the agent to AWS (dev)

One container on ECS Fargate behind an HTTPS load balancer. No database, no disk, no build step: the
image runs `src/` with tsx exactly like `npm start`. Everything below is manual console work plus one
`docker push`; CI/CD comes later and only automates step 3 and the redeploy.

```
internet → ALB (HTTPS, search-agent.bash.dev.kambi.cloud) → Fargate task :3000 → OpenAI + Kambi feed
```

The task lives in the default VPC with a public IP so it can reach the internet without a NAT gateway,
but its security group only accepts traffic from the load balancer.

## Files in this repo

| File | What it is |
|---|---|
| `Dockerfile` | the image: Node 24 slim, prod deps only, `src/` + `catalogData/`, runs as `node` |
| `.dockerignore` | keeps `.env`, git, docs and scratch out of the build |
| `deploy/task-definition.dev.json` | ECS task definition; replace `<ACCOUNT_ID>` and `<REGION>` before pasting |

## Names used everywhere

| Thing | Name |
|---|---|
| Region | `eu-north-1` (pick once, use everywhere) |
| ECR repo | `search-agent` |
| Cluster, service, task family | `search-agent-dev` |
| Container name, port | `search-agent`, `3000` |
| Log group | `/ecs/search-agent-dev` |
| SSM parameter | `/search-agent/dev/OPENAI_API_KEY` |
| Security groups | `search-agent-dev-alb`, `search-agent-dev-task` |
| Target group, ALB | `search-agent-dev-tg`, `search-agent-dev` |
| DNS name | `search-agent.bash.dev.kambi.cloud` (zone `bash.dev.kambi.cloud`) |

## Once on your Mac

```bash
brew install awscli colima docker
aws configure sso        # Kambi access portal URL → devLuck account → profile name: devluck
colima start             # boots the Linux VM that runs Docker; needed again after every reboot
```

`aws configure sso` is needed only for the image push: `aws ecr get-login-password` is the one command
that produces an ECR login token, and it needs credentials for the devLuck account. `colima start` is
needed because the `docker` command is only a client; images are Linux and need a Linux engine.

## Steps

**0. Network.** VPC → Your VPCs → Actions → Create default VPC. Note the VPC id and its subnet ids.

**1. Security groups.** EC2 → Security groups → Create, both in the default VPC.
- `search-agent-dev-alb`: inbound HTTPS 443 and HTTP 80 from the Kambi office/VPN ranges (or your own IP
  to start). Outbound: all.
- `search-agent-dev-task`: inbound TCP 3000, source = the `search-agent-dev-alb` group. Outbound: all
  (OpenAI and the Kambi feed).

**2. ECR.** ECR → Create repository → private, name `search-agent`, scan on push on. Copy the URI.

**3. Build and push.** From the repo root, `<ACCOUNT_ID>` filled in:

```bash
aws sso login --profile devluck
aws ecr get-login-password --region eu-north-1 --profile devluck | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.eu-north-1.amazonaws.com
docker build --platform linux/arm64 -t search-agent:dev .
docker run --rm -p 3000:3000 --env-file .env search-agent:dev     # open http://localhost:3000/ → "ok", then Ctrl-C
docker tag search-agent:dev <ACCOUNT_ID>.dkr.ecr.eu-north-1.amazonaws.com/search-agent:dev
docker push <ACCOUNT_ID>.dkr.ecr.eu-north-1.amazonaws.com/search-agent:dev
```

**4. The key.** Systems Manager → Parameter Store → Create parameter. Name
`/search-agent/dev/OPENAI_API_KEY`, tier Standard, type SecureString, default KMS key, value = the dev
OpenAI key. Copy the ARN shown afterwards.

**5. Certificate.** Certificate Manager (same region) → Request → public →
`search-agent.bash.dev.kambi.cloud` → DNS validation. On the certificate page click
"Create records in Route 53". Wait for status Issued.

**6. Log group.** CloudWatch → Log groups → Create. Name `/ecs/search-agent-dev`, retention 3 months.

**7. Execution role.** IAM → Roles → Create → AWS service → Elastic Container Service → use case
"Elastic Container Service Task". Attach `AmazonECSTaskExecutionRolePolicy`. Name
`search-agent-dev-execution-role`. Then add this inline policy so ECS can read the key:

```json
{ "Version": "2012-10-17", "Statement": [ { "Effect": "Allow", "Action": "ssm:GetParameters", "Resource": "<PARAMETER_ARN>" } ] }
```

**8. Cluster.** ECS → Clusters → Create. Name `search-agent-dev`, Fargate only, Container Insights off.

**9. Task definition.** ECS → Task definitions → Create new with JSON → paste
`deploy/task-definition.dev.json` with `<ACCOUNT_ID>` and `<REGION>` replaced.

**10. Target group.** EC2 → Target groups → Create. Type **IP addresses**, name `search-agent-dev-tg`,
HTTP on port 3000, default VPC, health check path `/`. Advanced: deregistration delay 30 seconds.
Register no targets; ECS does that.

**11. Load balancer.** EC2 → Load balancers → Create → Application. Name `search-agent-dev`,
internet-facing, IPv4, default VPC, all subnets, security group `search-agent-dev-alb` only. Listener
HTTPS 443 → forward to `search-agent-dev-tg`, certificate from step 5. After creation: Add listener
HTTP 80 → redirect to HTTPS 443. Attributes → idle timeout 300 seconds (answers stream as SSE).

**11b. Rate limit.** WAF & Shield → Web ACLs → Create → resource type "Regional", associate the
`search-agent-dev` load balancer. Add a rate-based rule: limit per IP over 5 minutes (start with 300),
action Block. Add the managed rule group "Amazon IP reputation list". Every query costs LLM tokens; this is
the guard against a script running up the bill. IP restriction is not possible in prod (players come from
anywhere), so the same rule is the prod design too.

**12. Service.** Cluster → Services → Create. Fargate, family `search-agent-dev` latest revision,
service name `search-agent-dev`, desired tasks 1. Networking: default VPC, all subnets, security group
`search-agent-dev-task` only, public IP **on**. Load balancing: existing `search-agent-dev`, listener
443, target group `search-agent-dev-tg`. Wait for 1/1 running and the target healthy.

**13. DNS.** Route53 → `bash.dev.kambi.cloud` → Create record. Name `search-agent`, type A, Alias to
Application Load Balancer → region → `search-agent-dev`.

**14. Proof.**

```bash
curl -N https://search-agent.bash.dev.kambi.cloud/query -H 'content-type: application/json' -d '{"query":"Arsenal to win tonight","tz":"Europe/Stockholm"}'
```

Expect SSE events ending in `done`. CloudWatch → `/ecs/search-agent-dev` → newest stream shows the query.
Point the frontend at the HTTPS name; CORS on `/query` already allows any origin.

## Redeploy and rollback

- **Redeploy:** repeat step 3, then ECS → service → Update → "Force new deployment".
- **Rollback:** also push each image as `:<git-sha>`; rolling back is a new task definition revision
  that names the old tag, then Update service to it.

## Production

Same pipeline, different values, plus the things dev can skip. In order of what changes:

1. **Account and network.** The prod account and its VPC come from the Kambi cloud platform team: two or more
   private subnets with a NAT gateway for the tasks, two or more public subnets for the load balancer. Tasks
   get **no public IP**. Ask for the VPC together with the permission set, as for dev.
2. **Names.** `search-agent-prod` everywhere; parameter `/search-agent/prod/OPENAI_API_KEY` holding a separate
   prod key with its own spending cap; log group `/ecs/search-agent-prod`.
3. **Image.** Tag immutability **on** in ECR; every push is `:<git-sha>`; the prod task definition names a sha,
   never `:dev` or `:latest`. Lifecycle policy: keep the last 10 images.
4. **Capacity.** Two tasks minimum, spread over two availability zones, rolling deploy min 100 / max 200 so a
   deploy never drops below two. Start at 1 vCPU / 2 GB; add CPU-based autoscaling when traffic is known.
5. **Load balancer.** Internet-facing, HTTPS 443 only, HTTP 80 redirects, real domain with an ACM certificate,
   idle timeout 300 seconds. Security groups exactly as dev: ALB open on 443, task only from the ALB group.
   IP restriction is not possible: players come from anywhere.
6. **WAF.** The dev rate rule plus the IP reputation list; add the managed bot-control group. Per-operator
   limits come with the guardrails task.
7. **Roles.** Execution role scoped to the prod parameter only. If the LLM moves to Bedrock, the task gets a
   task role with `bedrock:InvokeModel` and the key disappears.
8. **Logging and alarms.** Retention 90 days (see planning/logging.md). Alarms: running tasks below desired,
   ALB 5xx rate, LLM cost per hour once the per-query record lands. Container Insights on.
9. **CI/CD.** A pipeline job (GitHub Actions with an OIDC role, or Jenkins) that runs the tests, builds the
   image, pushes `:<git-sha>`, registers a new task definition revision and updates the service. Prod deploys
   behind a manual approval. Rollback = update the service to the previous revision.
10. **Guardrails, separate task.** Operator identifier on every request, per-operator quotas, optional
    player-session check, CORS narrowed to operator domains.

**Go-live checklist:** `npm run eval` gate passed on the exact image sha · spending cap set on the prod key ·
alarms wired to a channel someone reads · one load test through the ALB · the security groups reviewed ·
this runbook updated with the real names.

**Open decisions:** prod account name · domain · CI system (GitHub Actions vs Jenkins) · who provisions the
VPC · final LLM provider (OpenAI key vs Bedrock task role).
