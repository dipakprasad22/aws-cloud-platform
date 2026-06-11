# MarketBase: Build Guide

> A highly-available, three-tier dynamic web app — the classic Solution Architect build.
> Survives instance **and** availability-zone failures, scales with traffic, keeps the database private.
> Build order: **network → data → application → presentation** (each layer needs the one before it).

---

## What you're building

```
Presentation:  Users → Application Load Balancer (public, 2 AZs, TLS)
Application:   Auto Scaling Group of EC2 (private subnets, 2 AZs, from a golden AMI)
Data:          RDS Multi-AZ (private subnets) + Secrets Manager (credentials) + CloudWatch (monitoring)
Network:       VPC across 2 AZs — public subnets (ALB/NAT) + private subnets (app + data)
```

**Three-tier mapping:**
- Presentation: the ALB terminates TLS and distributes traffic — the only internet-facing component.
- Application: stateless EC2 instances in an Auto Scaling Group, launched from a golden AMI, across two AZs.
- Data: RDS Multi-AZ in private subnets, credentials in Secrets Manager.

**The core HA idea:** everything is doubled across two Availability Zones, only the load balancer is public, and the database is private and replicated. No single instance or single data center failure can take the site down.

**Region:** Build everything in one region (e.g. `ap-south-1` Mumbai). Stay in the same region the whole time.

---

# PART 1 — NETWORK TIER (the VPC)

> **Why first:** every other component lives inside this network. The subnets, routing, and security boundaries must exist before you can place a database or server in them.

## 1A. Create the VPC with the wizard

> **What:** AWS's "VPC and more" wizard builds a complete 2-AZ network (VPC, subnets, route tables, IGW, NAT) in one shot — saving ~20 manual steps.

1. Console → **VPC** → **Create VPC** → choose **VPC and more** (the wizard).
2. **Name tag auto-generation:** `marketbase`.
3. **IPv4 CIDR:** `10.0.0.0/16` (65k addresses — plenty).
4. **Number of Availability Zones (AZs):** **2** — *this is what makes it HA.*
5. **Number of public subnets:** **2** (one per AZ — for the ALB and NAT).
6. **Number of private subnets:** **4** (two per AZ — one pair for app, one pair for data).
7. **NAT gateways:** **In 1 AZ** — *why: lets private instances reach the internet for updates; 1 (not per-AZ) to save cost. ⚠️ this is the billable NAT.*
8. **VPC endpoints:** **None** for now (S3 gateway endpoint is a nice cost-saver but optional).
9. **Create VPC.** The wizard builds everything; wait for it to finish, then **View VPC**.

You now have a 2-AZ network: 2 public subnets, 4 private subnets, route tables, an internet gateway, and a NAT gateway — the foundation for everything else.

## 1B. Note your subnets

> **Why:** you'll place the database in one private-subnet pair and the app in the other, so know which is which.

1. VPC → **Subnets** → identify by name: the wizard names them like `marketbase-subnet-private1-az1`, etc.
2. Mentally assign: **private1 (both AZs) = app tier**, **private2 (both AZs) = data tier**. (Any consistent split works.)

---

# PART 2 — DATA TIER

## 2A. Security groups first

> **Why:** security groups are the identity-based firewall. Create them before the resources so each resource references the right one. We build three, layered so each tier only accepts traffic from the tier in front of it.

1. VPC → **Security groups** → **Create security group**. Make these three (all in the `marketbase` VPC):

   **`marketbase-alb-sg`** (for the load balancer)
   - Inbound: HTTP 80 from `0.0.0.0/0`, HTTPS 443 from `0.0.0.0/0`.
   - *Why: the ALB is the public front door; the internet reaches it.*

   **`marketbase-app-sg`** (for the EC2 instances)
   - Inbound: HTTP 80 — **Source: the `marketbase-alb-sg`** (type the SG name, not an IP).
   - *Why: app instances accept traffic ONLY from the ALB — firewall by identity, the Module 3.2 pattern. No public access to instances.*

   **`marketbase-db-sg`** (for RDS)
   - Inbound: MySQL/Aurora 3306 (or PostgreSQL 5432) — **Source: the `marketbase-app-sg`**.
   - *Why: the database accepts connections ONLY from the app tier — never from the internet, never directly.*

This SG-referencing-SG chain (ALB→app→db) is the heart of the security model. Each layer trusts only the layer in front of it, by identity.

## 2B. DB subnet group

> **What:** tells RDS which subnets it may live in. We give it the two private data subnets so it's never internet-reachable.

1. Console → **RDS** → **Subnet groups** → **Create DB subnet group**.
2. Name `marketbase-db-subnets`, select the `marketbase` VPC, add **both AZs**, and select the two **private data subnets** (private2 pair).
3. Create.

## 2C. Create the RDS Multi-AZ database

> **What:** the managed database, replicated synchronously to a standby in the other AZ for automatic failover. ⚠️ Multi-AZ is billable.

1. RDS → **Databases** → **Create database** → **Standard create**.
2. **Engine:** MySQL (or PostgreSQL).
3. **Templates:** **Production** (enables sensible HA defaults) — or Dev/Test to reduce options; either works.
4. **Availability & durability:** **Multi-AZ DB instance** — *this is the HA database: a standby in AZ B with auto-failover.*
5. **DB identifier:** `marketbase-db`. **Master username:** `admin`. **Credentials management:** choose **Managed in AWS Secrets Manager** — *why: this auto-creates the credential secret with rotation, so the password is never handled by hand (Module 3.18). This is the clean pattern.*
6. **Instance class:** `db.t3.micro` (smallest; keeps cost down).
7. **Connectivity:** VPC `marketbase`, **DB subnet group** `marketbase-db-subnets`, **Public access: NO** (*critical — the DB must not be internet-reachable*), **VPC security group:** existing → `marketbase-db-sg`.
8. **Additional config → Initial database name:** `marketbase`.
9. **Create database.** Takes ~10 min. While it builds, do Part 3.

When done, RDS → your DB → note the **endpoint** (hostname) and open the linked **Secrets Manager** secret — that's where the app will fetch credentials from.

---

# PART 3 — APPLICATION TIER

## 3A. Build a golden AMI

> **What:** a pre-configured image of your app server, so every instance the Auto Scaling Group launches is identical and boots ready-to-serve (Module 3.3 — "cattle not pets," immutability).

We'll launch one temporary instance, install a simple app, then image it.

1. EC2 → **Launch instance**. Name `marketbase-golden`.
2. **AMI:** Amazon Linux 2023. **Type:** `t3.micro`.
3. **Key pair:** your key (or "proceed without" — we'll use Session Manager).
4. **Network:** VPC `marketbase`, **a public subnet** (temporarily, so we can set it up), **Auto-assign public IP: Enable**, **SG:** create temp SG allowing SSH 22 from your IP (or just use the app-sg + Session Manager).
5. **Advanced → IAM instance profile:** create/attach a role with `AmazonSSMManagedInstanceCore` (lets you connect via Session Manager — no open SSH) and `SecretsManagerReadWrite` scoped down later. *Why: instances get permissions via a role, not stored keys (Module 3.1).*
6. **User data** (Advanced → User data) — installs a tiny web app:
```bash
#!/bin/bash
dnf install -y httpd
systemctl enable httpd
systemctl start httpd
echo "<h1>MarketBase</h1><p>Served from $(hostname -f)</p>" > /var/www/html/index.html
echo "OK" > /var/www/html/health
```
7. **Launch.** Wait until it's running and status checks pass. Visit `http://<public-ip>/` → you should see the MarketBase page. (`/health` is the deep health-check path the ALB will use.)
8. **Create the image:** EC2 → select the instance → **Actions → Image and templates → Create image** → name `marketbase-ami` → Create. Wait until the AMI status is **Available** (AMI → AMIs).
9. **Terminate the temporary `marketbase-golden` instance** — you only needed it to bake the image. *Why: the AMI now holds everything; the instance was disposable.*

## 3B. Launch template

> **What:** the blueprint the Auto Scaling Group uses to launch instances — which AMI, type, SG, and role. Replaces manual per-instance config.

1. EC2 → **Launch templates** → **Create launch template**. Name `marketbase-lt`.
2. **AMI:** your `marketbase-ami`. **Type:** `t3.micro`.
3. **Security group:** `marketbase-app-sg` (accepts traffic only from the ALB).
4. **Advanced → IAM instance profile:** the SSM role from before.
5. (Don't set a subnet here — the ASG controls placement.) **Create launch template.**

## 3C. Target group

> **What:** the pool of instances the ALB routes to, with the health check that decides which instances are healthy.

1. EC2 → **Target groups** → **Create target group** → type **Instances**.
2. Name `marketbase-tg`, protocol **HTTP 80**, VPC `marketbase`.
3. **Health check path:** `/health` — *why: a meaningful path that proves the app is actually serving, not just that the port is open (Module 3.4).*
4. Create (don't register instances by hand — the ASG will).

## 3D. Application Load Balancer

> **What:** the public, HA front door that spreads traffic across instances in both AZs. ⚠️ billable.

1. EC2 → **Load balancers** → **Create** → **Application Load Balancer**.
2. Name `marketbase-alb`, **Internet-facing**, IPv4.
3. **Network:** VPC `marketbase`, select **both AZs** and their **public subnets**. *Why: the ALB must span both AZs to stay available if one fails.*
4. **Security group:** `marketbase-alb-sg`.
5. **Listener:** HTTP 80 → forward to `marketbase-tg`. (For HTTPS you'd add a 443 listener with an ACM cert — optional here since we may have no domain; HTTP is fine to demonstrate.)
6. **Create.** Note the ALB's **DNS name** (e.g. `marketbase-alb-123.ap-south-1.elb.amazonaws.com`) — that's your app's public address.

## 3E. Auto Scaling Group

> **What:** keeps the right number of instances running across both AZs, replaces unhealthy ones automatically, and scales on load (Module 3.4 — self-healing + elastic).

1. EC2 → **Auto Scaling Groups** → **Create**. Name `marketbase-asg`.
2. **Launch template:** `marketbase-lt`. Next.
3. **Network:** VPC `marketbase`, select the **two private app subnets** (private1 pair, both AZs). *Why: instances live in private subnets — unreachable directly from the internet, only via the ALB.*
4. **Load balancing:** attach to existing → **`marketbase-tg`**. **Health checks:** turn on **ELB** health checks (so the ASG replaces instances the ALB marks unhealthy).
5. **Group size:** Desired **2**, Min **2**, Max **4**. *Why: min 2 across 2 AZs guarantees one per AZ — survives an AZ loss; max 4 allows scale-out.*
6. **Scaling policy:** **Target tracking** → metric **Average CPU utilization** → target **50%**. *Why: scales out when CPU rises, in when it falls — automatic elasticity (Module 3.4).*
7. **Create.** The ASG launches 2 instances into the private subnets and registers them with the target group.

## 3F. Verify it's serving

1. EC2 → Target groups → `marketbase-tg` → **Targets** → wait until both instances are **healthy**.
2. Open `http://<ALB-DNS-name>/` in a browser → you see the MarketBase page. Reload a few times → the hostname in the page changes as the ALB balances across the two instances. *That's load balancing across AZs, live.*

---

# PART 4 — WIRE THE APP TO THE DATABASE (concept + optional)

> **Why:** in a real app the EC2 code fetches DB credentials from Secrets Manager at runtime and connects to the RDS endpoint. Our demo app is static HTML, so this is the pattern to *document* (and optionally test from an instance).

The production pattern (state it in your README):
1. The instance's IAM role grants `secretsmanager:GetSecretValue` on the DB secret only (least privilege).
2. App code at startup calls Secrets Manager, gets `{username, password, host, port}`, connects to RDS.
3. No credentials in code or config — fetched at runtime via the role (Module 3.18).

Optional test: connect to an instance via **Session Manager** (EC2 → instance → Connect → Session Manager), install a DB client, and confirm you can reach the RDS endpoint on 3306 (proving the SG chain app→db works) — but you cannot reach it from your laptop (proving it's private).

---

# PART 5 — OBSERVABILITY

> **What:** CloudWatch watches the system and drives both alerting and the scaling you configured (Module 3.7).

1. CloudWatch → **Dashboards** → create `marketbase` → add widgets: ALB request count, target response time, healthy host count, ASG CPU.
2. CloudWatch → **Alarms** → create an alarm on ASG average CPU > 70% → action: notify an SNS topic (email). *Why: you want to know when the system is under stress, beyond just auto-scaling.*

---

# PART 6 — PROVE HIGH AVAILABILITY (the demonstration)

> This is what makes it a portfolio piece — *show* the resilience. Screenshot each.

1. **Self-healing:** EC2 → Instances → terminate one of the two ASG instances. Watch the ASG detect it and launch a replacement automatically (Activity tab), and the ALB keep serving from the surviving instance the whole time. *No downtime from an instance failure.*
2. **Scaling (optional):** SSH/Session-Manager into an instance and run a CPU load (`yes > /dev/null &` a few times) → watch CPU climb → the ASG scales out toward Max → kill the load → it scales back in.
3. **Multi-AZ DB failover (optional, screenshot-worthy):** RDS → `marketbase-db` → **Actions → Reboot** → check **Reboot with failover** → the standby in AZ B is promoted to primary automatically; the endpoint stays the same so the app reconnects. *Automatic database failover, no endpoint change.*

---

## Where this leads
ShopFront was serverless and scales-to-zero; MarketBase is the always-on, highly-available, server-based counterpart. Project 3 (OrderFlow) returns to serverless but adds the **event-driven decoupling** trio (SQS/SNS/EventBridge) you learned — the resilient backend behind a checkout.
