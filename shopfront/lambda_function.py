import json
import os
import uuid
import datetime
import boto3

dynamodb = boto3.client("dynamodb")
sns = boto3.client("sns")

TABLE_NAME = "shopfront-leads"
TOPIC_ARN = os.environ["TOPIC_ARN"]

# CORS headers so the browser front-end can call this endpoint
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
}

def _resp(status, body):
    return {"statusCode": status, "headers": CORS, "body": json.dumps(body)}

def handler(event, context):
    # Browsers send a preflight OPTIONS request first — answer it
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    if method == "OPTIONS":
        return _resp(200, {"ok": True})

    # Parse the incoming JSON body
    try:
        data = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON"})

    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip()
    message = (data.get("message") or "").strip()

    # Validate required fields (validate at the edge of your logic)
    if not name or not email:
        return _resp(400, {"error": "name and email are required"})

    lead_id = str(uuid.uuid4())
    now = datetime.datetime.utcnow().isoformat() + "Z"

    # Write the lead to DynamoDB
    dynamodb.put_item(
        TableName=TABLE_NAME,
        Item={
            "leadId": {"S": lead_id},
            "name": {"S": name},
            "email": {"S": email},
            "message": {"S": message},
            "createdAt": {"S": now},
        },
    )

    # Notify via SNS
    sns.publish(
        TopicArn=TOPIC_ARN,
        Subject="ShopFront — new lead",
        Message=f"New lead from {name} ({email})\n\nMessage:\n{message}",
    )

    return _resp(200, {"ok": True, "leadId": lead_id})