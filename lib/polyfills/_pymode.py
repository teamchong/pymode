"""Pure-Python _pymode bridge for testing environments.

When the real _pymode C extension is not linked into python.wasm (e.g. in
test builds without Asyncify), this polyfill provides the same API backed
by in-memory stores. It reads seed data from /stdlib/tmp/_pymode_seed.json
if present, allowing the JS test harness to pre-populate KV, R2, D1, and
env data.

In production, the C extension takes priority (it's registered as a built-in
module in config.c). This polyfill only loads when the C module is absent.
"""

import json
import os

# In-memory stores
_kv_store = {}
_r2_store = {}
_d1_tables = {}
_env_vars = {}
_http_responses = {}
_next_resp_id = 0

# Load seed data from VFS if available
_SEED_PATH = "/stdlib/tmp/_pymode_seed.json"
def _decode_value(v):
    """Decode a seed value: string -> bytes, {"base64": "..."} -> decoded bytes, list -> bytes."""
    if isinstance(v, str):
        return v.encode()
    if isinstance(v, dict) and "base64" in v:
        import base64 as b64
        return b64.b64decode(v["base64"])
    if isinstance(v, list):
        return bytes(v)
    return str(v).encode()

if os.path.exists(_SEED_PATH):
    with open(_SEED_PATH) as f:
        _seed = json.load(f)
    for k, v in _seed.get("kv", {}).items():
        _kv_store[k] = _decode_value(v)
    for k, v in _seed.get("r2", {}).items():
        _r2_store[k] = _decode_value(v)
    _d1_tables.update(_seed.get("d1", {}))
    _env_vars.update(_seed.get("env", {}))


def kv_get(key):
    val = _kv_store.get(key)
    if val is None:
        return None
    return val if isinstance(val, bytes) else val.encode()


def kv_put(key, value):
    _kv_store[key] = value if isinstance(value, bytes) else value.encode()


def kv_delete(key):
    _kv_store.pop(key, None)


def r2_get(key):
    val = _r2_store.get(key)
    if val is None:
        return None
    return val if isinstance(val, bytes) else val.encode()


def r2_put(key, value):
    _r2_store[key] = value if isinstance(value, bytes) else value.encode()


def d1_exec(sql, params_json):
    params = json.loads(params_json) if isinstance(params_json, str) else params_json
    sql_upper = sql.strip().upper()

    if sql_upper.startswith("CREATE TABLE"):
        import re
        m = re.match(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", sql, re.IGNORECASE)
        if m and m.group(1) not in _d1_tables:
            _d1_tables[m.group(1)] = []
        return json.dumps([{"changes": 0}])

    if sql_upper.startswith("SELECT"):
        import re
        m = re.search(r"FROM\s+(\w+)", sql, re.IGNORECASE)
        if not m:
            return json.dumps([])
        table = m.group(1)
        rows = list(_d1_tables.get(table, []))

        # WHERE col = ?
        wm = re.search(r"WHERE\s+(\w+)\s*=\s*\?", sql, re.IGNORECASE)
        if wm and params:
            col = wm.group(1)
            val = params[0]
            rows = [r for r in rows if r.get(col) == val or str(r.get(col)) == str(val)]

        # WHERE col LIKE ?
        lm = re.search(r"WHERE\s+(\w+)\s+LIKE\s+\?", sql, re.IGNORECASE)
        if lm and params:
            col = lm.group(1)
            import fnmatch
            rows = [r for r in rows if fnmatch.fnmatch(str(r.get(col, "")), str(params[0]).replace("%", "*"))]

        # ORDER BY
        om = re.search(r"ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?", sql, re.IGNORECASE)
        if om:
            col = om.group(1)
            desc = (om.group(2) or "").upper() == "DESC"
            rows.sort(key=lambda r: r.get(col, ""), reverse=desc)

        # LIMIT
        lim = re.search(r"LIMIT\s+(\d+)", sql, re.IGNORECASE)
        if lim:
            rows = rows[:int(lim.group(1))]

        # Column selection
        sm = re.match(r"SELECT\s+(.+?)\s+FROM", sql, re.IGNORECASE)
        if sm and sm.group(1).strip() != "*":
            cols = [c.strip() for c in sm.group(1).split(",")]
            filtered = []
            for r in rows:
                row = {}
                for c in cols:
                    if c.upper().startswith("COUNT("):
                        row["COUNT(*)"] = len(_d1_tables.get(table, []))
                    else:
                        row[c] = r.get(c)
                filtered.append(row)
            rows = filtered

        return json.dumps(rows)

    if sql_upper.startswith("INSERT"):
        import re
        m = re.match(r"INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)", sql, re.IGNORECASE)
        if not m:
            return json.dumps([{"changes": 0}])
        table = m.group(1)
        cols = [c.strip() for c in m.group(2).split(",")]
        if table not in _d1_tables:
            _d1_tables[table] = []
        row = {"id": len(_d1_tables[table]) + 1}
        for i, col in enumerate(cols):
            row[col] = params[i] if i < len(params) else None
        _d1_tables[table].append(row)
        return json.dumps([{"changes": 1}])

    if sql_upper.startswith("UPDATE"):
        import re
        m = re.match(r"UPDATE\s+(\w+)\s+SET\s+(\w+)\s*=\s*\?\s+WHERE\s+(\w+)\s*=\s*\?", sql, re.IGNORECASE)
        if not m:
            return json.dumps([{"changes": 0}])
        table, set_col, where_col = m.group(1), m.group(2), m.group(3)
        changes = 0
        for row in _d1_tables.get(table, []):
            if row.get(where_col) == params[1] or str(row.get(where_col)) == str(params[1]):
                row[set_col] = params[0]
                changes += 1
        return json.dumps([{"changes": changes}])

    if sql_upper.startswith("DELETE"):
        import re
        m = re.match(r"DELETE\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?", sql, re.IGNORECASE)
        if not m:
            return json.dumps([{"changes": 0}])
        table, where_col = m.group(1), m.group(2)
        rows = _d1_tables.get(table, [])
        before = len(rows)
        _d1_tables[table] = [r for r in rows if r.get(where_col) != params[0] and str(r.get(where_col)) != str(params[0])]
        return json.dumps([{"changes": before - len(_d1_tables[table])}])

    return json.dumps([])


def env_get(key):
    return _env_vars.get(key)


def http_fetch(url, method, body, headers_json):
    global _next_resp_id
    resp_id = _next_resp_id
    _next_resp_id += 1

    if url.startswith("mock://"):
        path = url[7:]
        if path == "echo":
            _http_responses[resp_id] = {
                "status": 200,
                "headers": {"content-type": "application/octet-stream", "x-method": method},
                "body": body if isinstance(body, bytes) else body.encode() if body else b"",
                "offset": 0,
            }
        elif path == "json":
            data = json.dumps({"message": "hello", "method": method, "timestamp": 1234567890})
            _http_responses[resp_id] = {
                "status": 200,
                "headers": {"content-type": "application/json"},
                "body": data.encode(),
                "offset": 0,
            }
        elif path == "headers":
            _http_responses[resp_id] = {
                "status": 200,
                "headers": {"content-type": "application/json"},
                "body": headers_json.encode() if isinstance(headers_json, str) else headers_json,
                "offset": 0,
            }
        elif path == "status/404":
            _http_responses[resp_id] = {
                "status": 404,
                "headers": {"content-type": "text/plain"},
                "body": b"Not Found",
                "offset": 0,
            }
        elif path == "status/500":
            _http_responses[resp_id] = {
                "status": 500,
                "headers": {"content-type": "text/plain"},
                "body": b"Internal Server Error",
                "offset": 0,
            }
        else:
            _http_responses[resp_id] = {
                "status": 200,
                "headers": {"content-type": "text/plain"},
                "body": f"mock response for: {path}".encode(),
                "offset": 0,
            }
    else:
        _http_responses[resp_id] = {
            "status": 200,
            "headers": {"content-type": "text/plain"},
            "body": f"[test] would fetch: {url}".encode(),
            "offset": 0,
        }

    return resp_id


def http_response_status(resp_id):
    resp = _http_responses.get(resp_id)
    return resp["status"] if resp else -1


def http_response_read(resp_id, bufsize):
    resp = _http_responses.get(resp_id)
    if not resp:
        return b""
    body = resp["body"]
    offset = resp["offset"]
    remaining = len(body) - offset
    if remaining <= 0:
        return b""
    n = min(remaining, bufsize)
    chunk = body[offset:offset + n]
    resp["offset"] = offset + n
    return chunk


def http_response_header(resp_id, name):
    resp = _http_responses.get(resp_id)
    if not resp:
        return None
    return resp["headers"].get(name.lower())


def tcp_connect(host, port):
    raise OSError("TCP not available in test mode")

def tcp_send(conn_id, data):
    raise OSError("TCP not available in test mode")

def tcp_recv(conn_id, bufsize):
    raise OSError("TCP not available in test mode")

def tcp_close(conn_id):
    pass

def thread_spawn(code, input_data):
    raise RuntimeError("Thread DOs not available in test mode")

def thread_join(thread_id, bufsize=None):
    raise RuntimeError("Thread DOs not available in test mode")

def console_log(msg):
    import sys
    print(f"[pymode] {msg}", file=sys.stderr)
