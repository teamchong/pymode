"""Workflow example — 3-step order processing pipeline."""

from pymode.workers import Response
from pymode.workflows import Workflow
import json

workflow = Workflow("order-processing")


@workflow.step
def validate_order(ctx):
    """Validate the incoming order data."""
    order = ctx.input
    if "item" not in order or "quantity" not in order:
        raise ValueError("Order must have 'item' and 'quantity'")
    return {
        "item": order["item"],
        "quantity": order["quantity"],
        "validated": True,
    }


@workflow.step(retries=2, backoff=1.0)
def calculate_total(ctx):
    """Calculate order total (simulates price lookup)."""
    order = ctx.results["validate_order"]
    prices = {"widget": 9.99, "gadget": 24.99, "doohickey": 4.99}
    price = prices.get(order["item"], 0)
    if price == 0:
        raise ValueError(f"Unknown item: {order['item']}")
    return {
        "item": order["item"],
        "quantity": order["quantity"],
        "unit_price": price,
        "total": round(price * order["quantity"], 2),
    }


@workflow.step
def create_receipt(ctx):
    """Generate the final receipt."""
    total = ctx.results["calculate_total"]
    return {
        "receipt_id": f"REC-{ctx.workflow_id}",
        "item": total["item"],
        "quantity": total["quantity"],
        "total": f"${total['total']:.2f}",
        "status": "confirmed",
    }


def on_fetch(request, env):
    """Handle non-workflow requests."""
    if request.path == "/":
        return Response.json({
            "name": "Order Processing Workflow",
            "usage": "POST /workflow/run with {\"input\": {\"item\": \"widget\", \"quantity\": 3}}",
            "endpoints": ["/workflow/run", "/workflow/resume", "/workflow/info"],
        })
    return Response("Not Found", status=404)
