#!/usr/bin/env node
// pymode CLI — init, dev, deploy for Python on Cloudflare Workers

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const { argv, exit } = process;
const command = argv[2];
const args = argv.slice(3);

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf-8"));

const USAGE = `
  pymode v${pkg.version} — Python on Cloudflare Workers

  Usage:
    pymode init <project-name>    Create a new PyMode project
    pymode dev                    Start local dev server with hot reload
    pymode deploy                 Bundle and deploy to Cloudflare Workers

  Options:
    --version, -V                 Show version
    --help, -h                    Show this help

  Run pymode <command> --help for command-specific options.

  Examples:
    pymode init my-worker
    cd my-worker && pymode dev
    pymode dev --verbose --env API_KEY=secret
    pymode deploy
`;

async function main() {
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    exit(0);
  }

  if (command === "--version" || command === "-V") {
    console.log(`pymode v${pkg.version}`);
    exit(0);
  }

  switch (command) {
    case "init": {
      const { init } = await import("../commands/init.js");
      await init(args);
      break;
    }
    case "dev": {
      const { dev } = await import("../commands/dev.js");
      await dev(args);
      break;
    }
    case "deploy": {
      const { deploy } = await import("../commands/deploy.js");
      await deploy(args);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  exit(1);
});
