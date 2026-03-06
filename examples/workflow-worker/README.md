# Workflow Worker

PyMode Workflows example — a 3-step order processing pipeline with retries.

## Run locally

```bash
cd examples/workflow-worker
pymode dev
```

## Usage

```bash
# See workflow info
curl http://localhost:8787/workflow/info

# Run the workflow
curl -X POST http://localhost:8787/workflow/run \
  -H "Content-Type: application/json" \
  -d '{"input": {"item": "widget", "quantity": 3}}'

# Response:
# {
#   "workflow_id": "order-processing_1709654400",
#   "status": "completed",
#   "results": {
#     "validate_order": {"item": "widget", "quantity": 3, "validated": true},
#     "calculate_total": {"item": "widget", "quantity": 3, "unit_price": 9.99, "total": 29.97},
#     "create_receipt": {"receipt_id": "REC-...", "total": "$29.97", "status": "confirmed"}
#   }
# }
```

## Steps

| Step | Retries | Description |
|------|---------|-------------|
| `validate_order` | 0 | Validates item and quantity |
| `calculate_total` | 2 | Looks up price, calculates total |
| `create_receipt` | 0 | Generates receipt |
