"""SIMD-accelerated batch operations for columnar numeric data.

Uses WASM SIMD v128 instructions via the _simd native extension.
Operates directly on array.array buffers — zero copy.

Usage:
    import array
    from pymode.simd import sum_f64, dot_f64, scale_f64, minmax_f64

    a = array.array('d', [1.0, 2.0, 3.0, 4.0])
    b = array.array('d', [5.0, 6.0, 7.0, 8.0])

    total = sum_f64(a)           # 10.0
    product = dot_f64(a, b)      # 70.0
    scale_f64(a, 2.0)            # a is now [2.0, 4.0, 6.0, 8.0]
    lo, hi = minmax_f64(b)       # (5.0, 8.0)
"""

import _simd

sum_f64 = _simd.sum_f64
sum_i32 = _simd.sum_i32
scale_f64 = _simd.scale_f64
dot_f64 = _simd.dot_f64
add_f64 = _simd.add_f64
minmax_f64 = _simd.minmax_f64
