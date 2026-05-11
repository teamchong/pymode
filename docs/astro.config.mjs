import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Build target — controls how the docs site is hosted:
//   "worker" (default) → root of pymode.teamchong.net, base="/"
//   "github-pages"     → teamchong.github.io/pymode, base="/pymode"
const target = process.env.ASTRO_DEPLOY_TARGET ?? "worker";
const isWorker = target === "worker";

export default defineConfig({
  site: isWorker ? "https://pymode.teamchong.net" : "https://teamchong.github.io",
  base: isWorker ? "/" : "/pymode",
  // Dev-only proxy so the live benchmark page can POST to the pymode
  // worker on localhost:8787 without browser CORS preflights. In a
  // production deploy users point the page at deployed worker URLs
  // directly (the proxy is dev-server-only).
  vite: {
    server: {
      proxy: {
        "/bench-proxy/pymode": {
          target: "http://localhost:8787",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/bench-proxy\/pymode/, "/"),
        },
      },
    },
  },
  integrations: [
    starlight({
      title: "pymode",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/teamchong/pymode",
        },
      ],
      sidebar: [
        { label: "Overview", slug: "index" },
        { label: "Getting Started", slug: "getting-started" },
        { label: "Benchmark", slug: "benchmark", badge: { text: "live", variant: "tip" } },
        { label: "Architecture", slug: "architecture" },
        { label: "Request Handling", slug: "request-handling" },
        { label: "Bindings API", slug: "bindings-api" },
        { label: "API Reference", slug: "api-reference" },
        { label: "Deployment", slug: "deployment" },
        { label: "CLI Reference", slug: "cli" },
        { label: "Limitations", slug: "limitations" },
      ],
    }),
  ],
});
