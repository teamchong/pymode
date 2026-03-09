/* setjmp/longjmp for wasm32-wasi.
 *
 * WASM doesn't support native stack unwinding. setjmp saves nothing
 * (the jmp_buf is unused) and always returns 0. longjmp terminates
 * the process via abort() since there is no stack frame to restore.
 *
 * libjpeg and libpng call longjmp only on fatal decode errors
 * (corrupt data). Normal encode/decode paths never trigger it.
 */

#include <stdlib.h>

typedef long jmp_buf[5];

int setjmp(jmp_buf env) {
    (void)env;
    return 0;
}

void longjmp(jmp_buf env, int val) {
    (void)env;
    (void)val;
    abort();
}
