# Deploying the agent to AWS: dev

One copy of the agent runs as a container on AWS, reached through CloudFront over HTTPS. There is no load
balancer, no rate limiter and no database: this is the cheapest setup a browser frontend can call. Production is
built differently; see `docs/DEPLOY-PROD.md`.

```
browser → CloudFront (HTTPS) → Fargate task :3000 (HTTP) → OpenAI + Kambi feed
```

## What is running now

| Thing | Value |
|---|---|
| Account, region | DevApex Sandbox (Kambi SSO), `eu-north-1` (Stockholm) |
| URL for the frontend | `https://d1eht4ldvahbux.cloudfront.net`: `POST /query` (SSE), `POST /event` (click log), `GET /` (health) |
| CloudFront distribution | `E1OQR0981IAXTE` |
| Image | `search-agent:dev` in ECR |

## Trade-offs accepted for dev

- **No load balancer** (saves its monthly cost). The task gets a new address every time it starts (a redeploy, a
  crash, a resume from 0), and CloudFront must then be re-pointed by hand ("Redeploy and re-point" below). The
  app is down until that is done.
- **No rate limit (WAF)** (saves its monthly cost). A spending limit on the dev OpenAI project (step 11) caps
  what a runaway client can cost instead.
- **CloudFront → task is plain HTTP.** Only queries and odds travel on that hop.
- **Any CloudFront distribution can reach the task**, not only ours: the security group allows CloudFront's
  shared address list.
- **What it costs:** the running task and its public IP, the logs, and OpenAI tokens. CloudFront's free tier (1
  TB and 10 million requests a month) covers dev traffic. Set the service to 0 tasks to pay nothing while nobody
  is testing.

## Names used everywhere

| Thing | Name |
|---|---|
| Account, region | DevApex Sandbox, `eu-north-1`; CLI profile `devapex` |
| VPC | `search-agent-dev-vpc` |
| Security group | `search-agent-dev-task` |
| ECR repository | `search-agent` |
| OpenAI key in Parameter Store | `/search-agent/dev/OPENAI_API_KEY` |
| Log group | `/ecs/search-agent-dev` |
| Execution role | `search-agent-dev-execution-role` |
| Cluster, service, task definition family | `search-agent-dev` |
| Container name, port | `search-agent`, `3000` |
| CloudFront distribution | `search-agent-dev` |

`<ACCOUNT_ID>` below is the account's 12-digit id, shown at the top right of the AWS console.

## Files in this repo

| File | What it is |
|---|---|
| `Dockerfile` | the image: Node 24 slim, production dependencies only, `src/` + `catalogData/`, runs as `node` |
| `.dockerignore` | keeps `.env`, git, docs and scratch out of the image |
| `deploy/task-definition.dev.json` | the task definition (step 8); `<ACCOUNT_ID>` and `<REGION>` are filled in when pasting |

## Tools on your Mac (once)

**For:** building the image and uploading it to AWS from your laptop.

```bash
brew install awscli colima docker
aws configure sso
colima start
```

- `awscli` is AWS from the terminal; it is needed only to log Docker in to ECR (step 3).
- `docker` builds the image, but it is only a client: images are Linux and need a Linux engine. `colima` runs
  that engine in a small Linux VM. Run `colima start` again after every reboot.
- `aws configure sso` asks these questions. The start URL and SSO region are also shown in the access portal
  under DevApex Sandbox → **Access keys**.

| Prompt | Answer |
|---|---|
| SSO session name | `kambi` |
| SSO start URL | `https://identitycenter.amazonaws.com/ssoins-65085f7e7e2f0a6a` |
| SSO region | `eu-north-1` |
| SSO registration scopes | press Enter |
| (browser opens) | log in, Allow |
| Account, role | DevApex Sandbox, `admin` |
| Default client region, output format | `eu-north-1`, `json` |
| Profile name | `devapex` |

Check: `aws sts get-caller-identity --profile devapex` prints the DevApex Sandbox account id.

## Steps

Make sure the region at the top right of the console is **Europe (Stockholm)**. CloudFront is global; its
console switches region by itself.

### 0. Network (VPC)

**For:** a private network for the app in AWS; everything else lives inside it.

- A **VPC** is your own private network inside AWS.
- A **subnet** is a slice of the VPC's addresses in one availability zone (one AWS data centre). It is
  **public** when its traffic to the internet goes through an internet gateway.
- An **internet gateway** is the VPC's door to the internet. Anything in a public subnet that has a public IP
  can reach the internet through it, and be reached.
- A **NAT gateway** would let things without a public IP reach the internet. Dev does not use one (it costs
  money); the task gets a public IP instead.

VPC → Your VPCs → **Create VPC**:

| Field | Value |
|---|---|
| Resources to create | VPC and more |
| Name tag auto-generation | on, `search-agent-dev` |
| IPv4 CIDR block | `10.0.0.0/16` (ask the network team first if it may ever connect to Kambi networks) |
| IPv6 CIDR block | none |
| Number of Availability Zones | 2 |
| Public / private subnets | 2 / 0 |
| NAT gateways | None |
| VPC endpoints | None |
| DNS hostnames, DNS resolution | both on |

Check: the VPC's resource map shows `search-agent-dev-rtb-public` with 2 subnet associations and 2 routes
(local, and `0.0.0.0/0 → search-agent-dev-igw`). A second route table with no subnets is the VPC's main one;
ignore it.

### 1. Security group

**For:** a firewall around the app. It lets in only CloudFront, on port 3000; everything else is blocked.
Outgoing traffic (OpenAI, the Kambi feed) is allowed.

EC2 → Security Groups → **Create security group**:

| Field | Value |
|---|---|
| Name, description | `search-agent-dev-task`, `search-agent dev task` |
| VPC | `search-agent-dev-vpc` |
| Inbound rule | Custom TCP, port `3000`, source Custom → type `cloudfront` → pick `com.amazonaws.global.cloudfront.origin-facing` |
| Outbound rules | leave the default (all traffic) |

### 2. Image repository (ECR)

**For:** private storage for the app's image, like a private Docker Hub.

ECR → Private registry → Repositories → **Create repository**. Name `search-agent`, image tag mutability
**Mutable** (every push replaces `:dev`), the rest as offered.

### 3. Build and push the image

**For:** packs the app (code, prompts, catalogs, Node) into one image on your Mac and uploads it to ECR.

From the repo root:

```bash
ACCOUNT_ID=<ACCOUNT_ID>
aws sso login --profile devapex
aws ecr get-login-password --region eu-north-1 --profile devapex | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.eu-north-1.amazonaws.com
docker build --platform linux/arm64 --build-arg COMMIT=$(git rev-parse --short HEAD) -t search-agent:dev .
docker run --rm -p 3000:3000 --env-file .env search-agent:dev     # open http://localhost:3000/ → "ok", then Ctrl-C
docker tag search-agent:dev $ACCOUNT_ID.dkr.ecr.eu-north-1.amazonaws.com/search-agent:dev
docker push $ACCOUNT_ID.dkr.ecr.eu-north-1.amazonaws.com/search-agent:dev
```

`--build-arg COMMIT` stamps the git commit on every log line. Check: ECR → `search-agent` lists the tag `dev`.

### 4. The OpenAI key

**For:** keeps the key encrypted in AWS. The app receives it when it starts, so it is never in the code or the
image.

Systems Manager → Parameter Store → **Create parameter**:

| Field | Value |
|---|---|
| Name | `/search-agent/dev/OPENAI_API_KEY` |
| Tier, type | Standard, SecureString |
| KMS key | My current account, `alias/aws/ssm` (the default) |
| Value | the dev OpenAI key |

### 5. Log group

**For:** where the app's output lands (CloudWatch): one JSON line per search and per click.

CloudWatch → Log groups → **Create log group**. Name `/ecs/search-agent-dev`, retention **3 months**, log class
Standard.

### 6. Execution role

**For:** permission for AWS to start the app on our behalf: pull the image, write logs, read the key. An **IAM
role** is a named set of permissions that an AWS service can take on.

1. IAM → Roles → **Create role** → AWS service → service **Elastic Container Service**, use case **Elastic
   Container Service Task** → Next.
2. Tick `AmazonECSTaskExecutionRolePolicy` → Next → name `search-agent-dev-execution-role` → **Create role**.
3. Open the role → Add permissions → **Create inline policy** → JSON → paste this, account id filled in → Next →
   name `read-openai-key` → **Create policy**:

```json
{ "Version": "2012-10-17", "Statement": [ { "Effect": "Allow", "Action": "ssm:GetParameters", "Resource": "arn:aws:ssm:eu-north-1:<ACCOUNT_ID>:parameter/search-agent/dev/OPENAI_API_KEY" } ] }
```

### 7. Cluster

**For:** a named home for the running app in ECS.

- **ECS** (Elastic Container Service) is AWS's service for running containers.
- **Fargate** is the ECS mode where AWS supplies the machines: you state CPU and memory, and there are no
  servers to create, patch or size.

ECS → Clusters → **Create cluster**. Name `search-agent-dev`, infrastructure **AWS Fargate** only, Container
Insights off.

In a new account this can fail with "Unable to assume the service linked role": ECS's own helper role does not
exist yet. Create it, delete any half-made cluster, wait 30 seconds and try again:

```bash
aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com --profile devapex
```

"Has been taken" means the role already exists; that is fine.

### 8. Task definition

**For:** the recipe for running the app: which image, how much CPU (0.5 vCPU) and memory (1 GB), which port,
which key, where the logs go.

In the step 3 terminal (it needs `$ACCOUNT_ID`), copy the filled-in recipe:

```bash
sed -e "s/<ACCOUNT_ID>/$ACCOUNT_ID/g" -e "s/<REGION>/eu-north-1/g" deploy/task-definition.dev.json | pbcopy
```

ECS → Task definitions → Create new task definition ▾ → **Create new task definition with JSON** → select all in
the editor, paste → **Create**. Check: `search-agent-dev:1` exists.

### 9. Service

**For:** keeps one copy of the app running from the recipe, and starts a new one if it crashes. A running copy
is a **task**. Its public IP lets it reach OpenAI and the Kambi feed.

ECS → Clusters → `search-agent-dev` → Services → **Create**:

| Field | Value |
|---|---|
| Task definition | family `search-agent-dev`, latest revision |
| Service name | `search-agent-dev` |
| Compute configuration | Capacity provider strategy → custom: `FARGATE`, base 0, weight 1; platform version LATEST |
| Desired tasks | 1 |
| Networking (a folded section further down) | VPC `search-agent-dev-vpc`, both public subnets, existing security group `search-agent-dev-task` only (remove `default`), public IP **on** |
| Load balancing | none |

The public IP must be on: without it the task cannot pull its image or reach OpenAI.

Check: the Tasks tab shows 1 Running. Then open the task → Networking → click the ENI id → copy **Public IPv4
DNS**, e.g. `ec2-16-171-20-127.eu-north-1.compute.amazonaws.com`. CloudFront needs this name in step 10; it does
not accept a bare IP.

### 10. CloudFront

**For:** the public front door. It gives the app an HTTPS address that browsers can call (an `https://` page may
not call an `http://` API), and forwards every request to the task. The account has no domain of its own, so we
use CloudFront's `*.cloudfront.net` address and certificate.

CloudFront → Distributions → **Create distribution**. Leave the **Route 53 managed domain** box empty (it is for
a domain of your own). Where the console offers recommended origin or cache settings, choose to customize them:

| Field | Value | Why |
|---|---|---|
| Pricing plan | Pay-as-you-go | as the account's other distributions |
| Name | `search-agent-dev` | |
| Origin type, origin domain | Other; the task's Public IPv4 DNS from step 9 | |
| Origin protocol, port | **HTTP only**, **3000** | the task serves plain HTTP on 3000 |
| Response timeout | **60** seconds | the stream sends no heartbeat, so the slowest stage must answer within it |
| Keep-alive timeout | **4** seconds | below the app's 5-second idle close, so CloudFront never reuses a closing connection |
| Viewer protocol policy | **HTTPS only** | a redirected POST loses its body |
| Allowed HTTP methods | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | `/query` is a POST; OPTIONS is the browser's CORS check |
| Cache policy | **CachingDisabled** | every answer is live |
| Origin request policy | **AllViewerExceptHostHeader** | passes the browser's CORS headers to the app |
| Response headers policy | none | the app sets the CORS headers itself |
| Web Application Firewall | do not enable | dev uses the spending limit (step 11) |
| Alternate domain name, custom certificate | none | |

Check: once "Last modified" shows a date instead of "Deploying", copy the distribution domain name
(`dXXXX.cloudfront.net`). That is the URL for the frontend.

### 11. OpenAI spending limit

**For:** a ceiling on the monthly OpenAI bill, in case a client (a frontend bug, a script) sends queries in a
loop. It replaces a paid rate limiter in dev.

In the OpenAI dashboard, open the project that holds the dev key → **Limits** → set a monthly budget (for
example $20). Make sure the limit stops requests rather than only sending an email; if it only alerts, add a WAF
rate limit on the distribution (about $7 a month).

### 12. Proof

**For:** checks the whole chain: health, browser access, a real streamed answer, and that nothing can reach the
task except through CloudFront.

```bash
D=d1eht4ldvahbux.cloudfront.net
curl https://$D/                       # → ok
curl -i -X OPTIONS https://$D/query -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type'
curl -N https://$D/query -H 'content-type: application/json' -d '{"query":"Arsenal to win tonight","tz":"Europe/Stockholm"}'
curl -m 5 http://<TASK_PUBLIC_DNS>:3000/   # → times out: only CloudFront may reach the task
```

- The second command answers `204` with `access-control-allow-origin: https://example.com` and
  `access-control-allow-headers: content-type`.
- The third streams SSE events one by one, not all at once at the end, ending in `done`. It costs one query's
  tokens. `http://` instead of `https://` gets `403`.
- CloudWatch → `/ecs/search-agent-dev` → newest stream shows one JSON line `"type":"query"` for it, with
  `commit` set (null means the build skipped `--build-arg COMMIT`).

The frontend calls `https://dXXXX.cloudfront.net` with no trailing slash, and always sends `tz`: without it the
server reads "tonight" in UTC.

## Redeploy and re-point

- **Redeploy:** step 3, then ECS → service → Update → **Force new deployment**.
- **After every new task** (a redeploy, a crash, a resume from 0): when the new task is Running, copy its Public
  IPv4 DNS (step 9) → CloudFront → the distribution → Origins → select the origin → Edit → Origin domain → paste
  → Save changes. The app is down from the old task stopping until this change has deployed (a few minutes). The
  frontend URL never changes.
- **Pause:** service → Update → desired tasks 0. Set it back to 1 to resume, then re-point.
- **Rollback:** push each image also as `:<git-sha>`. Rolling back is a new task definition revision that names
  the old tag, then Update service to that revision, then re-point.

## When something fails

| Symptom | Cause and fix |
|---|---|
| Creating the cluster: "Unable to assume the service linked role" | ECS's helper role is missing: the command in step 7 |
| Task stops with `CannotPullContainerError` | public IP is off (step 9) or the image is not in ECR (step 3) |
| Task stops with an error mentioning `ssm` | the inline policy of step 6 names the wrong parameter |
| CloudFront answers 502 or 504 | the origin still points at an old task (re-point), or no task is running |
| The browser blocks the call as "mixed content" | the frontend calls `http://`; use `https://` |
