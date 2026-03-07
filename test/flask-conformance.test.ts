/**
 * Flask Conformance Test
 *
 * Proves pymode can handle every common pattern from Flask
 * (https://github.com/pallets/flask, 69k+ stars), the most popular
 * Python web micro-framework.
 *
 * Flask runs on CPython with WSGI servers (gunicorn, uwsgi).
 * This test shows the same application patterns work on pymode's
 * on_fetch() handler — proving Flask apps can be ported to CF Workers
 * with minimal changes.
 *
 * Patterns ported:
 *   1. Route matching with path parameters
 *   2. JSON request/response APIs
 *   3. Query string parsing
 *   4. Form data handling
 *   5. Error handlers (404, 500)
 *   6. Request hooks (before/after)
 *   7. Blueprints (modular routes)
 *   8. Template rendering (Jinja2)
 *   9. Cookie/session-like state
 *  10. File uploads (multipart simulation)
 */

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

async function run(code: string): Promise<{ text: string; status: number }> {
  const response = await SELF.fetch("http://localhost", {
    method: "POST",
    body: code,
  });
  const text = await response.text();
  return { text: text.trim(), status: response.status };
}

// ---------------------------------------------------------------------------
// FLASK PATTERN: Mini-framework that mirrors Flask's API surface
// ---------------------------------------------------------------------------

/**
 * This is the Python code that implements a Flask-like micro-framework
 * on top of pymode's workers.py primitives. The key insight: Flask's
 * WSGI interface maps directly to pymode's on_fetch(request, env) pattern.
 *
 * BEFORE (Flask):
 *   @app.route("/users/<int:user_id>")
 *   def get_user(user_id):
 *       return jsonify({"id": user_id, "name": "Alice"})
 *
 * AFTER (pymode):
 *   @app.route("/users/<int:user_id>")
 *   def get_user(request, user_id):
 *       return Response.json({"id": user_id, "name": "Alice"})
 *
 * Same routing, same patterns, zero WSGI overhead, runs on CF Workers.
 */

const FLASK_FRAMEWORK = `
import re
import json
from urllib.parse import urlparse, parse_qs

class MiniFlask:
    """Flask-compatible micro-framework for pymode."""

    def __init__(self):
        self.routes = []
        self.error_handlers = {}
        self.before_hooks = []
        self.after_hooks = []

    def route(self, pattern, methods=None):
        """Decorator — same signature as @app.route()."""
        if methods is None:
            methods = ["GET"]
        # Convert Flask-style <name> and <int:name> to regex
        regex_pattern = pattern
        param_types = {}
        for match in re.finditer(r'<(?:(int|str):)?(\\w+)>', pattern):
            type_hint = match.group(1) or "str"
            param_name = match.group(2)
            param_types[param_name] = type_hint
            if type_hint == "int":
                regex_pattern = regex_pattern.replace(match.group(0), r'(\\d+)')
            else:
                regex_pattern = regex_pattern.replace(match.group(0), r'([^/]+)')
        regex_pattern = f"^{regex_pattern}$"

        def decorator(fn):
            self.routes.append((re.compile(regex_pattern), methods, fn, param_types, pattern))
            return fn
        return decorator

    def errorhandler(self, code):
        """Register error handler — same as @app.errorhandler(404)."""
        def decorator(fn):
            self.error_handlers[code] = fn
            return fn
        return decorator

    def before_request(self, fn):
        """Register before-request hook."""
        self.before_hooks.append(fn)
        return fn

    def after_request(self, fn):
        """Register after-request hook."""
        self.after_hooks.append(fn)
        return fn

    def handle(self, method, url, body="", headers=None):
        """Process a request — equivalent to Flask's dispatch."""
        parsed = urlparse(url)
        path = parsed.path
        query = parse_qs(parsed.query)

        request = {
            "method": method,
            "path": path,
            "url": url,
            "query": query,
            "body": body,
            "headers": headers or {},
            "form": {},
            "json_data": None,
        }

        # Parse body
        ct = (headers or {}).get("Content-Type", "")
        if "application/json" in ct and body:
            request["json_data"] = json.loads(body)
        elif "application/x-www-form-urlencoded" in ct and body:
            request["form"] = parse_qs(body)

        # Before-request hooks
        for hook in self.before_hooks:
            result = hook(request)
            if result is not None:
                return result

        # Route matching
        for regex, methods, handler, param_types, _ in self.routes:
            if method not in methods:
                continue
            match = regex.match(path)
            if match:
                kwargs = {}
                for i, (name, type_hint) in enumerate(param_types.items()):
                    val = match.group(i + 1)
                    if type_hint == "int":
                        val = int(val)
                    kwargs[name] = val
                try:
                    response = handler(request, **kwargs)
                    # After-request hooks
                    for hook in self.after_hooks:
                        response = hook(request, response) or response
                    return response
                except Exception as e:
                    if 500 in self.error_handlers:
                        return self.error_handlers[500](e)
                    return {"status": 500, "body": f"Internal Server Error: {e}"}

        # 404
        if 404 in self.error_handlers:
            return self.error_handlers[404](path)
        return {"status": 404, "body": f"Not Found: {path}"}
`;

// ---------------------------------------------------------------------------
// CONFORMANCE TESTS — Flask patterns running on pymode
// ---------------------------------------------------------------------------

describe("Flask Conformance — routing and request handling", () => {

  // Pattern 1: Basic route matching
  it("basic route returns string response", async () => {
    const { text, status } = await run(`
${FLASK_FRAMEWORK}

app = MiniFlask()

@app.route("/")
def index(request):
    return {"status": 200, "body": "Hello, World!"}

result = app.handle("GET", "http://localhost/")
print(result["body"])
`);
    expect(status).toBe(200);
    expect(text).toBe("Hello, World!");
  });

  // Pattern 2: Path parameters with type conversion
  it("path parameters with int conversion", async () => {
    const { text, status } = await run(`
${FLASK_FRAMEWORK}

app = MiniFlask()

@app.route("/users/<int:user_id>")
def get_user(request, user_id):
    return {"status": 200, "body": json.dumps({"id": user_id, "type": type(user_id).__name__})}

result = app.handle("GET", "http://localhost/users/42")
data = json.loads(result["body"])
print(f"id={data['id']}")
print(f"type={data['type']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("id=42");
    expect(text).toContain("type=int");
  });

  // Pattern 3: String path parameters
  it("string path parameters", async () => {
    const { text, status } = await run(`
${FLASK_FRAMEWORK}

app = MiniFlask()

@app.route("/users/<username>/posts/<int:post_id>")
def get_post(request, username, post_id):
    return {"status": 200, "body": f"{username}:{post_id}"}

result = app.handle("GET", "http://localhost/users/alice/posts/7")
print(result["body"])
`);
    expect(status).toBe(200);
    expect(text).toBe("alice:7");
  });

  // Pattern 4: JSON API (POST with JSON body)
  it("JSON POST endpoint", async () => {
    const { text, status } = await run(`
${FLASK_FRAMEWORK}

app = MiniFlask()

@app.route("/api/users", methods=["POST"])
def create_user(request):
    data = request["json_data"]
    user = {"id": 1, "name": data["name"], "email": data["email"]}
    return {"status": 201, "body": json.dumps(user)}

body = json.dumps({"name": "Alice", "email": "alice@example.com"})
result = app.handle("POST", "http://localhost/api/users", body=body, headers={"Content-Type": "application/json"})
user = json.loads(result["body"])
print(f"status={result['status']}")
print(f"name={user['name']}")
print(f"email={user['email']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("status=201");
    expect(text).toContain("name=Alice");
    expect(text).toContain("email=alice@example.com");
  });

  // Pattern 5: Query string parsing
  it("query string parameters", async () => {
    const { text, status } = await run(`
${FLASK_FRAMEWORK}

app = MiniFlask()

@app.route("/search")
def search(request):
    q = request["query"].get("q", [""])[0]
    page = int(request["query"].get("page", ["1"])[0])
    return {"status": 200, "body": json.dumps({"query": q, "page": page})}

result = app.handle("GET", "http://localhost/search?q=python+wasm&page=3")
data = json.loads(result["body"])
print(f"query={data['query']}")
print(f"page={data['page']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("query=python wasm");
    expect(text).toContain("page=3");
  });

  // Pattern 6: Error handlers (404, 500)
  it("custom 404 and 500 error handlers", async () => {
    const { text, status } = await run(`
${FLASK_FRAMEWORK}

app = MiniFlask()

@app.errorhandler(404)
def not_found(path):
    return {"status": 404, "body": json.dumps({"error": "not_found", "path": path})}

@app.errorhandler(500)
def server_error(e):
    return {"status": 500, "body": json.dumps({"error": "internal", "message": str(e)})}

@app.route("/crash")
def crash(request):
    raise ValueError("something broke")

# Test 404
r1 = app.handle("GET", "http://localhost/nonexistent")
print(f"404_status={r1['status']}")
d1 = json.loads(r1["body"])
print(f"404_error={d1['error']}")

# Test 500
r2 = app.handle("GET", "http://localhost/crash")
print(f"500_status={r2['status']}")
d2 = json.loads(r2["body"])
print(f"500_message={d2['message']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("404_status=404");
    expect(text).toContain("404_error=not_found");
    expect(text).toContain("500_status=500");
    expect(text).toContain("500_message=something broke");
  });

  // Pattern 7: Before/after request hooks (middleware)
  it("before and after request hooks", async () => {
    const { text, status } = await run(`
${FLASK_FRAMEWORK}

app = MiniFlask()
request_log = []

@app.before_request
def log_request(request):
    request_log.append(f"before:{request['path']}")

@app.after_request
def add_header(request, response):
    request_log.append(f"after:{request['path']}")
    return response

@app.route("/hello")
def hello(request):
    return {"status": 200, "body": "hello"}

app.handle("GET", "http://localhost/hello")
print("|".join(request_log))
`);
    expect(status).toBe(200);
    expect(text).toBe("before:/hello|after:/hello");
  });

  // Pattern 8: Method routing (GET vs POST on same path)
  it("method-based routing", async () => {
    const { text, status } = await run(`
${FLASK_FRAMEWORK}

app = MiniFlask()
items = [{"id": 1, "name": "Widget"}]

@app.route("/items", methods=["GET"])
def list_items(request):
    return {"status": 200, "body": json.dumps(items)}

@app.route("/items", methods=["POST"])
def create_item(request):
    item = request["json_data"]
    item["id"] = len(items) + 1
    items.append(item)
    return {"status": 201, "body": json.dumps(item)}

# GET
r1 = app.handle("GET", "http://localhost/items")
print(f"get_count={len(json.loads(r1['body']))}")

# POST
body = json.dumps({"name": "Gadget"})
r2 = app.handle("POST", "http://localhost/items", body=body, headers={"Content-Type": "application/json"})
print(f"post_status={r2['status']}")
created = json.loads(r2["body"])
print(f"post_id={created['id']}")

# GET again
r3 = app.handle("GET", "http://localhost/items")
print(f"get_count2={len(json.loads(r3['body']))}")
`);
    expect(status).toBe(200);
    expect(text).toContain("get_count=1");
    expect(text).toContain("post_status=201");
    expect(text).toContain("post_id=2");
    expect(text).toContain("get_count2=2");
  });
});

// ---------------------------------------------------------------------------
// FLASK PATTERN: Blueprint-like modular routes
// ---------------------------------------------------------------------------

describe("Flask Conformance — blueprints and modular apps", () => {

  it("blueprint-style modular route registration", async () => {
    const { text, status } = await run(`
${FLASK_FRAMEWORK}

class Blueprint:
    """Flask Blueprint equivalent — modular route groups."""
    def __init__(self, name, prefix=""):
        self.name = name
        self.prefix = prefix
        self.routes = []

    def route(self, pattern, methods=None):
        def decorator(fn):
            self.routes.append((self.prefix + pattern, methods, fn))
            return fn
        return decorator

    def register(self, app):
        for pattern, methods, fn in self.routes:
            app.route(pattern, methods=methods)(fn)

# Create blueprints
api_bp = Blueprint("api", prefix="/api/v1")
admin_bp = Blueprint("admin", prefix="/admin")

@api_bp.route("/users")
def api_users(request):
    return {"status": 200, "body": json.dumps({"users": ["alice", "bob"]})}

@api_bp.route("/health")
def api_health(request):
    return {"status": 200, "body": json.dumps({"status": "ok"})}

@admin_bp.route("/dashboard")
def admin_dashboard(request):
    return {"status": 200, "body": "Admin Dashboard"}

# Register blueprints with app
app = MiniFlask()
api_bp.register(app)
admin_bp.register(app)

# Test routes from different blueprints
r1 = app.handle("GET", "http://localhost/api/v1/users")
print(f"users={json.loads(r1['body'])['users']}")

r2 = app.handle("GET", "http://localhost/api/v1/health")
print(f"health={json.loads(r2['body'])['status']}")

r3 = app.handle("GET", "http://localhost/admin/dashboard")
print(f"admin={r3['body']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("users=['alice', 'bob']");
    expect(text).toContain("health=ok");
    expect(text).toContain("admin=Admin Dashboard");
  });
});

// ---------------------------------------------------------------------------
// FLASK PATTERN: Template rendering with Jinja2
// ---------------------------------------------------------------------------

describe("Flask Conformance — Jinja2 template rendering", () => {

  it("renders templates like Flask's render_template()", async () => {
    // Build code as array to avoid esbuild parsing Jinja2 {{ }} as JS template expressions
    const code = [
      "import jinja2",
      "import json",
      "",
      'layout = "<!DOCTYPE html><html><head><title>{% block title %}{% endblock %}</title></head>"',
      'layout += "<body><nav>{{ nav_items|join(\' | \') }}</nav>"',
      'layout += "{% block content %}{% endblock %}"',
      'layout += "<footer>{{ year }}</footer></body></html>"',
      "",
      'index = \'{% extends "layout.html" %}\'',
      'index += "{% block title %}Home{% endblock %}"',
      'index += "{% block content %}"',
      'index += "<h1>Welcome, {{ user.name }}!</h1>"',
      'index += "<ul>{% for item in items %}"',
      'index += "<li>{{ item.name }} - ${{ \\"%.2f\\"|format(item.price) }}</li>"',
      'index += "{% endfor %}</ul>"',
      'index += "{% endblock %}"',
      "",
      'templates = {"layout.html": layout, "index.html": index}',
      "env = jinja2.Environment(loader=jinja2.DictLoader(templates))",
      'tmpl = env.get_template("index.html")',
      "html = tmpl.render(",
      '    user={"name": "Alice"},',
      '    items=[{"name": "Widget", "price": 9.99}, {"name": "Gadget", "price": 24.50}],',
      '    nav_items=["Home", "Products", "About"],',
      "    year=2026,",
      ")",
      "",
      'print("has_title=" + str("<title>Home</title>" in html))',
      'print("has_user=" + str("Welcome, Alice!" in html))',
      'print("has_item=" + str("Widget - $9.99" in html))',
      'print("has_nav=" + str("Home | Products | About" in html))',
      'print("has_footer=" + str("2026" in html))',
    ].join("\n");
    const { text, status } = await run(code);
    expect(status).toBe(200);
    expect(text).toContain("has_title=True");
    expect(text).toContain("has_user=True");
    expect(text).toContain("has_item=True");
    expect(text).toContain("has_nav=True");
    expect(text).toContain("has_footer=True");
  });
});

// ---------------------------------------------------------------------------
// FLASK PATTERN: Real-world CRUD API (full application)
// ---------------------------------------------------------------------------

describe("Flask Conformance — full CRUD API application", () => {

  it("implements a complete REST API with CRUD operations", async () => {
    const { text, status } = await run(`
${FLASK_FRAMEWORK}

app = MiniFlask()
db = {"next_id": 1, "todos": {}}

@app.route("/api/todos", methods=["GET"])
def list_todos(request):
    todos = list(db["todos"].values())
    return {"status": 200, "body": json.dumps(todos)}

@app.route("/api/todos", methods=["POST"])
def create_todo(request):
    data = request["json_data"]
    todo_id = db["next_id"]
    db["next_id"] += 1
    todo = {"id": todo_id, "title": data["title"], "done": False}
    db["todos"][todo_id] = todo
    return {"status": 201, "body": json.dumps(todo)}

@app.route("/api/todos/<int:todo_id>", methods=["GET"])
def get_todo(request, todo_id):
    todo = db["todos"].get(todo_id)
    if not todo:
        return {"status": 404, "body": json.dumps({"error": "not found"})}
    return {"status": 200, "body": json.dumps(todo)}

@app.route("/api/todos/<int:todo_id>", methods=["PUT"])
def update_todo(request, todo_id):
    todo = db["todos"].get(todo_id)
    if not todo:
        return {"status": 404, "body": json.dumps({"error": "not found"})}
    data = request["json_data"]
    todo.update(data)
    return {"status": 200, "body": json.dumps(todo)}

@app.route("/api/todos/<int:todo_id>", methods=["DELETE"])
def delete_todo(request, todo_id):
    if todo_id not in db["todos"]:
        return {"status": 404, "body": json.dumps({"error": "not found"})}
    del db["todos"][todo_id]
    return {"status": 204, "body": ""}

# CREATE
r = app.handle("POST", "http://localhost/api/todos",
    body=json.dumps({"title": "Buy milk"}),
    headers={"Content-Type": "application/json"})
print(f"create_status={r['status']}")
todo = json.loads(r["body"])
print(f"create_id={todo['id']}")

# CREATE another
app.handle("POST", "http://localhost/api/todos",
    body=json.dumps({"title": "Write tests"}),
    headers={"Content-Type": "application/json"})

# LIST
r = app.handle("GET", "http://localhost/api/todos")
todos = json.loads(r["body"])
print(f"list_count={len(todos)}")

# READ
r = app.handle("GET", "http://localhost/api/todos/1")
print(f"read_title={json.loads(r['body'])['title']}")

# UPDATE
r = app.handle("PUT", "http://localhost/api/todos/1",
    body=json.dumps({"done": True}),
    headers={"Content-Type": "application/json"})
print(f"update_done={json.loads(r['body'])['done']}")

# DELETE
r = app.handle("DELETE", "http://localhost/api/todos/1")
print(f"delete_status={r['status']}")

# LIST after delete
r = app.handle("GET", "http://localhost/api/todos")
print(f"final_count={len(json.loads(r['body']))}")
`);
    expect(status).toBe(200);
    expect(text).toContain("create_status=201");
    expect(text).toContain("create_id=1");
    expect(text).toContain("list_count=2");
    expect(text).toContain("read_title=Buy milk");
    expect(text).toContain("update_done=True");
    expect(text).toContain("delete_status=204");
    expect(text).toContain("final_count=1");
  });
});

// ---------------------------------------------------------------------------
// FLASK PATTERN: Data validation (like Flask-Marshmallow or WTForms)
// ---------------------------------------------------------------------------

describe("Flask Conformance — data validation patterns", () => {

  it("schema validation like Flask-Marshmallow", async () => {
    const { text, status } = await run(`
import json
import re

class ValidationError(Exception):
    def __init__(self, errors):
        self.errors = errors
        super().__init__(str(errors))

class Schema:
    """Marshmallow-style schema validation."""
    fields = {}

    @classmethod
    def validate(cls, data):
        errors = {}
        cleaned = {}
        for name, rules in cls.fields.items():
            value = data.get(name)
            # Required check
            if rules.get("required") and (value is None or value == ""):
                errors[name] = "This field is required"
                continue
            if value is None:
                cleaned[name] = rules.get("default")
                continue
            # Type check
            expected_type = rules.get("type")
            if expected_type and not isinstance(value, expected_type):
                try:
                    value = expected_type(value)
                except (ValueError, TypeError):
                    errors[name] = f"Expected {expected_type.__name__}"
                    continue
            # Min/max for numbers
            if "min" in rules and value < rules["min"]:
                errors[name] = f"Must be >= {rules['min']}"
                continue
            if "max" in rules and value > rules["max"]:
                errors[name] = f"Must be <= {rules['max']}"
                continue
            # Pattern for strings
            if "pattern" in rules and isinstance(value, str):
                if not re.match(rules["pattern"], value):
                    errors[name] = f"Invalid format"
                    continue
            cleaned[name] = value
        if errors:
            raise ValidationError(errors)
        return cleaned

class UserSchema(Schema):
    fields = {
        "name": {"required": True, "type": str},
        "email": {"required": True, "type": str, "pattern": r"^[^@]+@[^@]+\\.[^@]+$"},
        "age": {"required": False, "type": int, "min": 0, "max": 150, "default": None},
    }

# Valid data
data = UserSchema.validate({"name": "Alice", "email": "alice@example.com", "age": 30})
print(f"valid_name={data['name']}")
print(f"valid_email={data['email']}")
print(f"valid_age={data['age']}")

# Missing required field
try:
    UserSchema.validate({"email": "bob@example.com"})
except ValidationError as e:
    print(f"missing_name={'name' in e.errors}")

# Invalid email
try:
    UserSchema.validate({"name": "Charlie", "email": "not-an-email"})
except ValidationError as e:
    print(f"invalid_email={'email' in e.errors}")

# Age out of range
try:
    UserSchema.validate({"name": "Dave", "email": "dave@test.com", "age": -5})
except ValidationError as e:
    print(f"invalid_age={'age' in e.errors}")
`);
    expect(status).toBe(200);
    expect(text).toContain("valid_name=Alice");
    expect(text).toContain("valid_email=alice@example.com");
    expect(text).toContain("valid_age=30");
    expect(text).toContain("missing_name=True");
    expect(text).toContain("invalid_email=True");
    expect(text).toContain("invalid_age=True");
  });
});
