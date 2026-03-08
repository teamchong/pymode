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

    /* Set PYTHONPATH to the stdlib location in the WASI VFS */
    PyStatus status;
    status = PyConfig_SetBytesString(&config, &config.pythonpath_env, "/stdlib");
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
    _preimport("_wasi_compat");

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

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-c") == 0 && i + 1 < argc) {
            code = argv[i + 1];
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

    if (code) {
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
