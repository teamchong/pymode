
const d = new Diagram({ theme: "minimal", direction: "TB" });

// --- Row 0: Source Origins ---
const pypi = d.addBox("PyPI\n(wheels)", { row: 0, col: 0, color: "external", icon: "cloud" });
const stdlib = d.addBox("CPython 3.13\nStdlib", { row: 0, col: 1, color: "backend" });
const polyfills = d.addBox("WASI Polyfills\nsocket, ssl, select\nthreading, logging", { row: 0, col: 2, color: "orchestration" });
const cext = d.addBox("C Extensions\n(recipes/*.json)", { row: 0, col: 3, color: "ai" });

// --- Row 1: Build-time Processing ---
const sitezip = d.addBox("site-packages.zip\n32 pure Python pkgs\njinja2, click, bs4, yaml...", { row: 1, col: 0, color: "storage", width: 240 });
const stdlibfs = d.addBox("stdlib-fs.ts\n193 modules as\nTS string constants", { row: 1, col: 1.5, color: "backend", width: 240 });
const wasmmod = d.addBox(".wasm side modules\nmarkupsafe, numpy...\n(zig cc → wasm32-wasi)", { row: 1, col: 3, color: "ai", width: 240 });

// --- Row 2: Worker Bundle ---
const worker = d.addBox("CF Worker Bundle", { row: 2, col: 1.5, color: "frontend", width: 340, height: 60, icon: "server" });

// --- Row 3: Runtime Loading ---
const memfs = d.addBox("MemFS\n(/stdlib/*)", { row: 3, col: 0.5, color: "database", width: 200 });
const pythonpath = d.addBox("PYTHONPATH\n/stdlib:/stdlib/\nsite-packages.zip", { row: 3, col: 2, color: "cache", width: 220 });
const dlopen = d.addBox("dlopen polyfill\nshared memory\nside module loading", { row: 3, col: 3.5, color: "ai", width: 220 });

// --- Row 4: Python Runtime ---
const cpython = d.addBox("CPython 3.13\npython.wasm + Asyncify", { row: 4, col: 1.5, color: "backend", width: 340, height: 60, icon: "server" });

// --- Row 5: User Code ---
const usercode = d.addBox("import jinja2\nimport numpy\nfrom pymode.workers\n  import Response", { row: 5, col: 1.5, color: "users", width: 280, height: 80, icon: "user" });

// --- Connections: Source → Build artifacts ---
d.connect(pypi, sitezip, "pymode add / install", { style: "solid" });
d.connect(stdlib, stdlibfs, "generate-stdlib-fs.sh");
d.connect(polyfills, stdlibfs, "bundled as stdlib");
d.connect(cext, wasmmod, "build-variant.sh\nzig cc → wasm32-wasi");

// --- Build artifacts → Worker ---
d.connect(sitezip, worker, "embedded binary");
d.connect(stdlibfs, worker, "imported as TS module");
d.connect(wasmmod, worker, "wasm_modules binding");

// --- Worker → Runtime components ---
d.connect(worker, memfs, "mount files", { style: "dashed" });
d.connect(worker, pythonpath, "set env", { style: "dashed" });
d.connect(worker, dlopen, "register modules", { style: "dashed" });

// --- Runtime → CPython ---
d.connect(memfs, cpython, "WASI fd_read");
d.connect(pythonpath, cpython, "import search");
d.connect(dlopen, cpython, "PyInit_*\nvia func table");

// --- CPython → User Code ---
d.connect(cpython, usercode, "executes handler");

// --- Groups ---
d.addGroup("Build Time", [pypi, stdlib, polyfills, cext, sitezip, stdlibfs, wasmmod], { padding: 20, strokeStyle: "dashed", opacity: 40 });
d.addGroup("Runtime (PythonDO)", [memfs, pythonpath, dlopen, cpython, usercode], { padding: 20, strokeStyle: "dashed", opacity: 40 });

return d.render({ format: ["svg", "excalidraw"], path: "/Users/steven_chong/Downloads/repos/pymode/docs/package-loading" });
