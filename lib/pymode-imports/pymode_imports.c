/*
 * pymode_imports.c — Thin C wrappers exposing WASM host imports to Python.
 *
 * Since _ctypes is disabled in our WASI build (py_cv_module__ctypes=n/a),
 * we expose the host imports as a built-in CPython extension module (_pymode).
 * Python code calls: import _pymode; _pymode.tcp_connect("host", 5432)
 *
 * Build: Compile as an object file and link into python.wasm.
 *        The pymode.* WASM imports resolve at instantiation time.
 *
 * zig cc -target wasm32-wasi -c pymode_imports.c -I$CPYTHON_DIR/Include \
 *     -I$BUILD_DIR -Wl,--allow-undefined
 */

#include "Python.h"
#include "pymode_imports.h"

/* --- TCP wrappers --- */

static PyObject* py_tcp_connect(PyObject* self, PyObject* args) {
    const char* host;
    Py_ssize_t host_len;
    int port;
    if (!PyArg_ParseTuple(args, "s#i", &host, &host_len, &port))
        return NULL;
    int32_t conn_id = pymode_tcp_connect(host, (int32_t)host_len, port);
    if (conn_id < 0) {
        PyErr_SetString(PyExc_OSError, "tcp_connect failed");
        return NULL;
    }
    return PyLong_FromLong(conn_id);
}

static PyObject* py_tcp_send(PyObject* self, PyObject* args) {
    int conn_id;
    const uint8_t* data;
    Py_ssize_t data_len;
    if (!PyArg_ParseTuple(args, "iy#", &conn_id, &data, &data_len))
        return NULL;
    int32_t sent = pymode_tcp_send(conn_id, data, (int32_t)data_len);
    if (sent < 0) {
        PyErr_SetString(PyExc_OSError, "tcp_send failed");
        return NULL;
    }
    return PyLong_FromLong(sent);
}

static PyObject* py_tcp_recv(PyObject* self, PyObject* args) {
    int conn_id, bufsize;
    if (!PyArg_ParseTuple(args, "ii", &conn_id, &bufsize))
        return NULL;
    if (bufsize <= 0) bufsize = 65536;
    uint8_t* buf = (uint8_t*)PyMem_Malloc(bufsize);
    if (!buf)
        return PyErr_NoMemory();
    int32_t n = pymode_tcp_recv(conn_id, buf, bufsize);
    if (n < 0) {
        PyMem_Free(buf);
        PyErr_SetString(PyExc_OSError, "tcp_recv failed");
        return NULL;
    }
    PyObject* result = PyBytes_FromStringAndSize((const char*)buf, n);
    PyMem_Free(buf);
    return result;
}

static PyObject* py_tcp_close(PyObject* self, PyObject* args) {
    int conn_id;
    if (!PyArg_ParseTuple(args, "i", &conn_id))
        return NULL;
    pymode_tcp_close(conn_id);
    Py_RETURN_NONE;
}

/* --- HTTP wrappers --- */

static PyObject* py_http_fetch(PyObject* self, PyObject* args) {
    const char *url, *method, *headers_json;
    Py_ssize_t url_len, method_len, headers_len;
    const uint8_t* body;
    Py_ssize_t body_len;
    if (!PyArg_ParseTuple(args, "s#s#y#s#",
            &url, &url_len, &method, &method_len,
            &body, &body_len, &headers_json, &headers_len))
        return NULL;
    int32_t resp_id = pymode_http_fetch(
        url, (int32_t)url_len, method, (int32_t)method_len,
        body, (int32_t)body_len, headers_json, (int32_t)headers_len);
    if (resp_id < 0) {
        PyErr_SetString(PyExc_OSError, "http_fetch failed");
        return NULL;
    }
    return PyLong_FromLong(resp_id);
}

static PyObject* py_http_response_status(PyObject* self, PyObject* args) {
    int resp_id;
    if (!PyArg_ParseTuple(args, "i", &resp_id))
        return NULL;
    return PyLong_FromLong(pymode_http_response_status(resp_id));
}

static PyObject* py_http_response_read(PyObject* self, PyObject* args) {
    int resp_id, bufsize;
    if (!PyArg_ParseTuple(args, "ii", &resp_id, &bufsize))
        return NULL;
    if (bufsize <= 0) bufsize = 65536;
    uint8_t* buf = (uint8_t*)PyMem_Malloc(bufsize);
    if (!buf)
        return PyErr_NoMemory();
    int32_t n = pymode_http_response_read(resp_id, buf, bufsize);
    PyObject* result = PyBytes_FromStringAndSize((const char*)buf, n < 0 ? 0 : n);
    PyMem_Free(buf);
    return result;
}

static PyObject* py_http_response_header(PyObject* self, PyObject* args) {
    int resp_id;
    const char* name;
    Py_ssize_t name_len;
    if (!PyArg_ParseTuple(args, "is#", &resp_id, &name, &name_len))
        return NULL;
    char buf[8192];
    int32_t n = pymode_http_response_header(resp_id, name, (int32_t)name_len, buf, sizeof(buf));
    if (n < 0)
        Py_RETURN_NONE;
    return PyUnicode_FromStringAndSize(buf, n);
}

/* --- KV wrappers --- */

static PyObject* py_kv_get(PyObject* self, PyObject* args) {
    const char* key;
    Py_ssize_t key_len;
    int bufsize = 1024 * 1024;
    if (!PyArg_ParseTuple(args, "s#|i", &key, &key_len, &bufsize))
        return NULL;
    uint8_t* buf = (uint8_t*)PyMem_Malloc(bufsize);
    if (!buf)
        return PyErr_NoMemory();
    int32_t n = pymode_kv_get(key, (int32_t)key_len, buf, bufsize);
    if (n < 0) {
        PyMem_Free(buf);
        Py_RETURN_NONE;
    }
    PyObject* result = PyBytes_FromStringAndSize((const char*)buf, n);
    PyMem_Free(buf);
    return result;
}

static PyObject* py_kv_put(PyObject* self, PyObject* args) {
    const char* key;
    Py_ssize_t key_len;
    const uint8_t* val;
    Py_ssize_t val_len;
    if (!PyArg_ParseTuple(args, "s#y#", &key, &key_len, &val, &val_len))
        return NULL;
    pymode_kv_put(key, (int32_t)key_len, val, (int32_t)val_len);
    Py_RETURN_NONE;
}

static PyObject* py_kv_delete(PyObject* self, PyObject* args) {
    const char* key;
    Py_ssize_t key_len;
    if (!PyArg_ParseTuple(args, "s#", &key, &key_len))
        return NULL;
    pymode_kv_delete(key, (int32_t)key_len);
    Py_RETURN_NONE;
}

/* --- R2 wrappers --- */

static PyObject* py_r2_get(PyObject* self, PyObject* args) {
    const char* key;
    Py_ssize_t key_len;
    int bufsize = 10 * 1024 * 1024;
    if (!PyArg_ParseTuple(args, "s#|i", &key, &key_len, &bufsize))
        return NULL;
    uint8_t* buf = (uint8_t*)PyMem_Malloc(bufsize);
    if (!buf)
        return PyErr_NoMemory();
    int32_t n = pymode_r2_get(key, (int32_t)key_len, buf, bufsize);
    if (n < 0) {
        PyMem_Free(buf);
        Py_RETURN_NONE;
    }
    PyObject* result = PyBytes_FromStringAndSize((const char*)buf, n);
    PyMem_Free(buf);
    return result;
}

static PyObject* py_r2_put(PyObject* self, PyObject* args) {
    const char* key;
    Py_ssize_t key_len;
    const uint8_t* val;
    Py_ssize_t val_len;
    if (!PyArg_ParseTuple(args, "s#y#", &key, &key_len, &val, &val_len))
        return NULL;
    pymode_r2_put(key, (int32_t)key_len, val, (int32_t)val_len);
    Py_RETURN_NONE;
}

/* --- D1 wrapper --- */

static PyObject* py_d1_exec(PyObject* self, PyObject* args) {
    const char *sql, *params_json;
    Py_ssize_t sql_len, params_len;
    if (!PyArg_ParseTuple(args, "s#s#", &sql, &sql_len, &params_json, &params_len))
        return NULL;
    char* buf = (char*)PyMem_Malloc(10 * 1024 * 1024);
    if (!buf)
        return PyErr_NoMemory();
    int32_t n = pymode_d1_exec(sql, (int32_t)sql_len,
        params_json, (int32_t)params_len, buf, 10 * 1024 * 1024);
    if (n < 0) {
        PyMem_Free(buf);
        PyErr_SetString(PyExc_RuntimeError, "d1_exec failed");
        return NULL;
    }
    PyObject* result = PyUnicode_FromStringAndSize(buf, n);
    PyMem_Free(buf);
    return result;
}

/* --- Environment wrapper --- */

static PyObject* py_env_get(PyObject* self, PyObject* args) {
    const char* key;
    Py_ssize_t key_len;
    if (!PyArg_ParseTuple(args, "s#", &key, &key_len))
        return NULL;
    char buf[8192];
    int32_t n = pymode_env_get(key, (int32_t)key_len, buf, sizeof(buf));
    if (n < 0)
        Py_RETURN_NONE;
    return PyUnicode_FromStringAndSize(buf, n);
}

/* --- Thread wrappers --- */

static PyObject* py_thread_spawn(PyObject* self, PyObject* args) {
    const char* code;
    Py_ssize_t code_len;
    const uint8_t* input;
    Py_ssize_t input_len;
    if (!PyArg_ParseTuple(args, "s#y#", &code, &code_len, &input, &input_len))
        return NULL;
    int32_t thread_id = pymode_thread_spawn(code, (int32_t)code_len, input, (int32_t)input_len);
    if (thread_id < 0) {
        PyErr_SetString(PyExc_RuntimeError, "thread_spawn failed");
        return NULL;
    }
    return PyLong_FromLong(thread_id);
}

static PyObject* py_thread_join(PyObject* self, PyObject* args) {
    int thread_id;
    int bufsize = 10 * 1024 * 1024;
    if (!PyArg_ParseTuple(args, "i|i", &thread_id, &bufsize))
        return NULL;
    uint8_t* buf = (uint8_t*)PyMem_Malloc(bufsize);
    if (!buf)
        return PyErr_NoMemory();
    int32_t n = pymode_thread_join(thread_id, buf, bufsize);
    if (n < 0) {
        PyMem_Free(buf);
        PyErr_SetString(PyExc_RuntimeError, "thread_join failed");
        return NULL;
    }
    PyObject* result = PyBytes_FromStringAndSize((const char*)buf, n);
    PyMem_Free(buf);
    return result;
}

/* --- Console wrapper --- */

static PyObject* py_console_log(PyObject* self, PyObject* args) {
    const char* msg;
    Py_ssize_t msg_len;
    if (!PyArg_ParseTuple(args, "s#", &msg, &msg_len))
        return NULL;
    pymode_console_log(msg, (int32_t)msg_len);
    Py_RETURN_NONE;
}

/* --- Module definition --- */

static PyMethodDef pymode_methods[] = {
    {"tcp_connect", py_tcp_connect, METH_VARARGS, NULL},
    {"tcp_send", py_tcp_send, METH_VARARGS, NULL},
    {"tcp_recv", py_tcp_recv, METH_VARARGS, NULL},
    {"tcp_close", py_tcp_close, METH_VARARGS, NULL},
    {"http_fetch", py_http_fetch, METH_VARARGS, NULL},
    {"http_response_status", py_http_response_status, METH_VARARGS, NULL},
    {"http_response_read", py_http_response_read, METH_VARARGS, NULL},
    {"http_response_header", py_http_response_header, METH_VARARGS, NULL},
    {"kv_get", py_kv_get, METH_VARARGS, NULL},
    {"kv_put", py_kv_put, METH_VARARGS, NULL},
    {"kv_delete", py_kv_delete, METH_VARARGS, NULL},
    {"r2_get", py_r2_get, METH_VARARGS, NULL},
    {"r2_put", py_r2_put, METH_VARARGS, NULL},
    {"d1_exec", py_d1_exec, METH_VARARGS, NULL},
    {"env_get", py_env_get, METH_VARARGS, NULL},
    {"thread_spawn", py_thread_spawn, METH_VARARGS, NULL},
    {"thread_join", py_thread_join, METH_VARARGS, NULL},
    {"console_log", py_console_log, METH_VARARGS, NULL},
    {NULL, NULL, 0, NULL}
};

static struct PyModuleDef pymode_module = {
    PyModuleDef_HEAD_INIT,
    "_pymode",
    "Host imports for PyMode (WASM ↔ JS bridge)",
    -1,
    pymode_methods
};

PyMODINIT_FUNC PyInit__pymode(void) {
    return PyModule_Create(&pymode_module);
}
