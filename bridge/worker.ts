/**
 * Cloudflare Workers entry point for ZigPython
 *
 * Loads the Zig-compiled CPython WASM module and routes fetch() requests
 * to a Python handler. The Python handler receives the request as a dict
 * and returns a response dict.
 *
 * Python handler interface:
 *   def handle(request: dict) -> dict
 *     request = {"method": str, "url": str, "headers": dict, "body": bytes|None}
 *     returns  {"status": int, "headers": dict, "body": str|bytes}
 */

import { PythonRuntime } from "./runtime";

export interface Env {
  // R2 bucket for file storage (maps to Python open())
  STORAGE?: R2Bucket;
  // D1 database (maps to Python sqlite3)
  DB?: D1Database;
  // KV namespace (maps to Python shelve/dbm)
  KV?: KVNamespace;
  // Python handler module path
  HANDLER?: string;
  // Environment variables exposed to Python's os.environ
  [key: string]: unknown;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const runtime = await PythonRuntime.create(env);

    const handlerModule = env.HANDLER ?? "handler";

    const requestDict = {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body: request.body ? await request.arrayBuffer() : null,
    };

    try {
      const response = await runtime.callHandler(handlerModule, "handle", requestDict);

      return new Response(response.body, {
        status: response.status ?? 200,
        headers: new Headers(response.headers ?? {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Internal Server Error: ${message}`, { status: 500 });
    } finally {
      ctx.waitUntil(runtime.cleanup());
    }
  },
};
