# MediaForge: Build Guide

> An event-driven media processing pipeline — upload triggers automatic thumbnail + transcode + global delivery.
> Event-driven · mostly serverless · near-$0 (only transcode minutes cost — keep test clips short).

> **Build order (inside-out):** storage → catalog → upload mechanism → event+queue → orchestrator Lambda → MediaConvert → delivery. Each layer feeds the next.

---

## What you're building

```
Upload:    user → pre-signed URL → raw S3 bucket (private)
Trigger:   S3 object-created event → SQS queue (+ DLQ) → orchestrator Lambda
Process:   orchestrator Lambda → thumbnail (light, in Lambda) + START MediaConvert job (heavy transcode)
Store:     processed S3 bucket (private) ← outputs; DynamoDB catalog ← status/URLs
Deliver:   CloudFront (OAC) → viewers worldwide
```

**Two key insights (the interview gold):**
1. **Event-driven:** an upload *automatically* triggers processing — no polling, no always-on workers, scales to zero.
2. **Orchestrator vs worker:** Lambda does the *light* work (thumbnail, metadata) and *starts* MediaConvert for the *heavy* work (video transcode) — because transcoding exceeds Lambda's 15-min limit. Lambda orchestrates; MediaConvert does the heavy lifting.

**Three-tier framing:** Presentation = pre-signed upload + CloudFront delivery. Application = S3 event → SQS → orchestrator Lambda + MediaConvert. Data = raw + processed S3 buckets, DynamoDB catalog.

**Region:** one region throughout (e.g. `ap-south-1`).

**Cost:** S3, SQS, Lambda, DynamoDB, CloudFront all free-tier-friendly. **MediaConvert bills per minute of output** — keep test clips a few seconds and delete jobs. Effectively a few cents if you test with short clips.

---

# STAGE 1 — STORAGE + CATALOG

## 1A. Two private S3 buckets (4 min)

> **What:** one bucket for raw uploads, one for processed outputs. Both private — the raw bucket receives uploads via pre-signed URLs, the processed bucket is served only through CloudFront.

1. S3 → Create bucket → `mediaforge-raw-<unique>` → **Block all public access ON** → Create.
2. S3 → Create bucket → `mediaforge-processed-<unique>` → **Block all public access ON** → Create.

## 1B. DynamoDB catalog (3 min)

> **What:** tracks each media item's status (UPLOADED → PROCESSING → READY) and its output URLs. The source of truth for what's been processed.

1. DynamoDB → Create table → `mediaforge-catalog`, partition key `mediaId` (String), default settings → Create.

**✅ Stage 1 checkpoint: two private buckets + catalog table exist.**

---

# STAGE 2 — SECURE UPLOAD (pre-signed URL)

> **What:** rather than exposing the bucket or routing big files through your app, the client requests a *pre-signed URL* — a time-limited, permission-scoped URL that lets it upload *directly* to the private S3 bucket. Secure and scalable (Module 3.5/3.11).

## 2A. Pre-signed URL Lambda (8 min)

1. Lambda → Create function → `mediaforge-presign`, Python 3.12, new basic role.
2. Permission: inline policy allowing `s3:PutObject` on `mediaforge-raw-<unique>/*` only.
3. Code:
```python
import json, os, uuid, boto3
s3 = boto3.client("s3")
BUCKET = os.environ["RAW_BUCKET"]
CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"POST,OPTIONS"}
def handler(event, ctx):
    if event.get("requestContext",{}).get("http",{}).get("method")=="OPTIONS":
        return {"statusCode":200,"headers":CORS,"body":"{}"}
    media_id = str(uuid.uuid4())
    key = f"uploads/{media_id}.mp4"
    url = s3.generate_presigned_url("put_object",
        Params={"Bucket":BUCKET,"Key":key,"ContentType":"video/mp4"}, ExpiresIn=300)
    return {"statusCode":200,"headers":CORS,
            "body":json.dumps({"mediaId":media_id,"uploadUrl":url,"key":key})}
```
4. Handler `lambda_function.handler`, env var `RAW_BUCKET` = your raw bucket name. Deploy.
5. Front it with an API Gateway HTTP API (route `GET /presign`), enable CORS. (Same pattern as ShopFront.)

> *Why pre-signed: the client uploads straight to S3 with a short-lived, write-only URL — the bucket never goes public, and large files don't pass through your compute.*

## 2B. Test the upload

```bash
# 1. get a pre-signed URL
curl <api>/presign
# 2. use the returned uploadUrl to PUT a short test clip
curl -X PUT -T test.mp4 -H "Content-Type: video/mp4" "<uploadUrl>"
```
Confirm the file appears in `mediaforge-raw/uploads/`.

**✅ Stage 2 checkpoint: secure direct-to-S3 upload works.**

---

# STAGE 3 — EVENT TRIGGER + QUEUE

> **What:** when a file lands in the raw bucket, S3 emits an event into an SQS queue, which triggers the orchestrator. The queue buffers bursts and gives retries/DLQ (Module 3.14).

## 3A. SQS queue + DLQ (4 min)

1. SQS → create `mediaforge-dlq` (Standard).
2. SQS → create `mediaforge-jobs` (Standard) → attach DLQ, max receives 3.

## 3B. S3 event notification → SQS (4 min)

> **Why a queue between S3 and Lambda:** smooths upload bursts and gives durable retries, so a spike of uploads doesn't overwhelm or drop work.

1. S3 → `mediaforge-raw` → Properties → Event notifications → Create event notification.
2. Name `on-upload`, prefix `uploads/`, event type **All object create events**, destination **SQS queue** → `mediaforge-jobs`. (Allow S3 to send to the queue — accept the policy prompt.)

**✅ Stage 3 checkpoint: uploading a file lands a message in `mediaforge-jobs`.**

---

# STAGE 4 — ORCHESTRATOR LAMBDA (the centerpiece)

> **What:** consumes the queue, generates a thumbnail (light work, in Lambda), updates the catalog to PROCESSING, and *starts* a MediaConvert transcode job (heavy work, delegated). Returns immediately — it orchestrates, it doesn't transcode.

## 4A. MediaConvert prerequisites (6 min)

> **What:** MediaConvert needs an IAM role to read the raw bucket and write the processed bucket. And you need your account's MediaConvert endpoint.

1. IAM → create role `mediaforge-mediaconvert-role`, trusted entity **MediaConvert**, attach a policy allowing `s3:GetObject` on raw and `s3:PutObject` on processed.
2. Note your MediaConvert endpoint (MediaConvert console → Account, or via API) — the Lambda needs it.

## 4B. Orchestrator Lambda (12 min)

1. Lambda → Create `mediaforge-orchestrator`, Python 3.12, new basic role. Increase timeout to ~1 min, memory ~512MB.
2. Permissions (inline): `dynamodb:UpdateItem`/`PutItem` on the catalog, `s3:GetObject` on raw + `s3:PutObject` on processed (for the thumbnail), `mediaconvert:CreateJob`, and `iam:PassRole` on the MediaConvert role.
3. Code (skeleton — thumbnail logic simplified; the key pattern is *start the transcode, don't do it here*):
```python
import json, os, boto3
ddb = boto3.client("dynamodb")
mc = boto3.client("mediaconvert", endpoint_url=os.environ["MC_ENDPOINT"])
TABLE=os.environ["TABLE"]; PROCESSED=os.environ["PROCESSED_BUCKET"]; MC_ROLE=os.environ["MC_ROLE"]
def handler(event, ctx):
    for rec in event["Records"]:                 # SQS batch
        body = json.loads(rec["body"])           # S3 event envelope
        for s3rec in body.get("Records", []):
            bucket = s3rec["s3"]["bucket"]["name"]
            key = s3rec["s3"]["object"]["key"]
            media_id = key.split("/")[-1].split(".")[0]
            # mark PROCESSING
            ddb.update_item(TableName=TABLE, Key={"mediaId":{"S":media_id}},
                UpdateExpression="SET #s=:v", ExpressionAttributeNames={"#s":"status"},
                ExpressionAttributeValues={":v":{"S":"PROCESSING"}})
            # (LIGHT work: generate a thumbnail here with a lib, write to PROCESSED) — omitted for brevity
            # HEAVY work: START a MediaConvert job (do NOT transcode in Lambda)
            mc.create_job(Role=MC_ROLE, Settings={
                "Inputs":[{"FileInput":f"s3://{bucket}/{key}"}],
                "OutputGroups":[{
                    "OutputGroupSettings":{"Type":"FILE_GROUP_SETTINGS",
                        "FileGroupSettings":{"Destination":f"s3://{PROCESSED}/{media_id}/"}},
                    "Outputs":[{"VideoDescription":{},"ContainerSettings":{"Container":"MP4"}}]
                }]
            })
            print(f"started transcode for {media_id}")
    return {"ok": True}
```
4. Handler set; env vars `TABLE`, `PROCESSED_BUCKET`, `MC_ENDPOINT`, `MC_ROLE`. Deploy.
5. Add the **SQS trigger** → `mediaforge-jobs`.

> **The interview point lives here:** Lambda does light/orchestration work and *starts* MediaConvert for the heavy transcode, because a long video transcode exceeds Lambda's 15-min hard limit. Lambda orchestrates; MediaConvert is the worker.

## 4C. Mark READY on transcode completion (6 min)

> **What:** MediaConvert emits a completion event to EventBridge; a small Lambda catches it and flips the catalog status to READY with the output URLs.

1. EventBridge → rule matching MediaConvert job state `COMPLETE` → target a `mediaforge-complete` Lambda.
2. That Lambda updates the catalog item to `READY` and records the output key(s).

**✅ Stage 4 checkpoint: upload → queue → orchestrator → thumbnail + transcode started → READY on completion.**

---

# STAGE 5 — DELIVERY (CloudFront)

> **What:** serve the processed media globally over HTTPS from the private processed bucket via CloudFront + OAC (Module 3.11) — the same private-origin pattern as ShopFront.

1. CloudFront → Create distribution → origin = `mediaforge-processed` → **OAC** (create control setting) → apply the generated bucket policy to the processed bucket.
2. Viewer protocol: Redirect HTTP→HTTPS. Create.
3. Test: take a `READY` item's output key → open `https://<distribution>/<mediaId>/<output>` → the transcoded media plays, served globally, bucket private.

**✅ Stage 5 checkpoint: processed media delivered globally via CloudFront from a private origin.**

---

# TROUBLESHOOTING

| Symptom | Cause | Fix |
|---|---|---|
| Pre-signed PUT fails (403) | Presign Lambda lacks `s3:PutObject`, or ContentType mismatch | Match the ContentType in PUT to the presign; grant PutObject on raw |
| No message in queue after upload | S3 event notification/prefix wrong, or queue policy missing | Check prefix `uploads/`; allow S3→SQS in the queue policy |
| Orchestrator can't start MediaConvert | Missing `mediaconvert:CreateJob` or `iam:PassRole` | Add both; PassRole must target the MediaConvert role |
| MediaConvert job fails | Role can't read raw / write processed, or bad input | Check the MediaConvert role's S3 permissions and input path |
| CloudFront 403 | OAC bucket policy not applied | Apply the generated policy to the processed bucket |
| Status never goes READY | Completion EventBridge rule/pattern wrong | Match MediaConvert `COMPLETE` state; verify the rule target |

---

## Where this leads
MediaForge applied event-driven processing to data-heavy media work. Next: two real-code application projects (Node/Express and Java/Spring Boot) — actual working apps deployed in three-tier architectures.
