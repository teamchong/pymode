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
    pymode build [recipe]         Build C extension recipes into WASM variants
    pymode add <package>          Add a Python package dependency
    pymode remove <package>       Remove a package dependency
    pymode install                Install all dependencies from pyproject.toml

  Options:
    --version, -V                 Show version
    --help, -h                    Show this help

  Run pymode <command> --help for command-specific options.

  Examples:
    pymode init my-worker
    cd my-worker && pymode dev
    pymode add requests jinja2
    pymode deploy --wizer
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
    case "build": {
      const { build } = await import("../commands/build.js");
      await build(args);
      break;
    }
    case "add": {
      const { add } = await import("../commands/add.js");
      await add(args);
      break;
    }
    case "remove": {
      const { remove } = await import("../commands/remove.js");
      await remove(args);
      break;
    }
    case "install": {
      const { install } = await import("../commands/install.js");
      await install(args);
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
