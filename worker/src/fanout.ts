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
 * Write-generation tracking: each mutation (put/delete) bumps a generation
 * counter. Read cache keys include the generation, so a read AFTER a
 * mutation gets a different cache key than the same read BEFORE the mutation.
 * resolveAll() executes in generation order: writes at gen 0, then reads
 * at gen 0, then writes at gen 1, then reads at gen 1, etc. This ensures
 * put→get→delete→get sees the correct state at each step.
 */

import { encoder as _encoder, decoder as _decoder } from "./stdlib-bin";

/** A recorded async call that needs resolution. */
export interface PendingCall {
  type: string;
  /** Cache key — type + serialized args (+ @gen for reads) */
  key: string;
  /** Arguments needed to resolve this call */
  args: unknown[];
  /** Write generation at time of recording */
  gen: number;
}

/**
 * Fan-out context for a single request.
 * Tracks pending async calls and cached results across replay passes.
 */
export class FanoutContext {
  /** Cached results from previous passes. */
  readonly cache = new Map<string, unknown>();
  /** Pending read operations recorded during the current pass. */
  pendingCalls: PendingCall[] = [];
  /** Pending write operations (kv_put, kv_delete, r2_put, d1 mutations) */
  pendingWrites: PendingCall[] = [];
  /** Monotonic write counter — bumped on each mutation. */
  private _writeGen = 0;

  /** Check cache or record a READ operation.
   * Cache key includes write generation so reads after mutations get fresh keys. */
  getOrRecord(type: string, args: unknown[]): { cached: boolean; value: unknown } {
    const key = `${cacheKey(type, args)}@${this._writeGen}`;
    if (this.cache.has(key)) {
      return { cached: true, value: this.cache.get(key) };
    }
    this.pendingCalls.push({ type, key, args, gen: this._writeGen });
    return { cached: false, value: null };
  }

  /** Record a WRITE operation. Bumps generation counter so subsequent
   * reads use fresh cache keys. Skips execution if already cached. */
  recordWrite(type: string, args: unknown[]): void {
    const key = cacheKey(type, args);
    if (!this.cache.has(key)) {
      this.pendingWrites.push({ type, key, args, gen: this._writeGen });
    }
    this._writeGen++;
  }

  /** True if there are unresolved async calls. */
  get hasPending(): boolean {
    return this.pendingCalls.length > 0 || this.pendingWrites.length > 0;
  }

  /** Reset for next pass (keep cache, clear pending, reset generation). */
  resetPass(): void {
    this.pendingCalls = [];
    this.pendingWrites = [];
    this._writeGen = 0;
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

/**
 * Resolve all pending calls in generation order.
 *
 * A read at gen N sees state after all writes at gen < N.
 * Sequence: writes@0 → reads@1 → writes@1 → reads@2 → writes@2 → reads@3 → ...
 *
 * This ensures put→get→delete→get sees correct intermediate state:
 *   put (gen 0→1) → get (gen 1) → delete (gen 1→2) → get (gen 2)
 * Resolves as: put@0 → get@1 (sees put) → delete@1 → get@2 (sees delete)
 */
export async function resolveAll(
  fanout: FanoutContext,
  env: Record<string, unknown>,
): Promise<void> {
  // Find max generation across all pending operations
  let maxGen = 0;
  for (const call of fanout.pendingWrites) {
    if (call.gen > maxGen) maxGen = call.gen;
  }
  for (const call of fanout.pendingCalls) {
    if (call.gen > maxGen) maxGen = call.gen;
  }

  // Resolve in order: for each gen, writes at gen, then reads at gen+1
  // (reads at gen N were recorded AFTER writes bumped gen to N)
  for (let gen = 0; gen <= maxGen; gen++) {
    // Execute writes recorded at this generation
    const genWrites = fanout.pendingWrites.filter(c => c.gen === gen);
    if (genWrites.length > 0) {
      await Promise.all(
        genWrites.map(async (call) => {
          const result = await resolvePendingCall(call, env);
          fanout.cache.set(call.key, result);
        })
      );
    }

    // Execute reads recorded at gen+1 (they were recorded after this write bumped gen)
    const readGen = gen + 1;
    const genReads = fanout.pendingCalls.filter(c => c.gen === readGen);
    if (genReads.length > 0) {
      await Promise.all(
        genReads.map(async (call) => {
          const result = await resolvePendingCall(call, env);
          fanout.cache.set(call.key, result);
        })
      );
    }
  }

  // Also resolve any reads at gen 0 (reads before any writes)
  const earlyReads = fanout.pendingCalls.filter(c => c.gen === 0);
  if (earlyReads.length > 0) {
    await Promise.all(
      earlyReads.map(async (call) => {
        if (!fanout.cache.has(call.key)) {
          const result = await resolvePendingCall(call, env);
          fanout.cache.set(call.key, result);
        }
      })
    );
  }
}
