"""Example PyMode Worker — handles HTTP requests like CF Python Workers."""

from pymode.workers import Response
import json


def on_fetch(request, env):
    """Handle incoming HTTP requests."""

    if request.path == "/":
        return Response("Hello from PyMode!")

    if request.path == "/json":
        return Response.json({
            "message": "Hello from PyMode!",
            "method": request.method,
            "url": request.url,
        })

    if request.path == "/echo":
        body = request.text()
        return Response.json({
            "method": request.method,
            "body": body,
            "headers": dict(request.headers.items()),
        })

    if request.path == "/greet":
        params = request.query
        name = params.get("name", ["World"])[0]
        return Response(f"Hello, {name}!")

    return Response("Not Found", status=404)
