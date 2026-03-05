/*
 * Single-threaded pthread for wasm32-wasi.
 *
 * WASI has no thread support. Packages like numpy call pthread_create at
 * startup for thread pools. This provides the POSIX pthread API with
 * single-threaded semantics: pthread_create runs the function inline on
 * the calling thread, mutexes are no-ops, etc.
 *
 * Compile: zig cc -target wasm32-wasi -c -Os pthread.c -o pthread.o
 * Link:    add pthread.o to the final python.wasm link step
 */

#include <stdlib.h>
#include <string.h>
#include <errno.h>

/* Type definitions matching POSIX pthread types */
typedef unsigned long pthread_t;
typedef int pthread_attr_t;
typedef int pthread_mutex_t;
typedef int pthread_mutexattr_t;
typedef int pthread_cond_t;
typedef int pthread_condattr_t;
typedef int pthread_rwlock_t;
typedef int pthread_rwlockattr_t;
typedef int pthread_once_t;
typedef int pthread_key_t;

#define PTHREAD_MUTEX_INITIALIZER 0
#define PTHREAD_COND_INITIALIZER 0
#define PTHREAD_RWLOCK_INITIALIZER 0
#define PTHREAD_ONCE_INIT 0

/* Thread ID counter */
static pthread_t next_thread_id = 1;

/* TLS: simple fixed-size key-value store */
#define MAX_TLS_KEYS 128
static void *tls_values[MAX_TLS_KEYS];
static void (*tls_destructors[MAX_TLS_KEYS])(void *);
static int tls_used[MAX_TLS_KEYS];
static int next_tls_key = 0;

/* Thread creation: run the function inline (single-threaded) */
int pthread_create(pthread_t *thread, const pthread_attr_t *attr,
                   void *(*start_routine)(void *), void *arg) {
    (void)attr;
    *thread = next_thread_id++;
    start_routine(arg);
    return 0;
}

int pthread_join(pthread_t thread, void **retval) {
    (void)thread;
    if (retval) *retval = NULL;
    return 0;
}

int pthread_detach(pthread_t thread) {
    (void)thread;
    return 0;
}

pthread_t pthread_self(void) {
    return 1;  /* main thread */
}

int pthread_equal(pthread_t t1, pthread_t t2) {
    return t1 == t2;
}

/* Attributes */
int pthread_attr_init(pthread_attr_t *attr) { (void)attr; return 0; }
int pthread_attr_destroy(pthread_attr_t *attr) { (void)attr; return 0; }
int pthread_attr_setdetachstate(pthread_attr_t *attr, int state) { (void)attr; (void)state; return 0; }
int pthread_attr_getdetachstate(const pthread_attr_t *attr, int *state) { (void)attr; if (state) *state = 0; return 0; }
int pthread_attr_setstacksize(pthread_attr_t *attr, size_t size) { (void)attr; (void)size; return 0; }
int pthread_attr_getstacksize(const pthread_attr_t *attr, size_t *size) { (void)attr; if (size) *size = 65536; return 0; }

/* Mutex: no-ops (single-threaded, no contention possible) */
int pthread_mutex_init(pthread_mutex_t *mutex, const pthread_mutexattr_t *attr) { (void)attr; if (mutex) *mutex = 0; return 0; }
int pthread_mutex_destroy(pthread_mutex_t *mutex) { (void)mutex; return 0; }
int pthread_mutex_lock(pthread_mutex_t *mutex) { (void)mutex; return 0; }
int pthread_mutex_trylock(pthread_mutex_t *mutex) { (void)mutex; return 0; }
int pthread_mutex_unlock(pthread_mutex_t *mutex) { (void)mutex; return 0; }

/* Mutex attributes */
int pthread_mutexattr_init(pthread_mutexattr_t *attr) { (void)attr; return 0; }
int pthread_mutexattr_destroy(pthread_mutexattr_t *attr) { (void)attr; return 0; }
int pthread_mutexattr_settype(pthread_mutexattr_t *attr, int type) { (void)attr; (void)type; return 0; }
int pthread_mutexattr_gettype(const pthread_mutexattr_t *attr, int *type) { (void)attr; if (type) *type = 0; return 0; }

/* Condition variables: signal/wait are no-ops (single-threaded) */
int pthread_cond_init(pthread_cond_t *cond, const pthread_condattr_t *attr) { (void)attr; if (cond) *cond = 0; return 0; }
int pthread_cond_destroy(pthread_cond_t *cond) { (void)cond; return 0; }
int pthread_cond_signal(pthread_cond_t *cond) { (void)cond; return 0; }
int pthread_cond_broadcast(pthread_cond_t *cond) { (void)cond; return 0; }
int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex) { (void)cond; (void)mutex; return 0; }

/* RWLock: no-ops */
int pthread_rwlock_init(pthread_rwlock_t *rwlock, const pthread_rwlockattr_t *attr) { (void)attr; if (rwlock) *rwlock = 0; return 0; }
int pthread_rwlock_destroy(pthread_rwlock_t *rwlock) { (void)rwlock; return 0; }
int pthread_rwlock_rdlock(pthread_rwlock_t *rwlock) { (void)rwlock; return 0; }
int pthread_rwlock_wrlock(pthread_rwlock_t *rwlock) { (void)rwlock; return 0; }
int pthread_rwlock_tryrdlock(pthread_rwlock_t *rwlock) { (void)rwlock; return 0; }
int pthread_rwlock_trywrlock(pthread_rwlock_t *rwlock) { (void)rwlock; return 0; }
int pthread_rwlock_unlock(pthread_rwlock_t *rwlock) { (void)rwlock; return 0; }

/* Once */
int pthread_once(pthread_once_t *once_control, void (*init_routine)(void)) {
    if (once_control && *once_control == 0) {
        *once_control = 1;
        init_routine();
    }
    return 0;
}

/* Thread-local storage */
int pthread_key_create(pthread_key_t *key, void (*destructor)(void *)) {
    if (next_tls_key >= MAX_TLS_KEYS) return EAGAIN;
    int k = next_tls_key++;
    tls_used[k] = 1;
    tls_destructors[k] = destructor;
    tls_values[k] = NULL;
    *key = k;
    return 0;
}

int pthread_key_delete(pthread_key_t key) {
    if (key < 0 || key >= MAX_TLS_KEYS || !tls_used[key]) return EINVAL;
    tls_used[key] = 0;
    tls_destructors[key] = NULL;
    tls_values[key] = NULL;
    return 0;
}

void *pthread_getspecific(pthread_key_t key) {
    if (key < 0 || key >= MAX_TLS_KEYS) return NULL;
    return tls_values[key];
}

int pthread_setspecific(pthread_key_t key, const void *value) {
    if (key < 0 || key >= MAX_TLS_KEYS || !tls_used[key]) return EINVAL;
    tls_values[key] = (void *)value;
    return 0;
}

/* Cancel: not supported */
int pthread_cancel(pthread_t thread) { (void)thread; return ENOSYS; }
int pthread_setcancelstate(int state, int *oldstate) { (void)state; if (oldstate) *oldstate = 0; return 0; }
int pthread_setcanceltype(int type, int *oldtype) { (void)type; if (oldtype) *oldtype = 0; return 0; }
void pthread_testcancel(void) {}
