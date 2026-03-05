"""API Worker — multi-file project with KV storage and HTTP."""

from pymode.workers import Response
from src.routes import handle_api
from src.middleware import cors_headers


def on_fetch(request, env):
    # Handle CORS preflight
    if request.method == "OPTIONS":
        return Response("", status=204, headers=cors_headers())

    # Route to API handlers
    response = handle_api(request, env)

    # Add CORS headers to all responses
    headers = dict(response.headers.items())
    headers.update(cors_headers())
    return Response(response.body, status=response.status, headers=headers)
