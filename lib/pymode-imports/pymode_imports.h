/*
 * pymode_imports.h — WASM host imports provided by PythonDO.
 *
 * These functions are imported from the "pymode" WASM namespace at
 * instantiation time. The JS host (PythonDO) provides the implementation.
 *
 * Build: zig cc -target wasm32-wasi -Wl,--allow-undefined
 * The linker leaves these as unresolved imports, satisfied by JS at runtime.
 */

#ifndef PYMODE_IMPORTS_H
#define PYMODE_IMPORTS_H

#include <stdint.h>

/* --- TCP --- */

/* Connect to host:port. Returns a connection ID >= 0, or -1 on error. */
__attribute__((import_module("pymode"), import_name("tcp_connect")))
int32_t pymode_tcp_connect(const char* host, int32_t host_len, int32_t port);

/* Send data on a connection. Returns bytes sent, or -1 on error. */
__attribute__((import_module("pymode"), import_name("tcp_send")))
int32_t pymode_tcp_send(int32_t conn_id, const uint8_t* data, int32_t len);

/* Receive data from a connection into buf. Returns bytes read, 0 on EOF, -1 on error.
 * This is an async host import — with JSPI it suspends the WASM stack.
 * Without JSPI, the host uses the in-process trampoline. */
__attribute__((import_module("pymode"), import_name("tcp_recv")))
int32_t pymode_tcp_recv(int32_t conn_id, uint8_t* buf, int32_t buf_len);

/* Close a TCP connection. */
__attribute__((import_module("pymode"), import_name("tcp_close")))
void pymode_tcp_close(int32_t conn_id);

/* --- HTTP --- */

/* Start a fetch request. Returns a response ID >= 0, or -1 on error.
 * headers_json is a JSON-encoded object of header key-value pairs.
 * Async — suspends with JSPI or triggers trampoline. */
__attribute__((import_module("pymode"), import_name("http_fetch")))
int32_t pymode_http_fetch(
    const char* url, int32_t url_len,
    const char* method, int32_t method_len,
    const uint8_t* body, int32_t body_len,
    const char* headers_json, int32_t headers_len);

/* Get the HTTP status code of a completed response. */
__attribute__((import_module("pymode"), import_name("http_response_status")))
int32_t pymode_http_response_status(int32_t response_id);

/* Read response body bytes into buf. Returns bytes read, 0 when exhausted. */
__attribute__((import_module("pymode"), import_name("http_response_read")))
int32_t pymode_http_response_read(int32_t response_id, uint8_t* buf, int32_t buf_len);

/* Read a response header value into buf. Returns bytes written, -1 if not found. */
__attribute__((import_module("pymode"), import_name("http_response_header")))
int32_t pymode_http_response_header(
    int32_t response_id,
    const char* name, int32_t name_len,
    char* buf, int32_t buf_len);

/* --- KV --- */

/* Get a KV value. Returns bytes read into buf, -1 if key not found. Async. */
__attribute__((import_module("pymode"), import_name("kv_get")))
int32_t pymode_kv_get(const char* key, int32_t key_len, uint8_t* buf, int32_t buf_len);

/* Put a KV value. Async. */
__attribute__((import_module("pymode"), import_name("kv_put")))
void pymode_kv_put(const char* key, int32_t key_len, const uint8_t* val, int32_t val_len);

/* Delete a KV key. Async. */
__attribute__((import_module("pymode"), import_name("kv_delete")))
void pymode_kv_delete(const char* key, int32_t key_len);

/* --- R2 --- */

__attribute__((import_module("pymode"), import_name("r2_get")))
int32_t pymode_r2_get(const char* key, int32_t key_len, uint8_t* buf, int32_t buf_len);

__attribute__((import_module("pymode"), import_name("r2_put")))
void pymode_r2_put(const char* key, int32_t key_len, const uint8_t* val, int32_t val_len);

/* --- D1 (SQL) --- */

/* Execute SQL. params_json is JSON array. Result JSON written to result_buf.
 * Returns bytes written, -1 on error. Async. */
__attribute__((import_module("pymode"), import_name("d1_exec")))
int32_t pymode_d1_exec(
    const char* sql, int32_t sql_len,
    const char* params_json, int32_t params_len,
    char* result_buf, int32_t result_buf_len);

/* --- Environment --- */

/* Read an environment variable / CF binding value. Returns bytes written, -1 if not found. */
__attribute__((import_module("pymode"), import_name("env_get")))
int32_t pymode_env_get(const char* key, int32_t key_len, char* buf, int32_t buf_len);

/* --- Threading (child DOs) --- */

/* Spawn a child DO to execute Python code in parallel.
 * code: Python source to execute in the child
 * input: serialized (pickled) input data
 * Returns a thread handle >= 0, or -1 on error. Async. */
__attribute__((import_module("pymode"), import_name("thread_spawn")))
int32_t pymode_thread_spawn(
    const char* code, int32_t code_len,
    const uint8_t* input, int32_t input_len);

/* Join a spawned thread. Blocks until the child completes.
 * Writes the serialized result into buf.
 * Returns bytes written, -1 on error. Async. */
__attribute__((import_module("pymode"), import_name("thread_join")))
int32_t pymode_thread_join(int32_t thread_id, uint8_t* buf, int32_t buf_len);

/* --- Logging --- */

__attribute__((import_module("pymode"), import_name("console_log")))
void pymode_console_log(const char* msg, int32_t msg_len);

#endif /* PYMODE_IMPORTS_H */
