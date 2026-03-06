/*
 * dynload_pymode.c — Dynamic loading shim for PyMode WASM.
 *
 * Replaces CPython's dynload_shlib.c for wasm32-wasi builds.
 * Instead of calling dlopen/dlsym (which don't exist in WASI),
 * routes through WASM host imports that the JS host (PythonDO)
 * implements by loading pre-compiled .wasm side modules.
 *
 * Flow:
 *   Python: import markupsafe._speedups
 *     → CPython: _PyImport_FindSharedFuncptr("PyInit", "_speedups", path)
 *       → This file: pymode_dl_open(path) → JS loads .wasm module
 *       → This file: pymode_dl_sym(handle, "PyInit__speedups") → JS resolves export
 *       → Returns function pointer via WASM indirect call table
 *     → CPython: calls PyInit__speedups() → module initialized
 *
 * Build:
 *   zig cc -target wasm32-wasi -c dynload_pymode.c \
 *       -I$CPYTHON_DIR/Include -I$BUILD_DIR -Wl,--allow-undefined
 */

#include "Python.h"
#include "pycore_importdl.h"

#include <stdint.h>
#include <string.h>

/* WASM host imports for dynamic loading.
 * Implemented by PythonDO (JS) in worker/src/python-do.ts.
 *
 * pymode_dl_open: Load a .wasm side module by path.
 *   Returns a handle ID >= 0, or -1 if module not found.
 *
 * pymode_dl_sym: Resolve a symbol (function) in a loaded module.
 *   Returns a function pointer (wasm table index), or 0 if not found.
 *
 * pymode_dl_close: Release a loaded module handle.
 *
 * pymode_dl_error: Get last error message into buffer.
 *   Returns bytes written, or 0 if no error.
 */
__attribute__((import_module("pymode"), import_name("dl_open")))
int32_t pymode_dl_open(const char* path, int32_t path_len);

__attribute__((import_module("pymode"), import_name("dl_sym")))
void* pymode_dl_sym(int32_t handle, const char* symbol, int32_t symbol_len);

__attribute__((import_module("pymode"), import_name("dl_close")))
void pymode_dl_close(int32_t handle);

__attribute__((import_module("pymode"), import_name("dl_error")))
int32_t pymode_dl_error(char* buf, int32_t buf_len);


/* File extension table — tells CPython what extensions to look for.
 * On WASI/pymode, C extensions are compiled to .wasm files. */
const char *_PyImport_DynLoadFiletab[] = {
    ".wasm",
    ".so",       /* Fallback for compatibility */
    NULL
};


/* Main entry point called by CPython's importdl.c.
 *
 * prefix:    "PyInit" or "PyInitU" (for non-ASCII module names)
 * shortname: Module short name (e.g., "_speedups")
 * pathname:  Full path to the .so/.wasm file
 * fp:        File pointer (unused, may be NULL)
 *
 * Returns: function pointer to PyInit_<name>, or NULL on error.
 */
dl_funcptr
_PyImport_FindSharedFuncptr(const char *prefix,
                            const char *shortname,
                            const char *pathname,
                            FILE *fp)
{
    char funcname[258];
    int32_t handle;
    void *sym;

    /* Construct the init function name: "PyInit__speedups" */
    PyOS_snprintf(funcname, sizeof(funcname),
                  "%.20s_%.200s", prefix, shortname);

    /* Call host import to load the module */
    handle = pymode_dl_open(pathname, (int32_t)strlen(pathname));
    if (handle < 0) {
        /* Module not found — get error message from host */
        char errbuf[512];
        int32_t errlen = pymode_dl_error(errbuf, sizeof(errbuf));
        const char *error = errlen > 0 ? errbuf : "module not found";

        PyObject *error_obj = PyUnicode_FromString(error);
        PyObject *path_obj = PyUnicode_FromString(pathname);
        PyObject *name_obj = PyUnicode_FromString(shortname);
        if (error_obj && path_obj && name_obj) {
            PyErr_SetImportError(error_obj, name_obj, path_obj);
        }
        Py_XDECREF(error_obj);
        Py_XDECREF(path_obj);
        Py_XDECREF(name_obj);
        return NULL;
    }

    /* Resolve the init function symbol */
    sym = pymode_dl_sym(handle, funcname, (int32_t)strlen(funcname));
    if (sym == NULL) {
        char errbuf[512];
        PyOS_snprintf(errbuf, sizeof(errbuf),
                      "symbol '%s' not found in '%s'", funcname, pathname);
        PyObject *error_obj = PyUnicode_FromString(errbuf);
        PyObject *path_obj = PyUnicode_FromString(pathname);
        PyObject *name_obj = PyUnicode_FromString(shortname);
        if (error_obj && path_obj && name_obj) {
            PyErr_SetImportError(error_obj, name_obj, path_obj);
        }
        Py_XDECREF(error_obj);
        Py_XDECREF(path_obj);
        Py_XDECREF(name_obj);
        return NULL;
    }

    return (dl_funcptr)sym;
}
