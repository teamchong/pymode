/**
 * TypeScript worker that calls Python functions via DO RPC.
 *
 * This pattern lets you package any Python library as a typed,
 * importable service for your TypeScript workers.
 *
 * Setup:
 *   1. Deploy the Python service worker (python-service/)
 *   2. Add a service binding in this worker's wrangler.toml
 *   3. Call Python functions with full type safety
 */

// In a real project, import from "pymode":
//   import type { PythonDORpc } from "pymode";
// For this example, we inline the type:
interface PythonDORpc {
  executeCode(code: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  callFunction(
    modulePath: string,
    functionName: string,
    args?: Record<string, unknown>,
  ): Promise<{
    returnValue: unknown;
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

interface Env {
  PYTHON_DO: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Get a reference to the Python DO
    const doId = env.PYTHON_DO.idFromName("default");
    const pythonDO = env.PYTHON_DO.get(doId) as unknown as PythonDORpc;

    // Route to different Python functions
    if (url.pathname === "/stats") {
      const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const result = await pythonDO.callFunction(
        "src.analytics",
        "summarize",
        { values },
      );
      return Response.json(result.returnValue);
    }

    if (url.pathname === "/tokenize") {
      const text = url.searchParams.get("text") || "Hello World! こんにちは世界";
      const result = await pythonDO.callFunction(
        "src.analytics",
        "tokenize",
        { text },
      );
      return Response.json(result.returnValue);
    }

    if (url.pathname === "/render") {
      const result = await pythonDO.callFunction(
        "src.analytics",
        "render_template",
        {
          template: "Hello {{ name }}! You have {{ count }} items.",
          context: { name: "Developer", count: 42 },
        },
      );
      return new Response(result.returnValue as string);
    }

    return new Response("Endpoints: /stats, /tokenize?text=..., /render", {
      status: 404,
    });
  },
};
