# OrderFlow — event-driven order-processing backend

The resilient, decoupled backend behind a checkout. One order is published once and processed by independent, retryable steps; nothing blocks, nothing is lost.


### Flow
API Gateway → intake Lambda → DynamoDB + SNS → 3 SQS queues (payment/inventory/notification) → 3 consumer Lambdas (+ DLQs). EventBridge routes special events; Step Functions orchestrates the ordered workflow with compensation; X-Ray traces the whole path.

## Key design decisions
- **Decoupling (SNS+SQS durable fan-out)** so a slow/failed step never blocks or loses an order; each step retries independently with its own DLQ.
- **EventBridge** for content-based routing of special events — add a reaction = add a rule, no change to producers.
- **Step Functions** for the *ordered* workflow (validate→charge→reserve→confirm) with compensation (refund) on failure — the right tool for dependent, must-rollback steps.
- **X-Ray** for distributed tracing across the many decoupled hops — makes the system debuggable.
- Idempotent consumers + DLQs + visibility-timeout tuning for at-least-once correctness.

## When fan-out vs orchestration
Fan-out (SNS+SQS) for independent parallel reactions; Step Functions for ordered dependent steps that may need rollback. OrderFlow uses both deliberately.
