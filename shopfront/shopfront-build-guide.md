# ShopFront

> A retail static storefront with a serverless contact/lead-capture form.
> Three-tier · fully free-tier · built by hand in the AWS Console (Terraform version comes later).
> Build order is **inside-out**: data → application → presentation. You always build what the next layer depends on first.

---

## What you're building (the whole picture)

```
Presentation:  Route 53 (DNS) → CloudFront (CDN, HTTPS via ACM) → private S3 (static site)
Application:   API Gateway (HTTP API)  →  Lambda (validate + store)
Data:          DynamoDB (leads)  +  SNS (notify you on each new lead)
```

A visitor loads your storefront (served globally by CloudFront from a private S3 bucket over HTTPS on your domain). They submit the contact form. The browser POSTs to API Gateway, which invokes a Lambda, which validates the input, writes the lead to DynamoDB, and publishes to SNS so you get an email. Nothing is public that shouldn't be; nothing runs when idle.

**Three-tier mapping (say this in interviews):**
- Presentation: CloudFront serves the UI; Route 53 resolves the domain; ACM provides the TLS cert.
- Application: API Gateway routes the request; Lambda runs the logic.
- Data: DynamoDB persists leads; SNS handles notification.

**Regions:** Build everything in your normal region (e.g. `ap-south-1` Mumbai) **except the ACM certificate for CloudFront, which must be in `us-east-1`** (the rule from Module 3.10). This guide flags it where it matters.

**Cost:** Effectively $0 at portfolio traffic — every service here has a free tier that covers this comfortably. The only real cost is the domain you already own. Teardown steps are at the end.

---

# PART 0 — Prerequisites & setup (5 min)

1. Sign in to the AWS Console. Confirm your Region (top-right) is your normal region (e.g. Mumbai `ap-south-1`).
2. Have your domain ready. Decide the hostname you'll use, e.g. `shopfront.yourdomain.com` (a subdomain) or the apex `yourdomain.com`. A subdomain is simplest for a portfolio piece — this guide uses `shopfront.yourdomain.com`.
3. Create a working folder on your laptop named `shopfront/` — you'll save the site files and notes there before pushing to your `aws-cloud-platform` repo.

---

# PART 1 — DATA TIER

## 1A. DynamoDB table for leads

1. Console → search **DynamoDB** → **Tables** → **Create table**.
2. **Table name:** `shopfront-leads`
3. **Partition key:** `leadId` — type **String**.
4. Leave **Sort key** empty.
5. **Table settings:** keep **Default settings** (on-demand capacity — no idle cost, scales automatically, free-tier friendly).
6. Click **Create table**. Wait until status is **Active**.

That's the data tier's storage. Each form submission becomes one item keyed by a unique `leadId`.

## 1B. SNS topic for new-lead notifications

1. Console → search **SNS** → **Topics** → **Create topic**.
2. Type: **Standard**. Name: `shopfront-new-lead`. Create topic.
3. On the topic page → **Create subscription**.
4. **Protocol:** Email. **Endpoint:** your email address. Create subscription.
5. **Go to your inbox and click the confirmation link** (the subscription stays "Pending confirmation" until you do — the Module 3.15 gotcha). Refresh the SNS page; it should read **Confirmed**.
6. Copy the topic's **ARN** (top of the topic page) into your notes — the Lambda needs it.

---

# PART 2 — APPLICATION TIER

## 2A. The Lambda function

We'll create the function first, then give it permissions, then the code.

1. Console → search **Lambda** → **Create function** → **Author from scratch**.
2. **Function name:** `shopfront-process-lead`
3. **Runtime:** **Python 3.12**
4. **Architecture:** leave default (x86_64).
5. Expand **Change default execution role** → keep **Create a new role with basic Lambda permissions** (this gives it CloudWatch Logs access; we'll add DynamoDB + SNS next).
6. **Create function.**

### 2B. Give the function least-privilege permissions

The function needs to write to your DynamoDB table and publish to your SNS topic — and *only* those (least privilege, the Module 3.1 discipline).

1. On the function page → **Configuration** tab → **Permissions** → click the **Role name** link (opens IAM in a new tab).
2. In IAM, on the role → **Add permissions** → **Create inline policy**.
3. Click the **JSON** tab and paste this, replacing the two ARNs with your table ARN and topic ARN (find the table ARN on the DynamoDB table's "General information"; you already copied the topic ARN):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteLeads",
      "Effect": "Allow",
      "Action": "dynamodb:PutItem",
      "Resource": "arn:aws:dynamodb:REGION:ACCOUNT_ID:table/shopfront-leads"
    },
    {
      "Sid": "NotifyNewLead",
      "Effect": "Allow",
      "Action": "sns:Publish",
      "Resource": "arn:aws:sns:REGION:ACCOUNT_ID:shopfront-new-lead"
    }
  ]
}
```

4. **Next** → name it `shopfront-lead-write` → **Create policy**. Close the IAM tab, back to Lambda.

Notice: the policy names the *specific* table and topic ARNs, not `*`. The function can write leads and notify — nothing else.

### 2C. The function code

1. On the function page → **Code** tab → replace the contents of `(lambda_function.py)` 

2. Set the handler so Lambda calls `handler`: **Runtime settings** → **Edit** → **Handler** = `lambda_function.handler` → Save.
3. Add the topic ARN as an environment variable so the code can read it: **Configuration** → **Environment variables** → **Edit** → **Add** → Key `TOPIC_ARN`, Value = your SNS topic ARN → Save.
4. **Deploy** (the orange button on the Code tab).

### 2D. Test the function directly

1. **Test** tab → create a new test event. Use this body (it mimics what API Gateway will send):

```json
{
  "requestContext": { "http": { "method": "POST" } },
  "body": "{\"name\":\"Dipak\",\"email\":\"dipak@example.com\",\"message\":\"Interested in a quote\"}"
}
```

2. **Test.** You should see a `200` with a `leadId`.
3. Verify the data tier worked: open DynamoDB → `shopfront-leads` → **Explore table items** → your lead is there.
4. Check your email → the SNS notification arrived.

The application + data tiers now work end-to-end. Next, expose the function as a real API.

## 2E. API Gateway HTTP API

1. Console → search **API Gateway** → **Build** under **HTTP API**.
2. **Add integration** → **Lambda** → select `shopfront-process-lead` (same region). **API name:** `shopfront-api`. Next.
3. **Configure routes:** Method **POST**, **Resource path** `/lead`, Integration target your Lambda. Next.
4. **Stages:** keep the auto-created `$default` (auto-deploy on). Next → **Create**.
5. **Enable CORS** (the Module 3.13 gotcha — your browser form won't work without it):
   - Left menu → **CORS** → **Configure**.
   - **Access-Control-Allow-Origin:** `*` (you can tighten this to your CloudFront domain later).
   - **Access-Control-Allow-Methods:** `POST` and `OPTIONS`.
   - **Access-Control-Allow-Headers:** `content-type`.
   - Save.
6. Copy the **Invoke URL** (looks like `https://abc123.execute-api.REGION.amazonaws.com`) into your notes. Your form will POST to `<invoke-url>/lead`.

### 2F. Test the live API

From your laptop terminal (or Postman):

```bash
curl -X POST https://abc123.execute-api.REGION.amazonaws.com/lead \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","message":"hello"}'
```

You should get `{"ok": true, "leadId": "..."}`, a new DynamoDB item, and an email. The application tier is live.

---

# PART 3 — PRESENTATION TIER

## 3A. The static site files (refer to '(index.html)' and '(styles.css)' file)

**`index.html`** — replace `API_INVOKE_URL` with your API Gateway invoke URL:

Open `(index.html)` locally in your browser and submit the form once — confirm it still hits your API (a new DynamoDB item + email). Now you know the front-end works before you even deploy it.

## 3B. Private S3 bucket for the site

1. Console → **S3** → **Create bucket**.
2. **Bucket name:** globally unique, e.g. `shopfront-site-dipak-2026`.
3. **Region:** your normal region.
4. **Block Public Access:** leave **ALL boxes checked** (fully blocked — the bucket stays private; CloudFront will reach it via OAC). This is the Module 3.5/3.11 anti-breach pattern.
5. Leave the rest default → **Create bucket**.
6. Open the bucket → **Upload** → add `index.html` and `styles.css` → **Upload**.

The bucket is private — if you click an object and try its S3 URL, you'll get Access Denied. That's correct. CloudFront will be the only way in.

## 3C. ACM certificate in us-east-1

**Switch your Console Region to `us-east-1` (N. Virginia)** — this is the CloudFront cert rule. The cert *must* live here.

1. Console → **Certificate Manager** → **Request** → **Request a public certificate** → Next.
2. **Fully qualified domain name:** `shopfront.yourdomain.com` (the hostname you chose). Optionally also add the apex or a wildcard if you want.
3. **Validation method:** **DNS validation** (auto-renews — Module 3.10).
4. Request. The cert is now **Pending validation**.
5. Open the certificate → you'll see a **CNAME** record to add for validation.
   - **If your domain's DNS is in Route 53:** click **Create records in Route 53** → it adds the validation CNAME automatically. (If your domain isn't in Route 53 yet, see Part 3E first, then come back.)
   - **If your DNS is elsewhere:** copy the CNAME name/value and add it at your DNS provider manually.
6. Wait a few minutes → the cert flips to **Issued**. Keep this browser tab; you'll select this cert in CloudFront.

## 3D. CloudFront distribution with OAC

You can do this from any region (CloudFront is global), but make sure you pick the us-east-1 cert.

1. Console → **CloudFront** → **Create distribution**.
2. **Origin domain:** click the field → select your S3 bucket (`shopfront-site-dipak-2026`). It'll suggest the S3 bucket endpoint.
3. **Origin access:** choose **Origin access control settings (recommended)** → **Create control setting** → accept defaults → **Create**. (This is OAC — only CloudFront will be able to read the bucket.)
4. CloudFront shows a banner: **"You must update the S3 bucket policy."** Leave it — you'll copy the policy in a moment.
5. **Viewer protocol policy:** **Redirect HTTP to HTTPS**.
6. **Web Application Firewall:** you can leave it disabled for now (optional, costs extra).
7. **Alternate domain name (CNAME):** add `shopfront.yourdomain.com`.
8. **Custom SSL certificate:** select your **us-east-1 ACM cert** from the dropdown. (If it's not listed, the cert isn't in us-east-1 — fix that first.)
9. **Default root object:** type `index.html`.
10. **Create distribution.** It takes a few minutes to deploy (status **Enabled** / **Deployed**).

### Apply the bucket policy (the OAC link)

11. After creation, CloudFront shows (or you can get from the distribution's banner) the **bucket policy to copy**. Copy it.
12. Go to **S3** → your bucket → **Permissions** → **Bucket policy** → **Edit** → paste → **Save**. This grants the CloudFront service principal (scoped to your distribution's ARN — the precise pattern from Module 3.11) read access. Block Public Access stays ON.
13. Test: open the distribution's **Distribution domain name** (`d123.cloudfront.net`) in a browser → your ShopFront site loads over HTTPS. The S3 bucket is still private.

## 3E. Route 53 — point your domain at CloudFront

**If your domain's DNS is already in Route 53**, skip to step 3. If not, do steps 1-2 first.

1. **(Only if your domain is registered elsewhere and not yet in Route 53):** Route 53 → **Hosted zones** → **Create hosted zone** → enter `yourdomain.com` → **Public hosted zone** → Create. Route 53 gives you **4 NS records**. Go to your registrar (GoDaddy/Namecheap/etc.) and set the domain's nameservers to those four. (This is the registrar-delegation step from Module 3.9 — without it, Route 53 isn't authoritative.) Propagation can take minutes to hours.
2. (If you just created the zone, also re-do the ACM DNS validation here if it hadn't validated — add the CNAME via the "Create records in Route 53" button.)
3. Route 53 → your hosted zone → **Create record**.
4. **Record name:** `shopfront` (so the full name is `shopfront.yourdomain.com`).
5. **Record type:** **A**.
6. Toggle **Alias** ON.
7. **Route traffic to:** **Alias to CloudFront distribution** → select your distribution. (Alias to an AWS resource — free, apex-safe, the Module 3.9 pattern. No CNAME-at-apex problem here since you'd use this same Alias approach even at the apex.)
8. **Create records.**
9. Wait for DNS to propagate, then open **https://shopfront.yourdomain.com** → your ShopFront storefront loads over HTTPS on your own domain, served globally by CloudFront from a private bucket. Submit the form → lead lands in DynamoDB → email arrives.

**ShopFront is live, end to end.** Every tier is doing its job: Route 53 resolved your domain, ACM secured it, CloudFront served it from a private origin, API Gateway received the form, Lambda validated and stored it, DynamoDB persisted it, SNS notified you.

---

# PART 4 — VERIFY THE WHOLE THING

Run this checklist (also good material for your blog/README):

- [ ] `https://shopfront.yourdomain.com` loads over HTTPS (padlock shown).
- [ ] The direct S3 object URL returns **Access Denied** (origin is private).
- [ ] Submitting the form shows the success message.
- [ ] A new item appears in the `shopfront-leads` DynamoDB table.
- [ ] You receive the SNS email for the new lead.
- [ ] In the browser dev tools Network tab, a second page load shows `x-cache: Hit from cloudfront` (caching works).
- [ ] Lambda's CloudWatch log group shows the invocation (observability).

If any step fails, the troubleshooting table below maps symptoms to fixes.

---

# PART 5 — TROUBLESHOOTING (the things that actually go wrong)

| Symptom | Likely cause | Fix |
|---|---|---|
| Form submit → CORS error in console | CORS not enabled / wrong origin on the HTTP API | API Gateway → CORS → allow your origin, `POST`+`OPTIONS`, `content-type`; the Lambda also returns CORS headers (it does, above) |
| Form submit → 500/502 | Lambda error or bad response shape | Check the Lambda's CloudWatch logs; confirm handler = `lambda_function.handler` |
| Lambda: AccessDenied on DynamoDB/SNS | Inline policy ARNs wrong | Re-check the table/topic ARNs in the inline policy |
| CloudFront → 403 AccessDenied | Bucket policy not applied, or no default root object | Apply the OAC bucket policy; set default root object `index.html` |
| Cert not in CloudFront dropdown | Cert not in us-east-1 | Re-request the ACM cert in us-east-1 |
| Domain doesn't resolve | NS delegation missing / DNS still propagating | Confirm registrar NS = Route 53's NS; wait for propagation |
| Site shows old content after re-upload | CloudFront cache TTL | Create an invalidation for `/*` (or use versioned filenames next time) |
| SNS email never arrives | Subscription not confirmed | Confirm the subscription link in your inbox |

---

# PART 6 — TEARDOWN 

Do this to keep your account clean and at $0:

1. **CloudFront** → select distribution → **Disable** → wait until disabled → **Delete**.
2. **S3** → empty the bucket → delete the bucket.
3. **API Gateway** → delete `shopfront-api`.
4. **Lambda** → delete `shopfront-process-lead`.
5. **DynamoDB** → delete `shopfront-leads`.
6. **SNS** → delete the `shopfront-new-lead` topic (and subscription).
7. **Route 53** → delete the `shopfront` A/Alias record. (Keep the hosted zone if you'll reuse the domain — note an idle hosted zone costs ~$0.50/month.)
8. **ACM** (us-east-1) → delete the certificate.

(shopfront-page.png)
