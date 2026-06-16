# Project 3 — OrderFlow: Build Guide

> An event-driven order-processing backend — the resilient, decoupled backbone behind a checkout.
> Uses the full integration trio (SQS / SNS / EventBridge) + Step Functions orchestration + X-Ray tracing.
> Fully serverless · near-$0 · no teardown urgency (scales to zero when idle).

> **Build order (inside-out):** data → intake → fan-out core → consumers → EventBridge routing → Step Functions → X-Ray. Each layer builds on the one before.

---

## What you're building

```
Intake:        checkout → API Gateway (POST /order) → intake Lambda → DynamoDB (order saved)
Fan-out core:  intake Lambda → SNS topic → 3 SQS queues (payment, inventory, notification)
                                              → 3 consumer Lambdas, each with a DLQ
Routing:       EventBridge → route special events (high-value → review, payment-failed → recovery)
Orchestration: Step Functions → ordered workflow (validate → charge → reserve → confirm, + compensate)
Tracing:       X-Ray → follow one order across all the decoupled services
```

**Why event-driven (the core idea):** A checkout shouldn't call payment, then inventory, then email in a blocking chain — if one is slow or down, the whole order fails. Instead, the order is *published once* and each step reacts *independently*. A failed step retries on its own without breaking the others; a burst of orders buffers in queues instead of overwhelming anything; nothing is ever lost.

**Three-tier framing:** Presentation/intake = API Gateway + intake Lambda. Application = the Lambdas, queues, topic, bus, and state machine (the distributed logic). Data = DynamoDB (order + status) + DLQs (durable failure storage).

**Region:** one region throughout (e.g. `ap-south-1`).

**Cost:** SQS, SNS, Lambda, DynamoDB, EventBridge, Step Functions, X-Ray all have free tiers covering this build comfortably — effectively $0. No rush to tear down, though deleting at the end keeps things tidy.

---

# STAGE 1 — DATA + INTAKE

## 1A. DynamoDB orders table (3 min)

> **What:** stores each order and its evolving status (placed → paid → reserved → confirmed). The single source of truth for an order's state across all the async steps.

1. DynamoDB → Create table → name `orderflow-orders`, partition key `orderId` (String), default settings → Create.

## 1B. SNS topic — the fan-out hub (3 min)

> **What:** the `order-placed` topic that one publish fans out to every downstream step. Decouples the intake from the (changing) set of consumers.

1. SNS → Topics → Create topic → Standard → name `orderflow-order-placed` → Create. Copy its ARN.

## 1C. Intake Lambda (10 min)

> **What:** receives the order from API Gateway, validates it, saves it to DynamoDB with status `PLACED`, and publishes to the SNS topic. The single entry point.

1. Lambda → Create function → `orderflow-intake`, Python 3.12, new basic role → Create.
2. Permissions (Configuration → Permissions → role → add inline policy, JSON; replace ARNs):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "dynamodb:PutItem", "Resource": "arn:aws:dynamodb:REGION:ACCOUNT:table/orderflow-orders" },
    { "Effect": "Allow", "Action": "sns:Publish", "Resource": "arn:aws:sns:REGION:ACCOUNT:orderflow-order-placed" }
  ]
}
```
> *Why: least privilege — intake can only write orders and publish the event, nothing else.*
3. Code:
```python
import json, os, uuid, datetime, boto3
ddb = boto3.client("dynamodb"); sns = boto3.client("sns")
TABLE = "orderflow-orders"; TOPIC = os.environ["TOPIC_ARN"]
CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"POST,OPTIONS"}
def _r(s,b): return {"statusCode":s,"headers":CORS,"body":json.dumps(b)}
def handler(event, ctx):
    if event.get("requestContext",{}).get("http",{}).get("method")=="OPTIONS": return _r(200,{"ok":True})
    try: d = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError: return _r(400,{"error":"bad json"})
    cust = (d.get("customer") or "").strip()
    amount = d.get("amount")
    if not cust or amount is None: return _r(400,{"error":"customer and amount required"})
    oid = str(uuid.uuid4()); now = datetime.datetime.utcnow().isoformat()+"Z"
    ddb.put_item(TableName=TABLE, Item={"orderId":{"S":oid},"customer":{"S":cust},"amount":{"N":str(amount)},"status":{"S":"PLACED"},"createdAt":{"S":now}})
    sns.publish(TopicArn=TOPIC, Message=json.dumps({"orderId":oid,"customer":cust,"amount":amount}),
                Subject="order-placed",
                MessageAttributes={"amount":{"DataType":"Number","StringValue":str(amount)}})
    return _r(200,{"ok":True,"orderId":oid})
```
> *Note the `MessageAttributes` with `amount` — EventBridge/SNS filtering will use it later.*
4. Handler = `lambda_function.handler`. Env var `TOPIC_ARN` = the topic ARN. Deploy.

## 1D. API Gateway (6 min)

> **What:** the public POST /order endpoint that invokes the intake Lambda.

1. API Gateway → HTTP API → Build → integration Lambda `orderflow-intake`, name `orderflow-api`.
2. Route: POST `/order` → the Lambda. Default stage. Create.
3. CORS: allow origin `*`, methods `POST,OPTIONS`, headers `content-type`.
4. Copy the invoke URL.

## 1E. Test Stage 1

```bash
curl -X POST <invoke-url>/order -H "Content-Type: application/json" -d '{"customer":"Dipak","amount":1500}'
```
Expect `{"ok":true,"orderId":"..."}` and a new item in `orderflow-orders` with status `PLACED`. (SNS has no subscribers yet — that's Stage 2.)

**✅ Stage 1 checkpoint: order intake works, order persisted, event published.**

---

# STAGE 2 — DURABLE FAN-OUT CORE (the heart)

> **What:** three SQS queues subscribed to the SNS topic, each with a DLQ and a consumer Lambda. One published order → all three steps process independently and durably.

## 2A. Create 3 queues + 3 DLQs (10 min)

> **Why DLQs:** a poison message that always fails moves to its DLQ after N tries instead of looping forever or blocking the queue (Module 3.14).

For each of `payment`, `inventory`, `notification`:
1. SQS → Create queue → Standard → name `orderflow-<name>-dlq` → Create. (Make the DLQ first.)
2. SQS → Create queue → Standard → name `orderflow-<name>` → under **Dead-letter queue**, enable → select `orderflow-<name>-dlq`, Max receives **3** → Create.

So you'll have 6 queues: 3 main + 3 DLQ.

## 2B. Subscribe the queues to the SNS topic (6 min)

> **Why:** this is the SNS→SQS durable fan-out — each queue gets its own copy and holds it until its consumer succeeds, surviving consumer downtime (Module 3.15).

1. SNS → `orderflow-order-placed` → Create subscription → protocol **Amazon SQS** → select `orderflow-payment` → Create. (Allow SNS to send to the queue — accept the console's offer to set the access policy, or add it.)
2. Repeat for `orderflow-inventory` and `orderflow-notification`.
3. (Optional filtering demo: on the notification subscription, add a filter policy so it only fires for `amount > 1000`, using the `amount` message attribute.)

## 2C. Three consumer Lambdas (15 min)

> **What:** each consumes its queue, does its job (simulated), and updates the order's status in DynamoDB. SQS triggers them and handles polling/deletion automatically.

For each consumer (`orderflow-payment-consumer`, `-inventory-consumer`, `-notification-consumer`):
1. Lambda → Create function → Python 3.12 → new basic role.
2. Add inline policy allowing `dynamodb:UpdateItem` on the orders table (least privilege).
3. Code (adjust the `STEP`/`STATUS` per consumer — e.g. payment→`PAID`, inventory→`RESERVED`, notification→`NOTIFIED`):
```python
import json, boto3
ddb = boto3.client("dynamodb"); TABLE = "orderflow-orders"
STEP = "payment"; STATUS = "PAID"   # change per consumer
def handler(event, ctx):
    for rec in event["Records"]:                       # SQS batch
        body = json.loads(rec["body"])                 # SNS envelope
        msg = json.loads(body["Message"])              # original order
        oid = msg["orderId"]
        # ... do the real work here (charge / reserve / notify) ...
        ddb.update_item(TableName=TABLE, Key={"orderId":{"S":oid}},
            UpdateExpression="SET #s = :v", ExpressionAttributeNames={"#s":"status"},
            ExpressionAttributeValues={":v":{"S":STATUS}})
        print(f"{STEP} done for {oid}")
    return {"ok": True}
```
> *Note: the SQS record's `body` is the SNS envelope; the original order is in `body["Message"]` — a common gotcha.*
4. Handler set, Deploy. Then **add the SQS trigger:** Lambda → Add trigger → SQS → its queue.

## 2D. Test the fan-out

1. POST another order via curl. 
2. Watch all three consumer Lambdas fire (CloudWatch logs), and the order's `status` in DynamoDB update.
3. **Prove durability:** disable one consumer's trigger (or add an error), POST an order, see the message wait in that queue; re-enable, watch it process. Force repeated failures → see a message land in that queue's DLQ.

**✅ Stage 2 checkpoint: one order fans out to three independent, durable, DLQ-protected pipelines.**

---

# STAGE 3 — EVENTBRIDGE ROUTING

> **What:** content-based routing for *special* events — high-value orders to a review handler, failed payments to a recovery handler — without touching the intake or existing consumers (Module 3.16).

## 3A. Emit an event to EventBridge (5 min)

> Two options. Simplest: have a consumer (e.g. payment) `put_events` to EventBridge on certain conditions. We'll route on order value.

1. Give the intake (or payment) Lambda permission `events:PutEvents`.
2. In that Lambda, after processing, emit an event:
```python
import boto3; eb = boto3.client("events")
eb.put_events(Entries=[{
  "Source":"orderflow.orders","DetailType":"order-processed",
  "Detail": json.dumps({"orderId":oid,"amount":amount,"paymentResult":"ok"})
}])
```

## 3B. Rules that route by content (8 min)

> **Why:** each business reaction is a rule with a pattern — add a reaction = add a rule, zero change to producers.

1. EventBridge → Rules → Create rule `orderflow-high-value` → event pattern:
```json
{ "source": ["orderflow.orders"], "detail": { "amount": [{ "numeric": [">", 5000] }] } }
```
→ target a `orderflow-review` Lambda (or SNS email). *Why: high-value orders get manager review.*
2. Create rule `orderflow-payment-failed` → pattern matching `detail.paymentResult = "failed"` → target a recovery Lambda. *Why: failed payments enter a recovery flow.*
3. Test: emit events with different amounts/results → confirm only matching ones trigger their targets.

**✅ Stage 3 checkpoint: special events route to the right handlers by content.**

---

# STAGE 4 — STEP FUNCTIONS ORCHESTRATION

> **What:** for the steps that must happen *in order* with conditional logic (validate → charge → on success reserve stock → confirm; on failure compensate/refund), a state machine makes the flow explicit, visual, and recoverable (Module 3.12 orchestration). This complements the fan-out: fan-out is for independent parallel steps; Step Functions is for ordered dependent steps.

## 4A. Create the worker Lambdas (or reuse) (8 min)

> Small single-purpose Lambdas the state machine calls: `sf-validate`, `sf-charge`, `sf-reserve`, `sf-confirm`, `sf-refund` (compensation). Each takes the order, does its bit, returns success/failure. Keep them simple (return a JSON status).

## 4B. Build the state machine (12 min)

> **What:** the ordered workflow with a failure path.

1. Step Functions → Create state machine → **Design with code/workflow studio** → Standard.
2. Define states: `Validate → Charge → Reserve → Confirm`, with a **Catch** on `Charge`/`Reserve` routing to `Refund` (compensation) then `Fail`. Each state is a Lambda invoke task.
3. Example (Amazon States Language sketch):
```json
{
  "StartAt": "Validate",
  "States": {
    "Validate": {"Type":"Task","Resource":"arn:...:sf-validate","Next":"Charge"},
    "Charge": {"Type":"Task","Resource":"arn:...:sf-charge","Catch":[{"ErrorEquals":["States.ALL"],"Next":"Refund"}],"Next":"Reserve"},
    "Reserve": {"Type":"Task","Resource":"arn:...:sf-reserve","Catch":[{"ErrorEquals":["States.ALL"],"Next":"Refund"}],"Next":"Confirm"},
    "Confirm": {"Type":"Task","Resource":"arn:...:sf-confirm","End":true},
    "Refund": {"Type":"Task","Resource":"arn:...:sf-refund","Next":"Fail"},
    "Fail": {"Type":"Fail"}
  }
}
```
4. Create (the wizard creates an execution role; ensure it can invoke the Lambdas).
5. **Start an execution** with a sample order input → watch the visual graph light up green step by step. Force `Charge` to throw → watch it route to `Refund` then `Fail` (compensation in action).

> **When to use which:** Step Functions for *ordered, dependent, must-rollback* workflows; SNS+SQS fan-out for *independent, parallel* reactions. OrderFlow uses both — that's the senior insight.

**✅ Stage 4 checkpoint: ordered workflow with compensation runs and is visible in the graph.**

---

# STAGE 5 — X-RAY TRACING

> **What is X-Ray:** distributed tracing — it follows a *single request* as it hops across API Gateway → Lambda → SNS → SQS → Lambda → DynamoDB, showing a timeline of where time was spent and where errors occurred. In an event-driven system with many decoupled hops, this is what makes the whole thing *debuggable* — without it, a slow or failing order is a needle in a haystack of separate logs.
>
> **Why here:** OrderFlow is exactly the case X-Ray exists for — many services, one logical request. (This is the module we deferred; it makes far more sense attached to a real distributed system.)

## 5A. Enable tracing (6 min)

1. **Lambda:** for each function → Configuration → **Monitoring and operations tools** → enable **Active tracing** (X-Ray). Add the `AWSXRayDaemonWriteAccess` managed policy to each function's role.
2. **API Gateway:** your API → Stage → enable **X-Ray tracing**.
3. (Optional, deeper traces: add the AWS X-Ray SDK to the Lambda code to create subsegments — but active tracing alone gives you the service map.)

## 5B. View the trace

1. POST a few orders. 
2. X-Ray (in CloudWatch → **X-Ray traces** / **Service map**) → see the **service map**: API Gateway → intake Lambda → SNS → (queues) → consumer Lambdas → DynamoDB, with latencies and any errors highlighted.
3. Click a trace → see the timeline of one order's journey across services.

> *This service map is a fantastic blog/portfolio visual — it literally draws your architecture from real traffic.*

**✅ Stage 5 checkpoint: one order's path is visible end-to-end in the X-Ray service map.**

---

# VERIFY CHECKLIST

- [ ] POST /order → order saved `PLACED`, event published.
- [ ] All three queues receive a copy; all three consumers update status; statuses progress.
- [ ] Disabling a consumer → its queue holds the message → processes on re-enable (durability).
- [ ] Forced failures → message lands in the right DLQ.
- [ ] EventBridge rules route high-value / failed-payment events to the right handlers.
- [ ] Step Functions execution shows the ordered workflow; a forced failure triggers compensation.
- [ ] X-Ray service map shows the full request path with latencies.

---

# TROUBLESHOOTING

| Symptom | Cause | Fix |
|---|---|---|
| Queue gets no SNS messages | Queue access policy doesn't allow the topic | Add/allow the SNS→SQS send policy |
| Consumer Lambda not firing | SQS trigger not added, or wrong queue | Add the SQS trigger on the right queue |
| Consumer can't parse the order | Reading `body` instead of `body["Message"]` | The order is inside the SNS envelope's `Message` |
| EventBridge rule never fires | Pattern doesn't match the real event | Build the pattern against a real event sample |
| Step Functions task fails with access error | Execution role can't invoke the Lambda | Grant the state machine role `lambda:InvokeFunction` |
| No X-Ray traces | Active tracing not enabled / role missing X-Ray perms | Enable active tracing + add X-Ray write policy |
| Messages processed twice | Visibility timeout < processing time / non-idempotent | Raise timeout; make consumers idempotent |
