"""PyMode MCP bridge — run FastMCP servers on Cloudflare Workers.

Bridges FastMCP's tool/resource/prompt registration to PyMode's on_fetch()
HTTP handler. Handles MCP JSON-RPC 2.0 protocol (Streamable HTTP transport).

Usage:
    from fastmcp import FastMCP
    from pymode.mcp import mcp_handler

    mcp = FastMCP("my-server")

    @mcp.tool()
    def add(a: int, b: int) -> int:
        return a + b

    def on_fetch(request, env):
        return mcp_handler(mcp, request, env)
"""

import json
from pymode.workers import Response

# MCP protocol version
MCP_PROTOCOL_VERSION = "2025-03-26"

# JSON-RPC error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603


def mcp_handler(mcp, request, env=None):
    """Handle MCP JSON-RPC requests via HTTP.

    Implements the MCP Streamable HTTP transport (JSON response mode):
    - POST /mcp or POST / with JSON-RPC body
    - GET / returns server info

    Args:
        mcp: FastMCP instance with registered tools/resources/prompts
        request: PyMode Request object
        env: PyMode Env object (passed to tool context if needed)
    """
    if request.method == "GET":
        return _server_info(mcp)

    if request.method != "POST":
        return Response.json({"error": "Method not allowed"}, status=405)

    try:
        body = request.json()
    except Exception:
        return _jsonrpc_error(None, PARSE_ERROR, "Parse error")

    # Handle batch requests
    if isinstance(body, list):
        results = [_dispatch(mcp, req, env) for req in body]
        return Response.json(results, headers=_mcp_headers())

    return _dispatch(mcp, body, env)


def _dispatch(mcp, body, env):
    """Dispatch a single JSON-RPC request."""
    req_id = body.get("id")
    method = body.get("method")

    if not method:
        return _jsonrpc_error(req_id, INVALID_REQUEST, "Missing method")

    handlers = {
        "initialize": _handle_initialize,
        "ping": _handle_ping,
        "tools/list": _handle_tools_list,
        "tools/call": _handle_tools_call,
        "resources/list": _handle_resources_list,
        "resources/read": _handle_resources_read,
        "resources/templates/list": _handle_resource_templates_list,
        "prompts/list": _handle_prompts_list,
        "prompts/get": _handle_prompts_get,
    }

    handler = handlers.get(method)
    if handler is None:
        return _jsonrpc_error(req_id, METHOD_NOT_FOUND, f"Unknown method: {method}")

    try:
        result = handler(mcp, body.get("params", {}), env)
        return _jsonrpc_result(req_id, result)
    except Exception as e:
        return _jsonrpc_error(req_id, INTERNAL_ERROR, str(e))


def _handle_initialize(mcp, params, env):
    """MCP initialize handshake."""
    capabilities = {"tools": {}}

    # Check if resources are registered
    components = mcp._local_provider._components
    has_resources = any(k.startswith("resource:") for k in components)
    has_prompts = any(k.startswith("prompt:") for k in components)

    if has_resources:
        capabilities["resources"] = {}
    if has_prompts:
        capabilities["prompts"] = {}

    return {
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": capabilities,
        "serverInfo": {
            "name": mcp.name,
            "version": mcp.version or "1.0.0",
        },
    }


def _handle_ping(mcp, params, env):
    return {}


def _handle_tools_list(mcp, params, env):
    """List registered tools with JSON schemas."""
    tools = []
    for key, comp in mcp._local_provider._components.items():
        if not key.startswith("tool:"):
            continue
        tool_info = {
            "name": comp.name,
            "inputSchema": comp.parameters,
        }
        if comp.description:
            tool_info["description"] = comp.description
        tools.append(tool_info)
    return {"tools": tools}


def _handle_tools_call(mcp, params, env):
    """Call a tool and return the result."""
    tool_name = params.get("name")
    arguments = params.get("arguments", {})

    if not tool_name:
        raise ValueError("Missing tool name")

    # Find the tool
    tool = None
    for key, comp in mcp._local_provider._components.items():
        if key.startswith("tool:") and comp.name == tool_name:
            tool = comp
            break

    if tool is None:
        raise ValueError(f"Tool not found: {tool_name}")

    # Call the tool function directly (sync)
    result = tool.fn(**arguments)

    # Format as MCP content
    if isinstance(result, str):
        content = [{"type": "text", "text": result}]
    elif isinstance(result, (dict, list)):
        content = [{"type": "text", "text": json.dumps(result)}]
    elif isinstance(result, bytes):
        import base64
        content = [{"type": "text", "text": base64.b64encode(result).decode()}]
    else:
        content = [{"type": "text", "text": str(result)}]

    return {"content": content}


def _handle_resources_list(mcp, params, env):
    resources = []
    for key, comp in mcp._local_provider._components.items():
        if key.startswith("resource:"):
            resources.append({
                "uri": getattr(comp, "uri", comp.name),
                "name": comp.name,
                "description": getattr(comp, "description", None),
            })
    return {"resources": resources}


def _handle_resources_read(mcp, params, env):
    uri = params.get("uri")
    if not uri:
        raise ValueError("Missing resource URI")

    for key, comp in mcp._local_provider._components.items():
        if key.startswith("resource:") and getattr(comp, "uri", comp.name) == uri:
            result = comp.fn()
            if isinstance(result, str):
                return {"contents": [{"uri": uri, "text": result}]}
            return {"contents": [{"uri": uri, "text": str(result)}]}

    raise ValueError(f"Resource not found: {uri}")


def _handle_resource_templates_list(mcp, params, env):
    templates = []
    for key, comp in mcp._local_provider._components.items():
        if key.startswith("resource_template:"):
            templates.append({
                "uriTemplate": getattr(comp, "uri_template", comp.name),
                "name": comp.name,
                "description": getattr(comp, "description", None),
            })
    return {"resourceTemplates": templates}


def _handle_prompts_list(mcp, params, env):
    prompts = []
    for key, comp in mcp._local_provider._components.items():
        if key.startswith("prompt:"):
            prompts.append({
                "name": comp.name,
                "description": getattr(comp, "description", None),
            })
    return {"prompts": prompts}


def _handle_prompts_get(mcp, params, env):
    prompt_name = params.get("name")
    if not prompt_name:
        raise ValueError("Missing prompt name")

    for key, comp in mcp._local_provider._components.items():
        if key.startswith("prompt:") and comp.name == prompt_name:
            arguments = params.get("arguments", {})
            result = comp.fn(**arguments)
            if isinstance(result, str):
                messages = [{"role": "user", "content": {"type": "text", "text": result}}]
            else:
                messages = result
            return {"messages": messages}

    raise ValueError(f"Prompt not found: {prompt_name}")


def _server_info(mcp):
    """GET / returns basic server info."""
    return Response.json({
        "name": mcp.name,
        "version": mcp.version or "1.0.0",
        "protocol": "mcp",
        "protocolVersion": MCP_PROTOCOL_VERSION,
    }, headers=_mcp_headers())


def _jsonrpc_result(req_id, result):
    return Response.json({
        "jsonrpc": "2.0",
        "id": req_id,
        "result": result,
    }, headers=_mcp_headers())


def _jsonrpc_error(req_id, code, message):
    return Response.json({
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }, headers=_mcp_headers())


def _mcp_headers():
    return {"Content-Type": "application/json"}
