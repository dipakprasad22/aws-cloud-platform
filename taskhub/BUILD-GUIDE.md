# TaskHub: Build & Deploy Guide

> A **real working application** — a task & project management REST API (Node.js/Express) with a web front-end,
> deployed as a **full manual three-tier** architecture (EC2 + ALB + RDS), like MarketBase but running real code.

---

## What you're building

```
Presentation:  static front-end (index.html) on S3 + CloudFront
Application:   Node/Express REST API on EC2 (Auto Scaling Group, 2 AZs) behind an ALB
Data:          RDS PostgreSQL (Multi-AZ) + Secrets Manager (DB credentials)
```

**The app itself (real code, provided):**
- **Auth:** register/login, bcrypt-hashed passwords, JWT tokens.
- **Data model:** `users → projects → tasks` (one-to-many down the chain, FK cascades).
- **API:** full CRUD for projects and tasks, every query scoped to the authenticated user.
- **Front-end:** a single-page UI to register, create projects, and manage tasks.

**Three-tier mapping:** front-end (S3/CloudFront) = presentation; Express API on EC2 behind ALB = application; RDS PostgreSQL = data. Secrets Manager holds DB credentials (fetched at runtime, never hardcoded).

**Region:** one region throughout (e.g. `ap-south-1`).

> ⚠️ **Cost:** like MarketBase, the ALB + NAT + Multi-AZ RDS are billable. Build, test, screenshot, **tear down same day.**

---

## The code

You have the full backend and front-end (provided as files). Layout:
```
taskhub/
  backend/
    package.json
    .env.example
    src/
      server.js            # Express entry: middleware, routes, /health
      db/pool.js           # PG pool; fetches creds from Secrets Manager in prod
      db/migrate.js        # creates users/projects/tasks tables
      middleware/auth.js   # JWT verification
      routes/auth.js       # register + login
      routes/projects.js   # project CRUD (user-scoped)
      routes/tasks.js      # task CRUD (nested under projects)
  frontend/
    index.html             # single-file UI (set API base near the top)
```

### Run it locally first (recommended, 10 min)
> **Why:** prove the app works on your machine before deploying — separates app bugs from infra bugs.
1. Install PostgreSQL locally (or run it in Docker). Create a `taskhub` database.
2. `cd backend && cp .env.example .env` → set local DB creds + a `JWT_SECRET`.
3. `npm install` → `npm run migrate` → `npm start`.
4. `curl localhost:3000/health` → `{"status":"ok"}`.
5. Register + create a project + add a task via curl (see the API reference at the end), or open `frontend/index.html` with `API` set to `http://localhost:3000`.

---

# STAGE 1 — NETWORK + DATA (same shape as MarketBase)

> **Why first:** the app server and database live inside this network.

1. **VPC** — VPC → "VPC and more" wizard → `taskhub`, `10.0.0.0/16`, **2 AZs**, 2 public + 4 private subnets, **NAT in 1 AZ**. Create.
   *Why: 2-AZ network; NAT lets private app instances reach the internet (npm, Secrets Manager, RDS CA).*
2. **Security groups** (in order):
   - `taskhub-alb-sg`: inbound 80/443 from `0.0.0.0/0`.
   - `taskhub-app-sg`: inbound **3000** from source `taskhub-alb-sg`. *(Express listens on 3000.)*
   - `taskhub-db-sg`: inbound **5432** from source `taskhub-app-sg`. *(PostgreSQL.)*
   *Why: the SG-by-identity chain — DB trusts only the app, app trusts only the ALB.*
3. **DB subnet group** — RDS → Subnet groups → `taskhub-db-subnets`, both AZs, the two private data subnets.
4. **RDS PostgreSQL** — RDS → Create → **PostgreSQL** → **Multi-AZ**, identifier `taskhub-db`, master `taskhubadmin`, **Credentials managed in Secrets Manager**, `db.t3.micro`, VPC `taskhub`, subnet group `taskhub-db-subnets`, **Public access NO**, SG `taskhub-db-sg`, initial DB name `taskhub`. Create.
   *Why: managed, HA database; Secrets Manager holds the password so the app fetches it at runtime. Note the secret's name (e.g. `taskhub/db-credentials` or the auto-generated one) — the app needs it.*

**✅ Stage 1 checkpoint: VPC, 3 SGs, subnet group, RDS (Multi-AZ, private, Secrets-managed) created.**

---

# STAGE 2 — GOLDEN AMI WITH THE REAL APP

> **What:** bake an image that has Node, your app code, and a service that auto-starts the API — so every ASG instance boots running TaskHub. (Lesson from MarketBase: verify the app works *before* imaging.)

## 2A. Get your code reachable (3 min)
Push the `taskhub/` repo to GitHub (public, or use a deploy token), OR plan to `scp`/paste it. The user-data below clones from GitHub — adjust the URL.

## 2B. Launch a build instance (10 min)
1. EC2 → Launch instance → `taskhub-golden`, Amazon Linux 2023, `t3.micro`, VPC `taskhub`, a **public subnet**, public IP on, IAM role with `AmazonSSMManagedInstanceCore` **and** a policy allowing `secretsmanager:GetSecretValue` on your DB secret (least privilege).
2. **User data** (installs Node, fetches app, sets it up as a service):
```bash
#!/bin/bash
dnf install -y nodejs git
cd /opt
git clone https://github.com/<you>/taskhub.git
cd taskhub/backend
npm install --omit=dev
# environment for production: use Secrets Manager, not a password
cat > /opt/taskhub/backend/.env <<EOF
PORT=3000
JWT_SECRET=$(openssl rand -hex 32)
AWS_REGION=ap-south-1
DB_SECRET_NAME=<your-db-secret-name>
DB_HOST=<your-rds-endpoint>
DB_NAME=taskhub
EOF
# systemd service so it auto-starts and restarts
cat > /etc/systemd/system/taskhub.service <<EOF
[Unit]
Description=TaskHub API
After=network.target
[Service]
WorkingDirectory=/opt/taskhub/backend
ExecStart=/usr/bin/node src/server.js
Restart=always
EnvironmentFile=/opt/taskhub/backend/.env
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now taskhub
```
3. Wait, then connect via Session Manager and verify:
```bash
sudo systemctl status taskhub      # should be active (running)
curl -i http://localhost:3000/health   # {"status":"ok"}
```
*If health is 200, the app is running and can reach the DB via Secrets Manager.*

## 2C. Run the migration once (3 min)
> The schema must exist before the app is useful. Run it once against RDS from the build instance:
```bash
cd /opt/taskhub/backend && npm run migrate    # creates users/projects/tasks
```
*Why once: the tables persist in RDS; ASG instances don't each need to migrate.*

## 2D. Bake the AMI (5 min)
Only after `curl localhost:3000/health` returns 200: EC2 → select instance → Create image → `taskhub-ami` → wait **Available** → **terminate** the build instance.
*Why: the image now contains Node + app + the auto-start service; every ASG instance boots serving.*

**✅ Stage 2 checkpoint: golden AMI with a verified, auto-starting TaskHub API.**

---

# STAGE 3 — APP TIER (ALB + ASG)  — same pattern as MarketBase

1. **Launch template** `taskhub-lt`: AMI `taskhub-ami` (My AMIs tab), `t3.micro`, SG `taskhub-app-sg`, the SSM+Secrets IAM role.
2. **Target group** `taskhub-tg`: Instances, **HTTP 3000**, VPC `taskhub`, health check path **`/health`**.
   *Why port 3000: that's where Express listens.*
3. **ALB** `taskhub-alb`: internet-facing, both public subnets, SG `taskhub-alb-sg`, listener **HTTP 80 → forward to `taskhub-tg`**. Note the DNS name.
   *Why: the ALB listens on 80 for users and forwards to the app on 3000.*
4. **ASG** `taskhub-asg`: launch template `taskhub-lt`, the two **private app subnets**, attach `taskhub-tg`, **ELB health checks on**, Desired/Min **2**, Max **4**, target-tracking CPU 50%.
5. Verify: target group → both targets **healthy** → `curl http://<ALB-DNS>/health` → `{"status":"ok"}`. Register a user through the ALB:
```bash
curl -X POST http://<ALB-DNS>/api/auth/register -H "Content-Type: application/json" \
  -d '{"email":"dipak@example.com","password":"password123","name":"Dipak"}'
```
→ returns a token. The real app is live behind the load balancer.

**✅ Stage 3 checkpoint: TaskHub API serving through the ALB, healthy targets, register/login working.**

---

# STAGE 4 — PRESENTATION (front-end on S3 + CloudFront)

1. Edit `frontend/index.html` → set `const API = "http://<ALB-DNS>"` (or your CloudFront/HTTPS domain if you add one).
2. S3 → create a **private** bucket → upload `index.html`.
3. CloudFront → distribution over the bucket with **OAC** → apply the bucket policy → default root object `index.html`.
4. Open the CloudFront URL → register, create a project, add tasks → it all persists to RDS through the API. **The full three-tier app works end-to-end.**

> Note: front-end on CloudFront (HTTPS) calling an ALB on HTTP can cause mixed-content blocking. For a clean demo, either add HTTPS to the ALB (ACM cert + 443 listener) or run the front-end pointing directly at the ALB over HTTP. Document this.

**✅ Stage 4 checkpoint: front-end → API → database, full app working.**

---

# STAGE 5 — PROVE IT + OBSERVE

1. **Self-healing:** terminate an ASG instance → ASG replaces it → app stays up (the data is in RDS, so instances are stateless/disposable — the whole point).
2. **Persistence across instances:** create data, terminate the instance that served you, confirm the data is still there (it's in RDS, not on the instance).
3. **CloudWatch:** dashboard with ALB request count, target health, ASG CPU; alarm on CPU.

**✅ Stage 5 checkpoint: resilience demonstrated, app state safely in RDS.**

---

# API REFERENCE (for the README / testing)

```
POST /api/auth/register   {email,password,name} -> {token,user}
POST /api/auth/login      {email,password}       -> {token,user}
# All below require header: Authorization: Bearer <token>
GET    /api/projects
POST   /api/projects                 {name,description}
GET    /api/projects/:id
PUT    /api/projects/:id             {name?,description?}
DELETE /api/projects/:id
GET    /api/projects/:pid/tasks
POST   /api/projects/:pid/tasks      {title,status?,priority?,due_date?}
PUT    /api/projects/:pid/tasks/:tid {title?,status?,priority?,due_date?}
DELETE /api/projects/:pid/tasks/:tid
```

---

# TROUBLESHOOTING

| Symptom | Cause | Fix |
|---|---|---|
| Targets unhealthy | Health check port/path, or app not running | TG port must be 3000, path `/health`; check `systemctl status taskhub` |
| App can't connect to DB | Secret/permission/SG issue | Role needs `secretsmanager:GetSecretValue` + `kms:Decrypt`; db-sg must allow app-sg on 5432 |
| 500 on register/login | Migration not run | Run `npm run migrate` once against RDS |
| Front-end calls fail (mixed content) | HTTPS page calling HTTP API | Add HTTPS to ALB, or serve front-end over HTTP for the demo |
| App starts then dies | Bad .env / can't reach Secrets Manager | Check the service logs: `journalctl -u taskhub` |
| 401 on protected routes | Missing/expired token | Include `Authorization: Bearer <token>` |

## Where this leads
TaskHub is your first **real-application** deployment — actual code, auth, relational data, on HA infrastructure. Next: **InventoryIQ** (Java/Spring Boot) — the enterprise-stack counterpart, with transactional order processing and a layered architecture.
