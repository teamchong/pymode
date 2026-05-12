/*
 * pymode_wizer.c — Wizer-compatible entry point for CPython WASM.
 *
 * Splits CPython startup into two phases:
 *
 *   __wizer_initialize():  Called at BUILD TIME by Wizer.
 *     - Boots the interpreter (Py_InitializeFromConfig)
 *     - Pre-imports stdlib modules (sys, os, json, re, etc.)
 *     - Pre-imports pymode shims (pymode.tcp, pymode.http, pymode.env)
 *     - Wizer snapshots the linear memory after this returns.
 *
 *   _start():  Called at REQUEST TIME by PythonDO.
 *     - Interpreter is already warm from the snapshot.
 *     - Reads user code from /dev/stdin (piped by the WASI shim).
 *     - Executes user code on the pre-initialized interpreter.
 *
 * Build:
 *   zig cc -target wasm32-wasi pymode_wizer.c -lpython3.13 ... -o python.wasm
 *
 * Wizer snapshot:
 *   wizer python.wasm -o python-snapshot.wasm \
 *     --allow-wasi --wasm-bulk-memory true \
 *     --init-func __wizer_initialize \
 *     --mapdir /stdlib::./lib/python3.13
 *
 * At request time, python-snapshot.wasm starts with the interpreter already
 * initialized — cold start drops from ~28ms to ~5ms.
 */

#include "Python.h"
#include "pycore_initconfig.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* Flag: set to 1 after __wizer_initialize completes.
 * In the snapshot, this is already 1, so _start knows init is done. */
static int _pymode_initialized = 0;

/* Global/local namespace for executing user code */
static PyObject *_pymode_globals = NULL;
static PyObject *_pymode_locals = NULL;

/*
 * Pre-import a module by name. Errors are non-fatal — some modules
 * may not be available in the WASI build (that's fine, they're optional).
 */
static void _preimport(const char *name) {
    PyObject *mod = PyImport_ImportModule(name);
    if (mod) {
        Py_DECREF(mod);
    } else {
        PyErr_Clear();
    }
}

/*
 * Phase 1: Initialize interpreter and pre-import modules.
 * Called by Wizer at build time. Memory is snapshotted after this returns.
 */
__attribute__((export_name("wizer.initialize")))
void wizer_initialize(void) {
    PyConfig config;
    PyConfig_InitPythonConfig(&config);

    /* Minimal config for WASI */
    config.site_import = 0;
    config.write_bytecode = 0;
    config.user_site_directory = 0;
    config.install_signal_handlers = 0;
    config.pathconfig_warnings = 0;

    /* Set PYTHONPATH — include stdlib + site-packages for pre-imports.
     * /wizer-sp and /wizer-ext-sp are wizer-only mapdir destinations: see
     * build-wizer.ts. Using these wizer-private paths keeps the snapshot's
     * wasi-libc preopen table from poisoning the runtime mount points
     * /stdlib/site-packages.zip and /stdlib/extension-site-packages.zip,
     * which the runtime mounts as zip-file bytes (not directories).
     * For --mode=app builds, /stdlib/app is also on the path so the
     * user's entry module is importable at wizer time. */
    PyStatus status;
    status = PyConfig_SetBytesString(&config, &config.pythonpath_env,
#if defined(PYMODE_APP_PREIMPORTS)
        "/stdlib:/stdlib/app:/wizer-sp:/wizer-ext-sp"
#else
        "/stdlib:/wizer-sp:/wizer-ext-sp"
#endif
    );
    if (_PyStatus_EXCEPTION(status)) {
        PyConfig_Clear(&config);
        return;
    }

    status = Py_InitializeFromConfig(&config);
    PyConfig_Clear(&config);
    if (_PyStatus_EXCEPTION(status)) {
        return;
    }

    /* Pre-import commonly used stdlib modules.
     * These will be in the snapshot — zero import cost at request time. */
    _preimport("sys");
    _preimport("os");
    _preimport("io");
    _preimport("json");
    _preimport("re");
    _preimport("collections");
    _preimport("functools");
    _preimport("itertools");
    _preimport("pathlib");
    _preimport("typing");
    _preimport("dataclasses");
    _preimport("hashlib");
    _preimport("base64");
    _preimport("struct");
    _preimport("math");
    _preimport("datetime");
    _preimport("decimal");
    _preimport("enum");
    _preimport("abc");
    _preimport("importlib");
    _preimport("traceback");
    _preimport("string");
    _preimport("textwrap");
    _preimport("copy");
    _preimport("operator");
    _preimport("contextlib");

    /* Pre-import pymode shims */
    _preimport("pymode");
    _preimport("pymode.tcp");
    _preimport("pymode.http");
    _preimport("pymode.env");
    _preimport("pymode.workers");
    _preimport("pymode.mcp");
    _preimport("pymode._handler");  /* warm path calls _run() directly */
    _preimport("runpy");            /* fallback for slow path */
    _preimport("_wasi_compat");

    /* Heavy preimports. The default (PYMODE_HEAVY_PREIMPORTS=1) is the
     * "test runtime" build — covers everything the test suite exercises.
     * For deploy builds the build script generates a tailored override
     * via the optional `pymode_wizer_app_preimports.h` header and skips
     * setting PYMODE_HEAVY_PREIMPORTS, producing a smaller binary. */
#if defined(PYMODE_HEAVY_PREIMPORTS) && !defined(PYMODE_APP_PREIMPORTS)
    _preimport("pydantic");
    _preimport("pydantic.main");
    _preimport("httpx");
    _preimport("jinja2");
    _preimport("yaml");
    _preimport("rich");
    _preimport("rich.text");
    _preimport("tenacity");
    _preimport("fastmcp");
#endif

#if defined(PYMODE_APP_PREIMPORTS)
    /* Per-app preimports — generated at deploy time by
     * scripts/generate-app-preimports.mjs walking the user's entry.py
     * imports. Header may be empty if the app imports nothing extra. */
#include "pymode_wizer_app_preimports.h"
#endif

    /* MUST be last — rewrites the third-party packages' __path__ entries
     * from wizer-time paths (/wizer-sp/<pkg>, /wizer-ext-sp/<pkg>) to the
     * runtime zip-mount paths (/stdlib/site-packages.zip/<pkg>, …) so
     * submodule lookups succeed at runtime. Only needed when something
     * was preimported from a wizer-mounted directory. */
#if defined(PYMODE_HEAVY_PREIMPORTS) || defined(PYMODE_APP_PREIMPORTS)
    _preimport("pymode._path_fixup");
#endif

    /* Create the execution namespace.
     * __main__.__dict__ serves as both globals and locals. */
    PyObject *main_mod = PyImport_AddModule("__main__");
    if (main_mod) {
        _pymode_globals = PyModule_GetDict(main_mod);  /* borrowed ref */
        Py_INCREF(_pymode_globals);
        _pymode_locals = _pymode_globals;
    }

    _pymode_initialized = 1;
}

/*
 * pymode_warm_run — exported entry point for persistent-instance reuse.
 *
 * Calling wasi-libc's _start a second time on the same wasm instance
 * traps with "unreachable" because the wrapper invokes
 * __wasm_call_ctors() (constructors guard against double-init), then
 * calls __wasi_proc_exit(rc) and emits an `unreachable` after.
 *
 * This function does the same thing as main()'s warm path but is
 * callable repeatedly from JS without going through wasi-libc's
 * one-shot _start wrapper. JS sets PYTHONPATH via env, sets stdin via
 * the wasi shim, then calls pymode_warm_run(module_name_ptr, len).
 *
 * Returns the exit code; non-zero on Python-level error.
 */
/* Cached references — initialised on first warm_run call, reused thereafter. */
static PyObject *_cached_sys = NULL;
static PyObject *_cached_handler_run = NULL;   /* pymode._handler._run */
static PyObject *_cached_argv_handler_str = NULL;  /* "pymode._handler" */
static int _cached_path_set = 0;                   /* sys.path initialised? */
static char _last_entry_module[256] = {0};
static int _last_entry_len = -1;
static PyObject *_cached_argv_list = NULL;     /* reusable list [pymode._handler, entry] */

__attribute__((export_name("pymode_warm_run")))
int pymode_warm_run(const char *entry_module, int entry_len) {
    if (!_pymode_initialized) return -1;

    /* First-call setup: cache module + function refs, set sys.path. */
    if (!_cached_sys) {
        _cached_sys = PyImport_ImportModule("sys");
        PyObject *handler_mod = PyImport_ImportModule("pymode._handler");
        if (handler_mod) {
            _cached_handler_run = PyObject_GetAttrString(handler_mod, "_run");
            Py_DECREF(handler_mod);
        }
        _cached_argv_handler_str = PyUnicode_FromString("pymode._handler");
    }
    if (!_cached_sys || !_cached_handler_run) return -2;

    /* sys.path: only rebuild on first call. PYTHONPATH doesn't change
     * across requests for the same DO instance, so the cached path is
     * fine after the initial setup. */
    if (!_cached_path_set) {
        const char *pythonpath = getenv("PYTHONPATH");
        if (pythonpath) {
            PyObject *path_list = PyObject_GetAttrString(_cached_sys, "path");
            if (path_list && PyList_Check(path_list)) {
                PyList_SetSlice(path_list, 0, PyList_Size(path_list), NULL);
                const char *start = pythonpath;
                while (*start) {
                    const char *end = strchr(start, ':');
                    if (!end) end = start + strlen(start);
                    PyObject *entry = PyUnicode_FromStringAndSize(start, end - start);
                    if (entry) { PyList_Append(path_list, entry); Py_DECREF(entry); }
                    start = (*end) ? end + 1 : end;
                }
                Py_DECREF(path_list);
            }
        }
        _cached_path_set = 1;
    }

    /* sys.argv: only rebuild when the entry module name actually changed. */
    if (entry_len != _last_entry_len ||
        (entry_len > 0 && memcmp(entry_module, _last_entry_module, entry_len) != 0)) {
        Py_XDECREF(_cached_argv_list);
        _cached_argv_list = PyList_New(0);
        Py_INCREF(_cached_argv_handler_str);
        PyList_Append(_cached_argv_list, _cached_argv_handler_str);
        Py_DECREF(_cached_argv_handler_str);
        PyObject *entry_str = PyUnicode_FromStringAndSize(entry_module, entry_len);
        PyList_Append(_cached_argv_list, entry_str);
        Py_DECREF(entry_str);
        PyObject_SetAttrString(_cached_sys, "argv", _cached_argv_list);
        int copy_len = entry_len < (int)(sizeof(_last_entry_module) - 1) ? entry_len : (int)(sizeof(_last_entry_module) - 1);
        memcpy(_last_entry_module, entry_module, copy_len);
        _last_entry_module[copy_len] = 0;
        _last_entry_len = entry_len;
    }

    /* Direct function call — no PyRun_String compile, no runpy. */
    int exitcode = 0;
    PyObject *result = PyObject_CallNoArgs(_cached_handler_run);
    if (!result) { PyErr_Print(); exitcode = 1; }
    else { Py_DECREF(result); }

    /* Flush */
    PyObject *flush = PySys_GetObject("stdout");
    if (flush) {
        PyObject *r = PyObject_CallMethod(flush, "flush", NULL);
        if (r) Py_DECREF(r); else PyErr_Clear();
    }
    flush = PySys_GetObject("stderr");
    if (flush) {
        PyObject *r = PyObject_CallMethod(flush, "flush", NULL);
        if (r) Py_DECREF(r); else PyErr_Clear();
    }
    return exitcode;
}

/*
 * Phase 2: Run user code on the pre-initialized interpreter.
 * Called at request time. If Wizer was used, the interpreter is already warm.
 * If Wizer was NOT used, falls back to full init + run via Py_BytesMain.
 *
 * User code is read from stdin (piped by the WASI shim from the VFS).
 * Alternatively, if argc > 2 and argv contains "-c", the code arg is used.
 */
int main(int argc, char **argv) {
    if (!_pymode_initialized) {
        /* No Wizer snapshot — fall back to normal CPython startup */
        return Py_BytesMain(argc, argv);
    }

    /* Interpreter is warm from the snapshot.
     * Set up sys.path from PYTHONPATH env var (the WASI shim provides this). */
    const char *pythonpath = getenv("PYTHONPATH");
    if (pythonpath) {
        PyObject *sys_mod = PyImport_ImportModule("sys");
        if (sys_mod) {
            PyObject *path_list = PyObject_GetAttrString(sys_mod, "path");
            if (path_list && PyList_Check(path_list)) {
                /* Clear and repopulate sys.path from PYTHONPATH */
                PyList_SetSlice(path_list, 0, PyList_Size(path_list), NULL);
                /* Parse colon-separated PYTHONPATH */
                const char *start = pythonpath;
                while (*start) {
                    const char *end = strchr(start, ':');
                    if (!end) end = start + strlen(start);
                    PyObject *entry = PyUnicode_FromStringAndSize(start, end - start);
                    if (entry) {
                        PyList_Append(path_list, entry);
                        Py_DECREF(entry);
                    }
                    start = (*end) ? end + 1 : end;
                }
                Py_DECREF(path_list);
            }
            Py_DECREF(sys_mod);
        }
    }

    /* Find the code to execute from argv: python -c "code" or python script.py */
    const char *code = NULL;
    const char *script = NULL;
    const char *module = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-c") == 0 && i + 1 < argc) {
            code = argv[i + 1];
            break;
        }
        if (strcmp(argv[i], "-m") == 0 && i + 1 < argc) {
            module = argv[i + 1];
            break;
        }
        if (strcmp(argv[i], "-S") == 0 || strcmp(argv[i], "-") == 0) {
            continue;
        }
        /* First non-flag argument is a script path */
        if (argv[i][0] != '-') {
            script = argv[i];
            break;
        }
    }

    int exitcode = 0;

    if (module) {
        /* Execute module: python -m pymode._handler entry_module */
        char run_module_code[4096];
        /* Collect remaining args after -m module_name */
        int mod_arg_idx = -1;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "-m") == 0 && i + 1 < argc) {
                mod_arg_idx = i + 2;
                break;
            }
        }
        /* Set sys.argv so the module can read its arguments */
        PyObject *sys_mod = PyImport_ImportModule("sys");
        if (sys_mod) {
            PyObject *argv_list = PyList_New(0);
            PyObject *mod_str = PyUnicode_FromString(module);
            PyList_Append(argv_list, mod_str);
            Py_DECREF(mod_str);
            if (mod_arg_idx >= 0) {
                for (int i = mod_arg_idx; i < argc; i++) {
                    PyObject *arg = PyUnicode_FromString(argv[i]);
                    PyList_Append(argv_list, arg);
                    Py_DECREF(arg);
                }
            }
            PyObject_SetAttrString(sys_mod, "argv", argv_list);
            Py_DECREF(argv_list);
            Py_DECREF(sys_mod);
        }
        snprintf(run_module_code, sizeof(run_module_code),
            "import runpy; runpy.run_module('%s', run_name='__main__')", module);
        PyObject *result = PyRun_String(run_module_code, Py_file_input,
                                         _pymode_globals, _pymode_locals);
        if (!result) {
            PyErr_Print();
            exitcode = 1;
        } else {
            Py_DECREF(result);
        }
    } else if (code) {
        /* Execute inline code: python -c "print('hello')" */
        PyObject *result = PyRun_String(code, Py_file_input,
                                         _pymode_globals, _pymode_locals);
        if (!result) {
            PyErr_Print();
            exitcode = 1;
        } else {
            Py_DECREF(result);
        }
    } else if (script) {
        /* Execute script file */
        FILE *fp = fopen(script, "r");
        if (!fp) {
            fprintf(stderr, "Error: cannot open '%s'\n", script);
            exitcode = 2;
        } else {
            /* Set __file__ for the script */
            PyObject *filename = PyUnicode_DecodeFSDefault(script);
            if (filename) {
                PyDict_SetItemString(_pymode_globals, "__file__", filename);
                Py_DECREF(filename);
            }
            PyObject *result = PyRun_FileEx(fp, script, Py_file_input,
                                             _pymode_globals, _pymode_locals, 1);
            if (!result) {
                PyErr_Print();
                exitcode = 1;
            } else {
                Py_DECREF(result);
            }
        }
    } else {
        /* Read from stdin */
        PyObject *result = PyRun_FileEx(stdin, "<stdin>", Py_file_input,
                                         _pymode_globals, _pymode_locals, 0);
        if (!result) {
            PyErr_Print();
            exitcode = 1;
        } else {
            Py_DECREF(result);
        }
    }

    /* Flush stdout/stderr */
    PyObject *flush_fn = PySys_GetObject("stdout");
    if (flush_fn) {
        PyObject *r = PyObject_CallMethod(flush_fn, "flush", NULL);
        if (r) Py_DECREF(r);
        else PyErr_Clear();
    }
    flush_fn = PySys_GetObject("stderr");
    if (flush_fn) {
        PyObject *r = PyObject_CallMethod(flush_fn, "flush", NULL);
        if (r) Py_DECREF(r);
        else PyErr_Clear();
    }

    return exitcode;
}
