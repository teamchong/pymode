
const d = new Diagram({ theme: "default", direction: "TB" });

// --- Row 0: Sources (what you start with) ---
const pypi = d.addBox("PyPI Wheels\n(pure Python)", { row: 0, col: 0, color: "external", icon: "cloud", width: 200 });
const cpystdlib = d.addBox("CPython 3.13\nStandard Library", { row: 0, col: 1.5, color: "backend", width: 200 });
const polyfills = d.addBox("WASI Polyfills\nsocket, ssl, select\nthreading, logging", { row: 0, col: 3, color: "backend", width: 200 });
const recipes = d.addBox("C Extension\nRecipes (*.json)\nnumpy, markupsafe...", { row: 0, col: 4.5, color: "ai", width: 200 });

// --- Row 1: Build artifacts ---
const sitezip = d.addBox("site-packages.zip\n32 packages", { row: 1.5, col: 0, color: "storage", width: 200 });
const stdlibts = d.addBox("stdlib-fs.ts\n194 .py modules\nas TS strings", { row: 1.5, col: 2, color: "backend", width: 220 });
const wasmMods = d.addBox("python-*.wasm\nC extensions linked\ninto variant binary", { row: 1.5, col: 4.5, color: "ai", width: 220 });

// --- Row 2: CF Worker ---
const worker = d.addBox("Cloudflare Worker\n(worker.ts + PythonDO)", { row: 3, col: 2, color: "frontend", width: 300, height: 50, icon: "server" });

// --- Row 3: WASM Runtime ---
const memfs = d.addBox("MemFS\n/stdlib/*.py", { row: 4.2, col: 0.5, color: "database", width: 180 });
const pypath = d.addBox("PYTHONPATH\n/stdlib\n/stdlib/site-packages.zip", { row: 4.2, col: 2.5, color: "cache", width: 220 });
const dlopen = d.addBox("dlopen polyfill\nshared WASM memory\nPyInit_* via func table", { row: 4.2, col: 4.5, color: "ai", width: 220 });

// --- Row 4: CPython ---
const cpython = d.addBox("CPython 3.13 (python.wasm)\nAsyncify + WASI", { row: 5.5, col: 2, color: "backend", width: 300, height: 50, icon: "server" });

// --- Row 5: User code ---
const user = d.addBox("Your Python Code\nimport jinja2, numpy\ndef on_fetch(req, env):", { row: 6.8, col: 2, color: "users", width: 280, icon: "user" });

// --- Build-time arrows ---
d.connect(pypi, sitezip, "pymode add");
d.connect(cpystdlib, stdlibts, "generate-stdlib-fs.sh");
d.connect(polyfills, stdlibts, "merged in");
d.connect(recipes, wasmMods, "build-variant.sh\nzig cc wasm32-wasi");

// --- Artifacts to Worker ---
d.connect(sitezip, worker, "bundled as binary data");
d.connect(stdlibts, worker, "TypeScript import");
d.connect(wasmMods, worker, "wasm_modules binding");

// --- Worker to runtime ---
d.connect(worker, memfs, "mount .py files", { style: "dashed" });
d.connect(worker, pypath, "set PYTHONPATH", { style: "dashed" });
d.connect(worker, dlopen, "register C exts", { style: "dashed" });

// --- Runtime to CPython ---
d.connect(memfs, cpython, "WASI fd_read");
d.connect(pypath, cpython, "import search path");
d.connect(dlopen, cpython, "PyInit_* function ptrs");

// --- CPython to user ---
d.connect(cpython, user, "executes on_fetch()");

// --- Labels for phases ---
d.addText("BUILD TIME", { x: -60, y: -10, fontSize: 14, strokeColor: "#868e96" });
d.addText("DEPLOY (CF Worker Bundle)", { x: -60, y: 470, fontSize: 14, strokeColor: "#868e96" });
d.addText("RUNTIME (per request)", { x: -60, y: 680, fontSize: 14, strokeColor: "#868e96" });

return d.render({ format: ["svg", "excalidraw"], path: "/Users/steven_chong/Downloads/repos/pymode/docs/package-loading" });
