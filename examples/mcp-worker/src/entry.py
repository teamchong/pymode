"""Example MCP server on PyMode — FastMCP tools served via Cloudflare Workers."""

from fastmcp import FastMCP
from pymode.mcp import mcp_handler
from pymode.workers import Response

mcp = FastMCP("calculator")


@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two numbers together."""
    return a + b


@mcp.tool()
def multiply(x: float, y: float) -> float:
    """Multiply two numbers."""
    return x * y


@mcp.tool()
def greet(name: str, greeting: str = "Hello") -> str:
    """Greet someone by name."""
    return f"{greeting}, {name}!"


def on_fetch(request, env):
    """Route MCP requests through the bridge, other paths get a welcome page."""
    if request.path == "/mcp" or (
        request.method == "POST"
        and request.headers.get("content-type", "").startswith("application/json")
    ):
        return mcp_handler(mcp, request, env)

    return Response.json({
        "name": mcp.name,
        "description": "MCP calculator server on PyMode",
        "mcp_endpoint": "/mcp",
    })
