/**
 * Test helpers — POST Python code to the running worker.
 *
 * The request goes through the full production path:
 *   fetch() → Worker.fetch() → PythonDO.handleRequest() (RPC) → python.wasm
 */

const BASE_URL = `http://localhost:${process.env.PYMODE_PORT || "8787"}`;

export async function runPython(code: string): Promise<{ text: string; status: number }> {
  const resp = await fetch(BASE_URL, {
    method: "POST",
    body: code,
    headers: { "Content-Type": "text/plain" },
  });
  const text = await resp.text();
  return { text: text.trim(), status: resp.status };
}
