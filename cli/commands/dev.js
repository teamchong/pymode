// pymode dev — local dev server with hot reload
//
// Runs your on_fetch() handler locally using native Python (not WASM).
// Same JSON protocol as production: request JSON on stdin → response JSON on stdout.
// This gives instant iteration without needing to build python.wasm.

import { createServer } from "http";
import { spawn } from "child_process";
import { watch, readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

function loadDevVars(projectDir) {
  // Load .dev.vars (same convention as wrangler) for project-specific env vars
  const devVarsPath = join(projectDir, ".dev.vars");
  const vars = {};
  if (existsSync(devVarsPath)) {
    const content = readFileSync(devVarsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  }
  return vars;
}

function findPymodeLib() {
  // Look for lib/pymode relative to CLI package, then in the repo
  const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const candidates = [
    join(cliDir, "runtime"),           // npm package ships runtime/
    join(cliDir, "..", "lib", "pymode"), // development: repo/lib/pymode
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "workers.py")) || existsSync(join(dir, "pymode", "workers.py"))) {
      // Return the parent of pymode/ so PYTHONPATH works
      return existsSync(join(dir, "workers.py")) ? dirname(dir) : dir;
    }
  }
  return null;
}

function findEntryModule(projectDir) {
  // Read from pyproject.toml
  const pyproject = join(projectDir, "pyproject.toml");
  if (existsSync(pyproject)) {
    const content = readFileSync(pyproject, "utf-8");
    const match = content.match(/main\s*=\s*"([^"]+)"/);
    if (match) {
      return match[1].replace(/\.py$/, "").replace(/\//g, ".");
    }
  }
  // Fallback: check common entry points
  for (const candidate of ["src/entry.py", "entry.py", "app.py", "main.py"]) {
    if (existsSync(join(projectDir, candidate))) {
      return candidate.replace(/\.py$/, "").replace(/\//g, ".");
    }
  }
  return null;
}

function runHandler(projectDir, pymodeLib, entryModule, requestJson) {
  return new Promise((resolve, reject) => {
    // Build PYTHONPATH: pymode runtime + user project + installed packages (.whl files)
    const pathParts = [pymodeLib, projectDir];
    const pkgDir = join(projectDir, ".pymode", "packages");
    if (existsSync(pkgDir)) {
      // Add .whl files directly — Python can import from wheel ZIPs on sys.path
      for (const f of readdirSync(pkgDir)) {
        if (f.endsWith(".whl")) pathParts.push(join(pkgDir, f));
      }
    }
    const pythonPath = pathParts.filter(Boolean).join(":");

    const proc = spawn("python3", ["-m", "pymode._handler", entryModule], {
      cwd: projectDir,
      env: { ...process.env, PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run Python: ${err.message}. Is python3 installed?`));
    });

    proc.on("close", (code) => {
      if (stderr) {
        // Print Python stderr to terminal (tracebacks, print statements)
        process.stderr.write(stderr);
      }
      resolve({ stdout, stderr, exitCode: code });
    });

    // Write request JSON to stdin
    proc.stdin.write(requestJson);
    proc.stdin.end();
  });
}

export async function dev(args) {
  let port = 8787;
  let entryOverride = null;
  let verbose = false;
  const cliEnvVars = {};

  // Parse args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--entry" && args[i + 1]) {
      entryOverride = args[i + 1].replace(/\.py$/, "").replace(/\//g, ".");
      i++;
    } else if (args[i] === "--env" && args[i + 1]) {
      const eq = args[i + 1].indexOf("=");
      if (eq !== -1) {
        cliEnvVars[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
      }
      i++;
    } else if (args[i] === "--verbose" || args[i] === "-v") {
      verbose = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
  pymode dev — local dev server with hot reload

  Usage:
    pymode dev [options]

  Options:
    --port <port>        Port to listen on (default: 8787)
    --entry <file>       Override entry point (default: from pyproject.toml)
    --env KEY=VALUE      Set an environment variable (repeatable)
    --verbose, -v        Log request/response bodies for debugging
    --help, -h           Show this help
      `);
      process.exit(0);
    }
  }

  const projectDir = process.cwd();
  const entryModule = entryOverride || findEntryModule(projectDir);
  if (!entryModule) {
    console.error("No entry point found. Create src/entry.py or set [tool.pymode] main in pyproject.toml");
    process.exit(1);
  }

  const pymodeLib = findPymodeLib();
  if (!pymodeLib) {
    console.error("PyMode runtime not found. Install pymode or run from the repo.");
    process.exit(1);
  }

  // Verify python3 is available
  try {
    const { execSync } = await import("child_process");
    execSync("python3 --version", { stdio: "pipe" });
  } catch {
    console.error("python3 not found. Install Python 3.10+ to use pymode dev.");
    process.exit(1);
  }

  // Load .dev.vars for project-specific env vars/secrets
  const devVars = loadDevVars(projectDir);
  const devVarsCount = Object.keys(devVars).length;

  console.log(`
  PyMode dev server

  Entry:   ${entryModule}
  Project: ${projectDir}
  Runtime: ${pymodeLib}${devVarsCount ? `\n  Env:     ${devVarsCount} var(s) from .dev.vars` : ""}
  `);

  // Watch for .py file changes
  let changeCount = 0;
  const watcher = watch(projectDir, { recursive: true }, (event, filename) => {
    if (filename && filename.endsWith(".py") && !filename.includes("__pycache__")) {
      changeCount++;
      console.log(`  [reload] ${filename} changed`);
    }
  });

  // HTTP server
  const server = createServer(async (req, res) => {
    const startTime = Date.now();

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // Build full URL
    const url = `http://localhost:${port}${req.url}`;

    // Read request body
    let body = "";
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => { data += chunk; });
        req.on("end", () => resolve(data));
      });
    }

    // Collect headers
    const headers = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headers[req.rawHeaders[i]] = req.rawHeaders[i + 1];
    }

    // Serialize request — pass .dev.vars + CLI --env + PYMODE_*/CF_* from shell
    const envVars = { ...devVars, ...cliEnvVars };
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith("PYMODE_") || k.startsWith("CF_")) {
        envVars[k] = v;
      }
    }
    const requestJson = JSON.stringify({
      request: {
        method: req.method,
        url,
        headers,
        body,
      },
      env: envVars,
    });

    if (verbose) {
      console.log(`  ← ${req.method} ${req.url}`);
      if (body) console.log(`    Body: ${body.length > 200 ? body.slice(0, 200) + "..." : body}`);
    }

    try {
      const result = await runHandler(projectDir, pymodeLib, entryModule, requestJson);

      if (!result.stdout.trim()) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(result.stderr || "(empty response)");
        return;
      }

      // Parse response JSON
      let data;
      try {
        data = JSON.parse(result.stdout);
      } catch {
        // Not JSON — return as plain text
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(result.stdout);
        return;
      }

      const respHeaders = data.headers || {};
      respHeaders["X-Powered-By"] = "PyMode-Dev";
      respHeaders["Access-Control-Allow-Origin"] = "*";

      let respBody = data.body || "";
      if (data.bodyIsBinary && data.body) {
        respBody = Buffer.from(data.body, "base64");
      }

      res.writeHead(data.status || 200, respHeaders);
      res.end(respBody);

      const elapsed = Date.now() - startTime;
      const status = data.status || 200;
      console.log(`  ${req.method} ${req.url} → ${status} (${elapsed}ms)`);
      if (verbose && data.body) {
        const preview = data.body.length > 200 ? data.body.slice(0, 200) + "..." : data.body;
        console.log(`    Body: ${preview}`);
      }
    } catch (err) {
      console.error(`  ${req.method} ${req.url} → ERROR: ${err.message}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`PyMode dev error: ${err.message}\n`);
    }
  });

  server.listen(port, () => {
    console.log(`  Listening on http://localhost:${port}`);
    console.log(`  Watching for .py changes...\n`);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n  Shutting down...");
    watcher.close();
    server.close();
    process.exit(0);
  });
}
