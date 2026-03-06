import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://teamchong.github.io",
  base: "/pymode",
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
