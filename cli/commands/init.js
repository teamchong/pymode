// pymode init <project-name> — scaffold a new PyMode project

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export async function init(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  pymode init — scaffold a new PyMode project

  Usage:
    pymode init <project-name>

  Creates a new directory with:
    src/entry.py        Handler with on_fetch()
    pyproject.toml      Project config
    .gitignore          Python + PyMode ignores
    `);
    process.exit(0);
  }

  const name = args[0];
  if (!name) {
    console.error("Usage: pymode init <project-name>");
    process.exit(1);
  }

  const dir = join(process.cwd(), name);
  if (existsSync(dir)) {
    console.error(`Directory already exists: ${name}`);
    process.exit(1);
  }

  console.log(`Creating PyMode project: ${name}`);

  mkdirSync(join(dir, "src"), { recursive: true });

  // pyproject.toml
  writeFileSync(
    join(dir, "pyproject.toml"),
    `[project]
name = "${name}"
version = "0.1.0"
# dependencies = [
#     "requests",    # pure-Python packages work out of the box
#     "numpy",       # C extensions auto-select the right WASM variant
# ]

[tool.pymode]
main = "src/entry.py"
# wizer = true    # Enable deploy-time snapshots (~5ms cold starts)
`
  );

  // Entry point
  writeFileSync(
    join(dir, "src", "entry.py"),
    `"""${name} — PyMode Worker."""

from pymode.workers import Response


def on_fetch(request, env):
    """Handle incoming HTTP requests."""

    if request.path == "/":
        return Response("Hello from ${name}!")

    if request.path == "/json":
        return Response.json({
            "message": "Hello from ${name}!",
            "method": request.method,
            "url": request.url,
        })

    if request.path == "/echo":
        if request.method == "POST":
            return Response(request.text(), headers={
                "Content-Type": request.headers.get("content-type", "text/plain"),
            })
        return Response("Send a POST request to /echo", status=405)

    if request.path == "/greet":
        name = request.query.get("name", ["World"])[0]
        return Response(f"Hello, {name}!")

    return Response("Not Found", status=404)
`
  );

  // .gitignore
  writeFileSync(
    join(dir, ".gitignore"),
    `__pycache__/
*.pyc
.venv/
node_modules/
.wrangler/
.dev.vars
.pymode/
`
  );

  console.log(`
  Done! Created ${name}/

  Files:
    src/entry.py        Your handler — edit on_fetch() here
    pyproject.toml      Project config

  Next steps:
    cd ${name}
    pymode add requests     Add packages
    pymode dev              Start local dev server
    pymode deploy           Deploy to Cloudflare Workers
`);
}
