# Deploying the agent to AWS: production

**Status: planned, not built or tested.** Written from the dev deployment (October 2026) plus what production
needs. The open decisions are listed at the end; fill in the real names when they are made.

Two or more copies of the agent run as containers on AWS in private subnets, behind a load balancer on a real
domain with HTTPS, a firewall (WAF) in front of it and alarms on errors and cost. Images are built and deployed
by CI, never from a laptop. No database, no disk.

```
browser → DNS name → WAF + load balancer (HTTPS) → 2+ Fargate tasks (private subnets) → NAT gateway → model host + Kambi feed
```

## Why it differs from dev

| | Dev | Production | Why |
|---|---|---|---|
| Front door | CloudFront's own address | a real domain on a load balancer | players need a stable address on our domain |
| Copies | 1 task, re-pointed by hand after each restart | 2+ tasks in 2+ zones behind a load balancer | no downtime on deploys, crashes or a zone outage |
| Network | public subnets, task has a public IP | private subnets and a NAT gateway, no public IP | nothing can reach a task except through the load balancer |
| Abuse and cost guard | provider spending limit | WAF rate limit, IP reputation, bot control, alarms, spending limit | real traffic, real money |
| Deploys | `docker push` from a laptop | CI, with a manual approval | repeatable, reviewed, no laptop credentials |

## Before you start: what to ask for

| Need | From | For |
|---|---|---|
| Production AWS account and a permission set to deploy | Kambi cloud platform team | where everything runs |
| VPC with 2+ public subnets (load balancer) and 2+ private subnets with a NAT gateway (tasks), over 2+ zones | Kambi cloud platform team | step 0 |
| A domain and its Route 53 hosted zone in the account (or a record in the zone's owner account) | the DNS owner | steps 9 and 14 |
| A production key at the chosen model host, in its own project with a spending limit | the billing owner | step 4 |
| An email or Slack address for alarms that someone reads | the team | step 15 |

## Names used everywhere

| Thing | Name |
|---|---|
| Account, region | `<PROD_ACCOUNT>`, `eu-north-1`; CLI profile `<prod-profile>` |
| Domain | `<DOMAIN>` (e.g. `search.<zone>`) |
| Security groups | `search-agent-prod-alb`, `search-agent-prod-task` |
| ECR repository | `search-agent` |
| Model key in Parameter Store | `/search-agent/prod/DEEPSEEK_API_KEY` |
| Log group | `/ecs/search-agent-prod` |
| Execution role | `search-agent-prod-execution-role` |
| Cluster, service, task definition family | `search-agent-prod` |
| Container name, port | `search-agent`, `3000` |
| Target group, load balancer, WAF web ACL | `search-agent-prod-tg`, `search-agent-prod`, `search-agent-prod` |

`<ACCOUNT_ID>` below is the account's 12-digit id, shown at the top right of the AWS console. `<SHA>` is a short
git commit id (`git rev-parse --short HEAD`).

## Files in this repo

| File | What it is |
|---|---|
| `Dockerfile` | the image: Node 24 slim, production dependencies only, `src/` + `catalogData/`, runs as `node` |
| `.dockerignore` | keeps `.env`, git, docs and scratch out of the image |
| `deploy/task-definition.dev.json` | the dev task definition; step 8 derives the production one from it |

## Tools on your Mac (once)

**For:** the first image push and emergencies only; CI does normal deploys (step 16).

```bash
brew install awscli colima docker
aws configure sso
colima start
```

- `awscli` is AWS from the terminal. `aws configure sso` asks for the SSO start URL and region (shown in the
  access portal under the account → **Access keys**), then the account, the role, region `eu-north-1`, output
  `json`, and a profile name: use `<prod-profile>`.
- `docker` builds the image, but it is only a client: images are Linux and need a Linux engine. `colima` runs
  that engine in a small Linux VM. Run `colima start` again after every reboot.

## Steps

Make sure the region at the top right of the console is **Europe (Stockholm)**.

### 0. Network (VPC)

**For:** a private network for the app, built so that no task is reachable from the internet.

- A **VPC** is your own private network inside AWS.
- A **subnet** is a slice of the VPC's addresses in one availability zone (one AWS data centre). Using 2+ zones
  means one data centre can fail without taking the app down.
- An **internet gateway** is the VPC's two-way door to the internet. **Public subnets** route through it; the
  load balancer lives there.
- A **NAT gateway** is a one-way door: things in **private subnets** can call out (the model host, the Kambi feed), but
  nothing on the internet can call in. The tasks live there, with no public IP.

The platform team provides this VPC. Check before going on: VPC → Route tables. The public subnets route
`0.0.0.0/0 → igw-…`, the private subnets route `0.0.0.0/0 → nat-…`.

### 1. Security groups

**For:** firewalls. The load balancer's group accepts the public on HTTPS; the tasks' group accepts only the
load balancer. Everything else is blocked.

EC2 → Security Groups → **Create security group**, the load balancer's first (the task group points at it):

| Field | `search-agent-prod-alb` | `search-agent-prod-task` |
|---|---|---|
| VPC | the production VPC | the production VPC |
| Inbound rules | HTTPS 443 and HTTP 80 (redirected to HTTPS) from `0.0.0.0/0`: players come from anywhere | Custom TCP 3000, source = the `search-agent-prod-alb` group |
| Outbound rules | the default (all traffic) | the default (all traffic: the model host and the Kambi feed, through the NAT gateway) |

### 2. Image repository (ECR)

**For:** private storage for the app's images, one per git commit.

ECR → Private registry → Repositories → **Create repository**:

| Field | Value |
|---|---|
| Name | `search-agent` |
| Image tag mutability | **Immutable**: a tag can never be overwritten, so `<SHA>` always means the same image |
| Scan on push | on, if offered (finds known vulnerabilities in the image) |

Then Lifecycle policy → keep the last **10** images, so old ones are deleted.

### 3. Build and push the image

**For:** packs the app (code, prompts, catalogs, Node) into one image and uploads it to ECR, named after its
commit. CI does this from step 16 on; by hand it is:

```bash
ACCOUNT_ID=<ACCOUNT_ID>
SHA=$(git rev-parse --short HEAD)
aws sso login --profile <prod-profile>
aws ecr get-login-password --region eu-north-1 --profile <prod-profile> | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.eu-north-1.amazonaws.com
docker build --platform linux/arm64 --build-arg COMMIT=$SHA -t $ACCOUNT_ID.dkr.ecr.eu-north-1.amazonaws.com/search-agent:$SHA .
docker push $ACCOUNT_ID.dkr.ecr.eu-north-1.amazonaws.com/search-agent:$SHA
```

`--build-arg COMMIT` stamps the commit on every log line. Push only an image whose commit passed `npm run eval`.

### 4. The model key

**For:** keeps the key encrypted in AWS. The app receives it when it starts, so it is never in the code or the
image.

Systems Manager → Parameter Store → **Create parameter**: name `/search-agent/prod/DEEPSEEK_API_KEY`, tier
Standard, type SecureString, KMS key `alias/aws/ssm` (the default), value = the production key. Use a key of its
own, never the dev one, at the chosen host with a spending limit that stops requests. That host is not DeepSeek's
own API (China-hosted, dev only): production serves the same model from OpenRouter, Fireworks or DeepInfra, set by
`DEEPSEEK_BASE_URL` in the task definition.

### 5. Log group

**For:** where the app's output lands (CloudWatch): one JSON line per search and per click. The alarms in step
15 read it.

CloudWatch → Log groups → **Create log group**. Name `/ecs/search-agent-prod`, retention **3 months** (90 days,
the logging design), log class Standard.

### 6. Execution role

**For:** permission for AWS to start the app on our behalf: pull the image, write logs, read the production key
and nothing else. An **IAM role** is a named set of permissions that an AWS service can take on.

1. IAM → Roles → **Create role** → AWS service → **Elastic Container Service**, use case **Elastic Container
   Service Task** → Next.
2. Tick `AmazonECSTaskExecutionRolePolicy` → Next → name `search-agent-prod-execution-role` → **Create role**.
3. Open the role → Add permissions → **Create inline policy** → JSON → paste this → name `read-model-key`:

```json
{ "Version": "2012-10-17", "Statement": [ { "Effect": "Allow", "Action": "ssm:GetParameters", "Resource": "arn:aws:ssm:eu-north-1:<ACCOUNT_ID>:parameter/search-agent/prod/DEEPSEEK_API_KEY" } ] }
```

If the model moves to Bedrock, the task instead gets a task role with `bedrock:InvokeModel`, and the key and
this policy go away.

### 7. Cluster

**For:** a named home for the running app in ECS.

- **ECS** (Elastic Container Service) is AWS's service for running containers.
- **Fargate** is the ECS mode where AWS supplies the machines: you state CPU and memory, and there are no
  servers to create, patch or size.

ECS → Clusters → **Create cluster**. Name `search-agent-prod`, infrastructure **AWS Fargate** only, Container
Insights **on** (it provides the running-task count the alarms in step 15 use).

In a new account this can fail with "Unable to assume the service linked role": ECS's own helper role does not
exist yet. Run `aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com --profile
<prod-profile>` ("has been taken" is fine), delete any half-made cluster, wait 30 seconds and try again.

### 8. Task definition

**For:** the recipe for running the app: which image, how much CPU and memory, which port, which key, where the
logs go.

Copy `deploy/task-definition.dev.json` to `deploy/task-definition.prod.json`, commit it, and change:

| Field | Dev value | Production value |
|---|---|---|
| `family` | `search-agent-dev` | `search-agent-prod` |
| `cpu`, `memory` | `512`, `1024` | `1024`, `2048` (1 vCPU, 2 GB to start; adjust from the metrics) |
| `executionRoleArn` | `…:role/search-agent-dev-execution-role` | `…:role/search-agent-prod-execution-role` |
| `image` | `…/search-agent:dev` | `…/search-agent:<SHA>`, never `:dev` or `:latest` |
| `secrets[0].valueFrom` | `…:parameter/search-agent/dev/DEEPSEEK_API_KEY` | `…:parameter/search-agent/prod/DEEPSEEK_API_KEY` |
| environment `DEEPSEEK_BASE_URL` | unset (DeepSeek's own API) | the chosen host's URL (OpenRouter, Fireworks or DeepInfra) |
| `awslogs-group` | `/ecs/search-agent-dev` | `/ecs/search-agent-prod` |

Replace `<ACCOUNT_ID>` and `<REGION>` (`eu-north-1`), then ECS → Task definitions → Create new task definition ▾
→ **Create new task definition with JSON** → paste → **Create**.

### 9. Certificate

**For:** the HTTPS certificate for `<DOMAIN>`. It proves to browsers that the site really is ours, and lets the
load balancer serve HTTPS. **ACM** (Certificate Manager) issues and renews it for free.

Certificate Manager (region Stockholm, the load balancer's region) → **Request** → public certificate → domain
`<DOMAIN>` → DNS validation → Request. On the certificate page click **Create records in Route 53**, then wait
for status **Issued**. If the zone lives in another account, send its owner the validation CNAME record instead.

### 10. Target group

**For:** the list of app copies the load balancer may send requests to. It checks each copy's health and only
uses healthy ones; ECS adds and removes copies itself.

EC2 → Target Groups → **Create target group**: type **IP addresses**, name `search-agent-prod-tg`, protocol
HTTP, port 3000, the production VPC, protocol version HTTP1, health check path `/` → Next → register nothing →
Create. Then Attributes → Edit → deregistration delay **30 seconds** (how long a stopping copy may finish its
answers).

### 11. Load balancer

**For:** the fixed front door. It takes HTTPS on our domain, spreads requests over the healthy copies and keeps
working through deploys and crashes.

EC2 → Load Balancers → **Create load balancer** → **Application Load Balancer**:

| Field | Value |
|---|---|
| Name | `search-agent-prod` |
| Scheme, IP address type | Internet-facing, IPv4 |
| Network mapping | the production VPC; every zone, each with its **public** subnet |
| Security groups | `search-agent-prod-alb` only |
| Listener | HTTPS 443 → forward to `search-agent-prod-tg`, certificate from step 9, the default security policy |

After creation: add listener **HTTP 80 → redirect to HTTPS 443**, and Attributes → connection idle timeout **300
seconds** (answers stream as SSE and may go quiet for several seconds).

### 12. Firewall (WAF)

**For:** a filter in front of the load balancer that blocks abuse before it costs money: too many requests from
one address, known bad addresses, bots. Every query spends model tokens.

WAF & Shield → Web ACLs → **Create web ACL**:

| Field | Value |
|---|---|
| Resource type | Regional resources, Europe (Stockholm) |
| Name | `search-agent-prod` |
| Associated resource | the `search-agent-prod` load balancer |
| Rule 1 | rate-based rule `per-ip-limit`: 300 requests per 5 minutes per source IP, action Block. Tune it from real traffic: many players can share one address behind a mobile carrier |
| Rule 2 | AWS managed rule group **Amazon IP reputation list** |
| Rule 3 | AWS managed rule group **Bot Control**, common level (a paid group) |
| Default action | Allow |

### 13. Service

**For:** keeps two or more copies of the app running from the recipe, spread over zones, registers them with the
load balancer and replaces any that fail. A running copy is a **task**.

ECS → Clusters → `search-agent-prod` → Services → **Create**:

| Field | Value |
|---|---|
| Task definition | family `search-agent-prod`, latest revision |
| Service name | `search-agent-prod` |
| Compute configuration | Capacity provider strategy → custom: `FARGATE`, base 0, weight 1; platform version LATEST |
| Desired tasks | **2** (one per zone at least) |
| Deployment | min running 100 %, max 200 %; deployment circuit breaker **on, with rollback** (a deploy whose tasks keep failing rolls back by itself) |
| Networking (a folded section) | the production VPC, the **private** subnets, security group `search-agent-prod-task` only, public IP **off** |
| Load balancing | Application Load Balancer → existing `search-agent-prod` → container `search-agent 3000:3000` → existing listener 443 → existing target group `search-agent-prod-tg` |

Check: 2 tasks Running, and Target groups → `search-agent-prod-tg` → Targets shows 2 healthy in different zones.

### 14. DNS record

**For:** points `<DOMAIN>` at the load balancer, so the name players use reaches it.

Route 53 → the hosted zone → **Create record**: name = the domain's first part, type A, **Alias** → Application
Load Balancer → Europe (Stockholm) → `search-agent-prod`. If the zone lives in another account, ask its owner
for a CNAME to the load balancer's DNS name.

### 15. Alarms

**For:** someone gets told when the app breaks or costs run away, instead of finding out from players or the
bill.

1. SNS → Topics → Create topic `search-agent-prod-alarms` (Standard) → Create subscription → Email (or a Slack
   integration) → confirm the email.
2. CloudWatch → Log groups → `/ecs/search-agent-prod` → **Metric filters** → create two:
   - errors: pattern `{ $.type = "query" && $.outcome = "error" }`, metric value `1`;
   - cost: pattern `{ $.type = "query" }`, metric value `$.cost.totalCost` (US dollars per search).
3. CloudWatch → Alarms → **Create alarm**, each notifying the SNS topic:

| Alarm | Condition | Why |
|---|---|---|
| Errors | errors metric, Sum ≥ 5 over 15 minutes | a count, not a rate: a few failures at night would flip a rate |
| Cost | cost metric, Sum > $2 over 1 hour | about 4× normal at 5,000 searches a day: a loop or abuse |
| Copies down | Container Insights `RunningTaskCount` < 2 for 5 minutes | the service cannot keep its copies up |
| Server errors | load balancer `HTTPCode_ELB_5XX_Count` + `HTTPCode_Target_5XX_Count`, Sum > 10 over 5 minutes (a starting value) | the front door or the app answers with errors |

### 16. CI/CD pipeline

**For:** every release is built, tested and deployed the same way, from the repository, with a person approving
production. No laptop credentials involved.

One pipeline job (GitHub Actions with an OIDC role, or Jenkins: an open decision) that:

1. runs `npm run typecheck`, `npm run lint` and `npm test`;
2. builds the image for arm64 with `--build-arg COMMIT=<SHA>` and pushes `search-agent:<SHA>` (step 3);
3. waits for a manual approval;
4. registers a new task definition revision naming that image, updates the service to it, and waits until the
   service is stable.

### 17. Proof

**For:** checks the whole chain through the real domain before anyone else uses it.

```bash
curl https://<DOMAIN>/                     # → ok
curl -I http://<DOMAIN>/                   # → 301 to https
curl -N https://<DOMAIN>/query -H 'content-type: application/json' -d '{"query":"Arsenal to win tonight","tz":"Europe/Stockholm"}'
```

The query streams SSE events one by one, ending in `done`. CloudWatch → `/ecs/search-agent-prod` → newest stream
shows one `"type":"query"` line with `commit` = the deployed `<SHA>`.

## Redeploy and rollback

- **Redeploy:** run the pipeline. ECS starts new copies, waits until the load balancer finds them healthy, then
  drains and stops the old ones: no downtime, nothing to re-point.
- **Rollback:** ECS → service → Update → the previous task definition revision (it names the previous image).
  The circuit breaker does this by itself when a new revision's tasks keep failing.

## Go-live checklist

- `npm run eval` gate passed on the exact image `<SHA>` being deployed.
- A spending limit set on the production key at the model host.
- The four alarms wired to an address someone reads, and each one tested once.
- One load test through the load balancer.
- Both security groups reviewed: the tasks accept only the load balancer, the load balancer only 80 and 443.
- This runbook updated with the real names.

## Later, as its own task: guardrails

An operator id on every request, per-operator quotas, an optional player-session check, and CORS narrowed to the
operators' domains (today `/query` echoes any origin).

## Open decisions

The production account · the domain · the CI system (GitHub Actions or Jenkins) · who provisions the VPC · the
final model host (OpenRouter, Fireworks or DeepInfra serving DeepSeek V4.1 Flash, or Bedrock with a task role).
