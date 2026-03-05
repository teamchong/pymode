"""API route handlers — uses env bindings like CF Python Workers."""

import json
from pymode.workers import Response


def handle_api(request, env):
    path = request.path

    if path == "/api/items" and request.method == "GET":
        return list_items(env)

    if path == "/api/items" and request.method == "POST":
        return create_item(request, env)

    if path.startswith("/api/items/") and request.method == "GET":
        item_id = path.split("/")[-1]
        return get_item(item_id, env)

    return Response.json({"error": "Not found"}, status=404)


def list_items(env):
    data = env.MY_KV.get("items", type="json")
    items = data if data else []
    return Response.json({"items": items})


def create_item(request, env):
    body = request.json()
    data = env.MY_KV.get("items", type="json")
    items = data if data else []
    items.append(body)
    env.MY_KV.put("items", json.dumps(items))
    return Response.json({"created": body}, status=201)


def get_item(item_id, env):
    data = env.MY_KV.get("items", type="json")
    items = data if data else []
    for item in items:
        if str(item.get("id")) == item_id:
            return Response.json(item)
    return Response.json({"error": "Item not found"}, status=404)
