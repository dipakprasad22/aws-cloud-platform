# InventoryIQ: Build & Deploy Guide

> A **real enterprise-Java application** — an inventory & order management REST API (Spring Boot + PostgreSQL),
> deployed as a **full manual three-tier** architecture (EC2 + ALB + RDS).

> The enterprise-stack counterpart to TaskHub: layered architecture (controller → service → repository),
> JPA/Hibernate, Bean Validation, and — the real differentiator — **transactional order processing**
> where placing an order decrements stock atomically and rolls back entirely on any failure.

---

## What you're building

```
Application:   Spring Boot REST API on EC2 (Auto Scaling Group, 2 AZs) behind an ALB
Data:          RDS PostgreSQL (Multi-AZ) + Secrets Manager (DB credentials)
Presentation:  documented REST API (test with curl/Postman) — optional simple front-end
```

**The app itself (real code, provided):**
- **Layered architecture:** `controller → service → repository → database` — the standard enterprise Spring structure.
- **Data model:** `Product` (with stock + a `@Version` optimistic-lock field), `Order`, `OrderItem`.
- **The core business logic — transactional order placement:** placing an order checks stock for every line, decrements it, computes the total, and saves the order — all in **one transaction**. If any line has insufficient stock, the *entire* transaction rolls back (no partial orders, no stray stock decrements). `@Version` optimistic locking prevents two concurrent orders from overselling the last unit.
- **Validation & error handling:** Bean Validation on inputs; a global exception handler maps errors to clean HTTP codes (404 not found, 409 insufficient stock, 400 validation).

**Three-tier mapping:** REST clients/front-end = presentation; Spring Boot on EC2 behind ALB = application; RDS PostgreSQL = data. Secrets Manager holds DB credentials.

**Region:** one region (e.g. `ap-south-1`).

> ⚠️ **Cost:** ALB + NAT + Multi-AZ RDS are billable — build, demonstrate, **tear down same day.**

---

## The code

```
inventoryiq/
  pom.xml                        # Maven build (Spring Boot 3.3, Java 17)
  src/main/resources/
    application.properties       # JPA, actuator health, local DB defaults
  src/main/java/com/inventoryiq/
    InventoryIqApplication.java  # main()
    model/                       # Product, Order, OrderItem (JPA entities)
    repository/                  # ProductRepository, OrderRepository (Spring Data JPA)
    dto/Dtos.java                # request payloads with validation constraints
    service/                     # ProductService, OrderService (TRANSACTIONAL logic)
    controller/                  # ProductController, OrderController, GlobalExceptionHandler
    config/DataSourceConfig.java # fetches DB creds from Secrets Manager in prod
    exception/ApiExceptions.java # NotFound, InsufficientStock
```

### Run it locally first (recommended, 10 min)
> Prove the app + business logic work before deploying — separates app bugs from infra bugs.
1. Install JDK 17+ and Maven; install/run PostgreSQL; create an `inventoryiq` database.
2. (Local uses `application.properties` defaults — adjust the datasource lines if needed.)
3. `mvn spring-boot:run` (Hibernate auto-creates the tables from the entities).
4. `curl localhost:8080/actuator/health` → `{"status":"UP"}`.
5. Exercise the business logic (see API reference) — create a product, place an order, watch stock drop; try to over-order and see the 409 with no stock change.

---

# STAGE 1 — NETWORK + DATA (same shape as MarketBase/TaskHub)

1. **VPC** — "VPC and more" wizard → `inventoryiq`, `10.0.0.0/16`, 2 AZs, 2 public + 4 private subnets, NAT in 1 AZ.
2. **Security groups** (in order):
   - `iq-alb-sg`: inbound 80/443 from `0.0.0.0/0`.
   - `iq-app-sg`: inbound **8080** from source `iq-alb-sg`. *(Spring Boot listens on 8080.)*
   - `iq-db-sg`: inbound **5432** from source `iq-app-sg`.
3. **DB subnet group** — `iq-db-subnets`, both AZs, the two private data subnets.
4. **RDS PostgreSQL** — Multi-AZ, identifier `inventoryiq-db`, master `iqadmin`, **Credentials managed in Secrets Manager**, `db.t3.micro`, VPC `inventoryiq`, subnet group `iq-db-subnets`, **Public access NO**, SG `iq-db-sg`, initial DB name `inventoryiq`. Note the secret name + endpoint.

**✅ Stage 1 checkpoint: network + private Multi-AZ RDS created.**

---

# STAGE 2 — BUILD THE JAR + GOLDEN AMI

> **What:** Spring Boot packages into a single runnable JAR. Bake an AMI with Java + the JAR + an auto-start service.

## 2A. Build the JAR (local or on the build instance)
`mvn clean package -DskipTests` → produces `target/inventoryiq-1.0.0.jar`. Push the repo to GitHub, or plan to copy the JAR up.

## 2B. Build instance (10 min)
1. EC2 → `iq-golden`, Amazon Linux 2023, `t3.micro`, VPC `inventoryiq`, **public subnet**, public IP, IAM role with `AmazonSSMManagedInstanceCore` + `secretsmanager:GetSecretValue` on the DB secret.
2. **User data:**
```bash
#!/bin/bash
dnf install -y java-17-amazon-corretto git maven
cd /opt
git clone https://github.com/<you>/inventoryiq.git
cd inventoryiq
mvn clean package -DskipTests
cp target/inventoryiq-1.0.0.jar /opt/app.jar
cat > /etc/systemd/system/inventoryiq.service <<EOF
[Unit]
Description=InventoryIQ
After=network.target
[Service]
Environment=DB_SECRET_NAME=<your-db-secret-name>
Environment=DB_HOST=<your-rds-endpoint>
Environment=DB_NAME=inventoryiq
Environment=AWS_REGION=ap-south-1
ExecStart=/usr/bin/java -jar /opt/app.jar
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now inventoryiq
```
3. Verify via Session Manager:
```bash
sudo systemctl status inventoryiq
curl -i http://localhost:8080/actuator/health    # {"status":"UP"}
```
*Hibernate auto-creates the tables on first start (ddl-auto=update), so no separate migration step.*

## 2C. Bake the AMI
Only after health is UP: create image `iq-ami` → wait Available → terminate the build instance.

**✅ Stage 2 checkpoint: golden AMI with a verified, auto-starting Spring Boot app.**

---

# STAGE 3 — APP TIER (ALB + ASG)

1. **Launch template** `iq-lt`: AMI `iq-ami`, `t3.micro` (give it a bit more memory — `t3.small` if the JVM is tight), SG `iq-app-sg`, the SSM+Secrets role.
2. **Target group** `iq-tg`: Instances, **HTTP 8080**, health check path **`/actuator/health`**.
3. **ALB** `iq-alb`: internet-facing, both public subnets, SG `iq-alb-sg`, listener **80 → forward to `iq-tg`**.
4. **ASG** `iq-asg`: launch template, two private app subnets, attach `iq-tg`, ELB health checks on, Desired/Min 2, Max 4, target-tracking CPU 50%.
5. Verify: targets healthy → exercise via the ALB:
```bash
# create a product
curl -X POST http://<ALB-DNS>/api/products -H "Content-Type: application/json" \
  -d '{"name":"Widget","sku":"W-001","price":9.99,"stock":100}'
# place an order
curl -X POST http://<ALB-DNS>/api/orders -H "Content-Type: application/json" \
  -d '{"customer":"Acme","items":[{"productId":1,"quantity":5}]}'
# confirm stock dropped to 95
curl http://<ALB-DNS>/api/products/1
```

**✅ Stage 3 checkpoint: Spring Boot API serving through the ALB; orders decrement stock.**

---

# STAGE 4 — DEMONSTRATE THE BUSINESS LOGIC (the portfolio money-shot)

> This is what makes InventoryIQ stand out — show the *transactional integrity*, not just CRUD.

1. **Atomic decrement:** create a product with stock 10, place an order for 3, confirm stock = 7.
2. **Rollback on insufficient stock:** place an order whose total exceeds available stock (or one line valid, one line over) → you get **409 Insufficient stock** AND the stock for the *valid* line is unchanged (the whole transaction rolled back). Screenshot the 409 + the unchanged stock — that's the transactional-integrity proof.
3. **Self-healing:** terminate an ASG instance → ASG replaces it → API stays up; data persists (it's in RDS).

**✅ Stage 4 checkpoint: transactional rollback demonstrated, self-healing shown.**

---

# API REFERENCE

```
GET    /actuator/health                         -> {"status":"UP"}
GET    /api/products
GET    /api/products/{id}
POST   /api/products        {name,sku,price,stock}
PATCH  /api/products/{id}/stock   {delta}        # +restock / -remove
POST   /api/orders          {customer, items:[{productId,quantity}]}   -> 201 (or 409 if short)
GET    /api/orders/{id}
```
Status codes: 201 created, 400 validation, 404 not found, 409 insufficient stock.

---

# TROUBLESHOOTING

| Symptom | Cause | Fix |
|---|---|---|
| Targets unhealthy | TG port not 8080 / wrong health path | Port 8080, path `/actuator/health`; check `systemctl status inventoryiq` |
| App won't start | Can't reach DB / Secrets Manager | Role needs GetSecretValue + kms:Decrypt; db-sg allows app-sg:5432; check `journalctl -u inventoryiq` |
| 500 on first request | DB unreachable / schema not created | Confirm RDS endpoint + ddl-auto=update; check logs |
| Order returns 409 unexpectedly | Stock genuinely insufficient | That's correct behavior — the rollback working |
| Out-of-memory on t3.micro | JVM heap | Use t3.small, or cap heap with `-Xmx` in ExecStart |
| Build fails (mvn) | No internet / wrong Java | Build needs Maven Central access + JDK 17 |

---

## Where this leads
You now have two real-application deployments in different stacks: TaskHub (Node/Express, lightweight SaaS pattern) and InventoryIQ (Java/Spring Boot, enterprise pattern with transactional integrity). Together they show real range — and pair with your AWS-architecture projects (1-4) to make a portfolio that demonstrates both *building apps* and *architecting cloud systems*.
