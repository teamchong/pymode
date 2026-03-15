/**
 * fanout.ts — Fan-out replay runtime for PyMode.
 *
 * Architecture: WASM runs synchronously without Asyncify instrumentation.
 * Async host imports (KV, R2, D1, HTTP) return sentinel values on the
 * first pass while recording the call. After WASM exits, all pending
 * async calls are resolved in parallel via Promise.all. A new WASM
 * instance replays with cached results. The loop repeats until no
 * pending calls remain (handling conditional async paths).
 *
 * This eliminates wasm-opt --asyncify (~30% binary size overhead) and
 * makes all async operations parallel by default.
 */

import { encoder as _encoder, decoder as _decoder } from "./stdlib-bin";

/** A recorded async call that needs resolution. */
export interface PendingCall {
  type: string;
  /** Cache key — type + serialized args */
  key: string;
  /** Arguments needed to resolve this call */
  args: unknown[];
}

/**
 * Fan-out context for a single request.
 * Tracks pending async calls and cached results across replay passes.
 */
export class FanoutContext {
  /** Cached results from previous passes. Keyed by "type:args". */
  readonly cache = new Map<string, unknown>();
  /** Pending calls recorded during the current pass. */
  pendingCalls: PendingCall[] = [];
  /** Pending write operations (kv_put, kv_delete, r2_put) */
  pendingWrites: PendingCall[] = [];

  /** Check cache or record a READ operation.
   * Returns { cached: true, value } if cached, or { cached: false } if pending. */
  getOrRecord(type: string, args: unknown[]): { cached: boolean; value: unknown } {
    const key = cacheKey(type, args);
    if (this.cache.has(key)) {
      return { cached: true, value: this.cache.get(key) };
    }
    this.pendingCalls.push({ type, key, args });
    return { cached: false, value: null };
  }

  /** Record a WRITE operation (kv_put, kv_delete, r2_put).
   * Writes are deferred to after WASM exits, then executed before replay. */
  recordWrite(type: string, args: unknown[]): void {
    const key = cacheKey(type, args);
    if (!this.cache.has(key)) {
      this.pendingWrites.push({ type, key, args });
    }
  }

  /** True if there are unresolved async calls. */
  get hasPending(): boolean {
    return this.pendingCalls.length > 0 || this.pendingWrites.length > 0;
  }

  /** Reset for next pass (keep cache, clear pending). */
  resetPass(): void {
    this.pendingCalls = [];
    this.pendingWrites = [];
  }
}

function cacheKey(type: string, args: unknown[]): string {
  return `${type}:${args.map(a =>
    typeof a === "string" ? a :
    a instanceof Uint8Array ? `<${a.length}B>` :
    String(a)
  ).join("|")}`;
}

/** Resolve a single pending call using CF bindings. */
export async function resolvePendingCall(
  call: PendingCall,
  env: Record<string, unknown>,
): Promise<unknown> {
  switch (call.type) {
    case "kv_get": {
      const [bindingName, key] = call.args as [string, string];
      const kv = env[bindingName] as KVNamespace | undefined;
      if (!kv) return null;
      const val = await kv.get(key, "arrayBuffer");
      return val !== null ? new Uint8Array(val) : null;
    }
    case "kv_put": {
      const [bindingName, key, value] = call.args as [string, string, Uint8Array];
      const kv = env[bindingName] as KVNamespace | undefined;
      if (kv) await kv.put(key, value);
      return undefined;
    }
    case "kv_delete": {
      const [bindingName, key] = call.args as [string, string];
      const kv = env[bindingName] as KVNamespace | undefined;
      if (kv) await kv.delete(key);
      return undefined;
    }
    case "kv_multi_get": {
      const [keys, bindingName] = call.args as [string[], string];
      const kv = env[bindingName] as KVNamespace | undefined;
      if (!kv) return null;
      const results = await Promise.all(
        keys.map(async (k) => {
          const val = await kv.get(k, "arrayBuffer");
          return val !== null ? new Uint8Array(val) : null;
        })
      );
      return results;
    }
    case "kv_multi_put": {
      const [entries, bindingName] = call.args as [Array<[string, Uint8Array]>, string];
      const kv = env[bindingName] as KVNamespace | undefined;
      if (kv) await Promise.all(entries.map(([k, v]) => kv.put(k, v)));
      return undefined;
    }
    case "r2_get": {
      const [bindingName, key] = call.args as [string, string];
      const r2 = env[bindingName] as R2Bucket | undefined;
      if (!r2) return null;
      const obj = await r2.get(key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    }
    case "r2_put": {
      const [bindingName, key, value] = call.args as [string, string, Uint8Array];
      const r2 = env[bindingName] as R2Bucket | undefined;
      if (r2) await r2.put(key, value);
      return undefined;
    }
    case "d1_exec": {
      const [bindingName, sql, params] = call.args as [string, string, unknown[]];
      const d1 = env[bindingName] as D1Database | undefined;
      if (!d1) return null;
      const stmt = d1.prepare(sql).bind(...params);
      const { results } = await stmt.all();
      return results;
    }
    case "d1_batch": {
      const [bindingName, queries] = call.args as [
        string,
        Array<{ sql: string; params?: unknown[] }>
      ];
      const d1 = env[bindingName] as D1Database | undefined;
      if (!d1) return null;
      const stmts = queries.map((q) => d1.prepare(q.sql).bind(...(q.params || [])));
      const batchResults = await d1.batch(stmts);
      return batchResults.map((r) => r.results);
    }
    case "http_fetch_full": {
      const [url, method, body, headersJson] = call.args as [string, string, Uint8Array | null, string];
      const headers = JSON.parse(headersJson);
      const resp = await fetch(url, {
        method: method || "GET",
        headers,
        body: body && body.length > 0 ? body : undefined,
      });
      const respBody = new Uint8Array(await resp.arrayBuffer());
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((value, key) => { respHeaders[key] = value; });
      return { status: resp.status, headers: respHeaders, body: respBody };
    }
    case "tcp_recv": {
      return new Uint8Array(0);
    }
    case "thread_spawn": {
      return -1;
    }
    case "thread_join": {
      return new Uint8Array(0);
    }
    case "dl_open": {
      return -1;
    }
    default:
      console.error(`fanout: unknown call type: ${call.type}`);
      return null;
  }
}

/** Resolve all pending calls in parallel. */
export async function resolveAll(
  fanout: FanoutContext,
  env: Record<string, unknown>,
): Promise<void> {
  // Resolve writes first (they may affect subsequent reads on replay)
  if (fanout.pendingWrites.length > 0) {
    await Promise.all(
      fanout.pendingWrites.map(async (call) => {
        const result = await resolvePendingCall(call, env);
        fanout.cache.set(call.key, result);
      })
    );
  }
  // Then resolve reads
  if (fanout.pendingCalls.length > 0) {
    await Promise.all(
      fanout.pendingCalls.map(async (call) => {
        const result = await resolvePendingCall(call, env);
        fanout.cache.set(call.key, result);
      })
    );
  }
}
