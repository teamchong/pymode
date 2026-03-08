// Zig CPython extension for xxhash — wraps the real xxhash C library.
//
// xxhash.c is compiled separately (avoids @cImport inline translation issues
// on wasm32-wasi). This file uses extern declarations for the C functions.
// State structs are heap-allocated via XXH*_createState() — no struct size
// assumptions needed.
//
// Exports PyInit__xxhash so CPython loads it as _xxhash native extension.

const std = @import("std");
const py = @cImport({
    @cInclude("Python.h");
});

fn py_none() ?*py.PyObject {
    const none: *py.PyObject = py.Py_None();
    py.Py_INCREF(none);
    return none;
}

fn alloc_obj() ?*XXHashObject {
    const obj_mem = allocator.alignedAlloc(u8, .fromByteUnits(@alignOf(XXHashObject)), @sizeOf(XXHashObject)) catch return null;
    return @ptrCast(@alignCast(obj_mem.ptr));
}

fn free_obj(obj: *XXHashObject) void {
    const ptr: [*]align(@alignOf(XXHashObject)) u8 = @ptrCast(obj);
    allocator.free(ptr[0..@sizeOf(XXHashObject)]);
}

// ============================================================================
// EXTERN DECLARATIONS — xxhash C library (linked from xxhash.c)
// ============================================================================

const XXH_errorcode = enum(c_int) { XXH_OK = 0, XXH_ERROR = 1 };
const XXH128_hash_t = extern struct { low64: u64, high64: u64 };

// Opaque state types — allocated/freed by xxhash C library
const XXH32_state_t = opaque {};
const XXH64_state_t = opaque {};
const XXH3_state_t = opaque {};

extern fn XXH32_createState() ?*XXH32_state_t;
extern fn XXH32_freeState(state: *XXH32_state_t) XXH_errorcode;
extern fn XXH32_reset(state: *XXH32_state_t, seed: u32) XXH_errorcode;
extern fn XXH32_update(state: *XXH32_state_t, input: ?*const anyopaque, length: usize) XXH_errorcode;
extern fn XXH32_digest(state: *const XXH32_state_t) u32;
extern fn XXH32_copyState(dst: *XXH32_state_t, src: *const XXH32_state_t) void;

extern fn XXH64_createState() ?*XXH64_state_t;
extern fn XXH64_freeState(state: *XXH64_state_t) XXH_errorcode;
extern fn XXH64_reset(state: *XXH64_state_t, seed: u64) XXH_errorcode;
extern fn XXH64_update(state: *XXH64_state_t, input: ?*const anyopaque, length: usize) XXH_errorcode;
extern fn XXH64_digest(state: *const XXH64_state_t) u64;
extern fn XXH64_copyState(dst: *XXH64_state_t, src: *const XXH64_state_t) void;

extern fn XXH3_createState() ?*XXH3_state_t;
extern fn XXH3_freeState(state: *XXH3_state_t) XXH_errorcode;
extern fn XXH3_64bits_reset_withSeed(state: *XXH3_state_t, seed: u64) XXH_errorcode;
extern fn XXH3_64bits_update(state: *XXH3_state_t, input: ?*const anyopaque, length: usize) XXH_errorcode;
extern fn XXH3_64bits_digest(state: *const XXH3_state_t) u64;
extern fn XXH3_128bits_digest(state: *const XXH3_state_t) XXH128_hash_t;
extern fn XXH3_copyState(dst: *XXH3_state_t, src: *const XXH3_state_t) void;

const allocator = std.heap.c_allocator;

// ============================================================================
// HASH OBJECT — stores opaque pointers to C-allocated state
// ============================================================================

const HashVariant = enum(u8) { xxh32, xxh64, xxh3_64, xxh3_128 };

const XXHashObject = struct {
    ob_base: py.PyObject,
    variant: HashVariant,
    seed: u64,
    s32: ?*XXH32_state_t,
    s64: ?*XXH64_state_t,
    s3: ?*XXH3_state_t,
};

fn extract_buffer(obj: ?*py.PyObject) ?struct { ptr: [*]const u8, len: usize, buf: py.Py_buffer } {
    var buf: py.Py_buffer = undefined;
    if (py.PyObject_GetBuffer(obj, &buf, py.PyBUF_SIMPLE) != 0) return null;
    return .{
        .ptr = @as([*]const u8, @ptrCast(buf.buf)),
        .len = @intCast(buf.len),
        .buf = buf,
    };
}

// ============================================================================
// FORWARD DECLARATIONS for type objects
// ============================================================================

var xxh32_type: py.PyTypeObject = undefined;
var xxh64_type: py.PyTypeObject = undefined;
var xxh3_64_type: py.PyTypeObject = undefined;
var xxh3_128_type: py.PyTypeObject = undefined;

// ============================================================================
// OBJECT CREATION
// ============================================================================

fn xxhash_create(variant: HashVariant, args: ?*py.PyObject) ?*py.PyObject {
    var data_obj: ?*py.PyObject = null;
    var seed: c_ulonglong = 0;

    if (py.PyArg_ParseTuple(args, "|OK", &data_obj, &seed) == 0) return null;

    const obj = alloc_obj() orelse return null;

    obj.ob_base = .{
        .unnamed_0 = .{ .ob_refcnt = 1 },
        .ob_type = switch (variant) {
            .xxh32 => &xxh32_type,
            .xxh64 => &xxh64_type,
            .xxh3_64 => &xxh3_64_type,
            .xxh3_128 => &xxh3_128_type,
        },
    };
    obj.variant = variant;
    obj.seed = seed;
    obj.s32 = null;
    obj.s64 = null;
    obj.s3 = null;

    switch (variant) {
        .xxh32 => {
            obj.s32 = XXH32_createState() orelse {
                free_obj(obj);
                return null;
            };
            _ = XXH32_reset(obj.s32.?, @truncate(seed));
        },
        .xxh64 => {
            obj.s64 = XXH64_createState() orelse {
                free_obj(obj);
                return null;
            };
            _ = XXH64_reset(obj.s64.?, seed);
        },
        .xxh3_64, .xxh3_128 => {
            obj.s3 = XXH3_createState() orelse {
                free_obj(obj);
                return null;
            };
            _ = XXH3_64bits_reset_withSeed(obj.s3.?, seed);
        },
    }

    if (data_obj) |d| {
        if (d != @as(?*py.PyObject, py.Py_None())) {
            const info = extract_buffer(d) orelse {
                xxhash_free_state(obj);
                free_obj(obj);
                return null;
            };
            switch (variant) {
                .xxh32 => _ = XXH32_update(obj.s32.?, info.ptr, info.len),
                .xxh64 => _ = XXH64_update(obj.s64.?, info.ptr, info.len),
                .xxh3_64, .xxh3_128 => _ = XXH3_64bits_update(obj.s3.?, info.ptr, info.len),
            }
            var buf_copy = info.buf;
            py.PyBuffer_Release(&buf_copy);
        }
    }

    return @ptrCast(obj);
}

fn xxhash_free_state(obj: *XXHashObject) void {
    if (obj.s32) |s| _ = XXH32_freeState(s);
    if (obj.s64) |s| _ = XXH64_freeState(s);
    if (obj.s3) |s| _ = XXH3_freeState(s);
}

// ============================================================================
// METHODS
// ============================================================================

fn xxhash_update(self_raw: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));
    var data_obj: ?*py.PyObject = null;
    if (py.PyArg_ParseTuple(args, "O", &data_obj) == 0) return null;

    const info = extract_buffer(data_obj) orelse return null;

    switch (self.variant) {
        .xxh32 => _ = XXH32_update(self.s32.?, info.ptr, info.len),
        .xxh64 => _ = XXH64_update(self.s64.?, info.ptr, info.len),
        .xxh3_64, .xxh3_128 => _ = XXH3_64bits_update(self.s3.?, info.ptr, info.len),
    }

    var buf_copy = info.buf;
    py.PyBuffer_Release(&buf_copy);

    return py_none();
}

fn xxhash_intdigest(self_raw: ?*py.PyObject, _: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));

    switch (self.variant) {
        .xxh32 => return py.PyLong_FromUnsignedLong(XXH32_digest(self.s32.?)),
        .xxh64 => return py.PyLong_FromUnsignedLongLong(XXH64_digest(self.s64.?)),
        .xxh3_64 => return py.PyLong_FromUnsignedLongLong(XXH3_64bits_digest(self.s3.?)),
        .xxh3_128 => {
            const h = XXH3_128bits_digest(self.s3.?);
            const low = py.PyLong_FromUnsignedLongLong(h.low64);
            const high = py.PyLong_FromUnsignedLongLong(h.high64);
            if (low == null or high == null) {
                if (low) |l| py.Py_DECREF(l);
                if (high) |hi| py.Py_DECREF(hi);
                return null;
            }
            const shift = py.PyLong_FromLong(64);
            const high_shifted = py.PyNumber_Lshift(high, shift);
            py.Py_DECREF(shift);
            py.Py_DECREF(high);
            if (high_shifted == null) {
                py.Py_DECREF(low);
                return null;
            }
            const result = py.PyNumber_Or(high_shifted, low);
            py.Py_DECREF(high_shifted);
            py.Py_DECREF(low);
            return result;
        },
    }
}

fn format_hex_u32(h: u32) [8]u8 {
    const hex = "0123456789abcdef";
    var buf: [8]u8 = undefined;
    inline for (0..8) |i| {
        buf[i] = hex[@as(usize, (h >> @intCast((7 - i) * 4)) & 0xF)];
    }
    return buf;
}

fn format_hex_u64(h: u64) [16]u8 {
    const hex = "0123456789abcdef";
    var buf: [16]u8 = undefined;
    inline for (0..16) |i| {
        buf[i] = hex[@as(usize, @truncate((h >> @intCast((15 - i) * 4)) & 0xF))];
    }
    return buf;
}

fn xxhash_digest(self_raw: ?*py.PyObject, _: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));

    switch (self.variant) {
        .xxh32 => {
            const bytes = std.mem.toBytes(std.mem.nativeToBig(u32, XXH32_digest(self.s32.?)));
            return py.PyBytes_FromStringAndSize(&bytes, 4);
        },
        .xxh64 => {
            const bytes = std.mem.toBytes(std.mem.nativeToBig(u64, XXH64_digest(self.s64.?)));
            return py.PyBytes_FromStringAndSize(&bytes, 8);
        },
        .xxh3_64 => {
            const bytes = std.mem.toBytes(std.mem.nativeToBig(u64, XXH3_64bits_digest(self.s3.?)));
            return py.PyBytes_FromStringAndSize(&bytes, 8);
        },
        .xxh3_128 => {
            const h = XXH3_128bits_digest(self.s3.?);
            var bytes: [16]u8 = undefined;
            @memcpy(bytes[0..8], &std.mem.toBytes(std.mem.nativeToBig(u64, h.high64)));
            @memcpy(bytes[8..16], &std.mem.toBytes(std.mem.nativeToBig(u64, h.low64)));
            return py.PyBytes_FromStringAndSize(&bytes, 16);
        },
    }
}

fn xxhash_hexdigest(self_raw: ?*py.PyObject, _: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));

    switch (self.variant) {
        .xxh32 => {
            const buf = format_hex_u32(XXH32_digest(self.s32.?));
            return py.PyUnicode_FromStringAndSize(&buf, 8);
        },
        .xxh64 => {
            const buf = format_hex_u64(XXH64_digest(self.s64.?));
            return py.PyUnicode_FromStringAndSize(&buf, 16);
        },
        .xxh3_64 => {
            const buf = format_hex_u64(XXH3_64bits_digest(self.s3.?));
            return py.PyUnicode_FromStringAndSize(&buf, 16);
        },
        .xxh3_128 => {
            const h = XXH3_128bits_digest(self.s3.?);
            const hi_buf = format_hex_u64(h.high64);
            const lo_buf = format_hex_u64(h.low64);
            var buf: [32]u8 = undefined;
            @memcpy(buf[0..16], &hi_buf);
            @memcpy(buf[16..32], &lo_buf);
            return py.PyUnicode_FromStringAndSize(&buf, 32);
        },
    }
}

fn xxhash_copy(self_raw: ?*py.PyObject, _: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));

    const copy = alloc_obj() orelse return null;

    copy.ob_base = self.ob_base;
    copy.ob_base.unnamed_0.ob_refcnt = 1;
    copy.variant = self.variant;
    copy.seed = self.seed;
    copy.s32 = null;
    copy.s64 = null;
    copy.s3 = null;

    switch (self.variant) {
        .xxh32 => {
            copy.s32 = XXH32_createState() orelse {
                free_obj(copy);
                return null;
            };
            XXH32_copyState(copy.s32.?, self.s32.?);
        },
        .xxh64 => {
            copy.s64 = XXH64_createState() orelse {
                free_obj(copy);
                return null;
            };
            XXH64_copyState(copy.s64.?, self.s64.?);
        },
        .xxh3_64, .xxh3_128 => {
            copy.s3 = XXH3_createState() orelse {
                free_obj(copy);
                return null;
            };
            XXH3_copyState(copy.s3.?, self.s3.?);
        },
    }

    return @ptrCast(copy);
}

fn xxhash_reset(self_raw: ?*py.PyObject, _: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));
    switch (self.variant) {
        .xxh32 => _ = XXH32_reset(self.s32.?, @truncate(self.seed)),
        .xxh64 => _ = XXH64_reset(self.s64.?, self.seed),
        .xxh3_64, .xxh3_128 => _ = XXH3_64bits_reset_withSeed(self.s3.?, self.seed),
    }
    return py_none();
}

// ============================================================================
// PROPERTIES
// ============================================================================

fn xxhash_get_seed(self_raw: ?*py.PyObject, _: ?*anyopaque) callconv(.c) ?*py.PyObject {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));
    return py.PyLong_FromUnsignedLongLong(self.seed);
}

fn xxhash_get_block_size(self_raw: ?*py.PyObject, _: ?*anyopaque) callconv(.c) ?*py.PyObject {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));
    return switch (self.variant) {
        .xxh32 => py.PyLong_FromLong(16),
        .xxh64 => py.PyLong_FromLong(32),
        .xxh3_64, .xxh3_128 => py.PyLong_FromLong(64),
    };
}

fn xxhash_get_digest_size(self_raw: ?*py.PyObject, _: ?*anyopaque) callconv(.c) ?*py.PyObject {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));
    return switch (self.variant) {
        .xxh32 => py.PyLong_FromLong(4),
        .xxh64, .xxh3_64 => py.PyLong_FromLong(8),
        .xxh3_128 => py.PyLong_FromLong(16),
    };
}

fn xxhash_get_name(self_raw: ?*py.PyObject, _: ?*anyopaque) callconv(.c) ?*py.PyObject {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));
    return switch (self.variant) {
        .xxh32 => py.PyUnicode_FromString("XXH32"),
        .xxh64 => py.PyUnicode_FromString("XXH64"),
        .xxh3_64 => py.PyUnicode_FromString("XXH3_64bits"),
        .xxh3_128 => py.PyUnicode_FromString("XXH3_128bits"),
    };
}

fn xxhash_dealloc(self_raw: ?*py.PyObject) callconv(.c) void {
    const self: *XXHashObject = @ptrCast(@alignCast(self_raw));
    xxhash_free_state(self);
    free_obj(self);
}

// ============================================================================
// METHOD AND GETSET TABLES
// ============================================================================

var xxhash_methods = [_]py.PyMethodDef{
    .{ .ml_name = "update", .ml_meth = @ptrCast(&xxhash_update), .ml_flags = py.METH_VARARGS, .ml_doc = "Update the hash with data." },
    .{ .ml_name = "digest", .ml_meth = @ptrCast(&xxhash_digest), .ml_flags = py.METH_NOARGS, .ml_doc = "Return the hash as bytes." },
    .{ .ml_name = "hexdigest", .ml_meth = @ptrCast(&xxhash_hexdigest), .ml_flags = py.METH_NOARGS, .ml_doc = "Return the hash as hex string." },
    .{ .ml_name = "intdigest", .ml_meth = @ptrCast(&xxhash_intdigest), .ml_flags = py.METH_NOARGS, .ml_doc = "Return the hash as integer." },
    .{ .ml_name = "copy", .ml_meth = @ptrCast(&xxhash_copy), .ml_flags = py.METH_NOARGS, .ml_doc = "Copy the hash object." },
    .{ .ml_name = "reset", .ml_meth = @ptrCast(&xxhash_reset), .ml_flags = py.METH_NOARGS, .ml_doc = "Reset the hash object." },
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var xxhash_getset = [_]py.PyGetSetDef{
    .{ .name = "seed", .get = @ptrCast(&xxhash_get_seed), .set = null, .doc = "The seed value.", .closure = null },
    .{ .name = "block_size", .get = @ptrCast(&xxhash_get_block_size), .set = null, .doc = "Block size.", .closure = null },
    .{ .name = "digest_size", .get = @ptrCast(&xxhash_get_digest_size), .set = null, .doc = "Digest size.", .closure = null },
    .{ .name = "name", .get = @ptrCast(&xxhash_get_name), .set = null, .doc = "Algorithm name.", .closure = null },
    .{ .name = null, .get = null, .set = null, .doc = null, .closure = null },
};

// ============================================================================
// TYPE OBJECTS
// ============================================================================

fn init_type(name: [*:0]const u8) py.PyTypeObject {
    var t: py.PyTypeObject = std.mem.zeroes(py.PyTypeObject);
    t.tp_name = name;
    t.tp_basicsize = @sizeOf(XXHashObject);
    t.tp_flags = py.Py_TPFLAGS_DEFAULT;
    t.tp_methods = @constCast(&xxhash_methods);
    t.tp_getset = @constCast(&xxhash_getset);
    t.tp_dealloc = @ptrCast(&xxhash_dealloc);
    return t;
}

// ============================================================================
// ONE-SHOT CONVENIENCE FUNCTIONS
// ============================================================================

fn one_shot(comptime variant: HashVariant, comptime output: enum { digest, hexdigest, intdigest }) fn (?*py.PyObject, ?*py.PyObject) callconv(.c) ?*py.PyObject {
    return struct {
        fn call(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
            var data_obj: ?*py.PyObject = null;
            var seed: c_ulonglong = 0;
            if (py.PyArg_ParseTuple(args, "O|K", &data_obj, &seed) == 0) return null;

            const info = extract_buffer(data_obj) orelse return null;

            // Create temporary hash object with heap-allocated state
            var obj: XXHashObject = undefined;
            obj.variant = variant;
            obj.seed = seed;
            obj.s32 = null;
            obj.s64 = null;
            obj.s3 = null;

            switch (variant) {
                .xxh32 => {
                    obj.s32 = XXH32_createState() orelse return null;
                    _ = XXH32_reset(obj.s32.?, @truncate(seed));
                    _ = XXH32_update(obj.s32.?, info.ptr, info.len);
                },
                .xxh64 => {
                    obj.s64 = XXH64_createState() orelse return null;
                    _ = XXH64_reset(obj.s64.?, seed);
                    _ = XXH64_update(obj.s64.?, info.ptr, info.len);
                },
                .xxh3_64, .xxh3_128 => {
                    obj.s3 = XXH3_createState() orelse return null;
                    _ = XXH3_64bits_reset_withSeed(obj.s3.?, seed);
                    _ = XXH3_64bits_update(obj.s3.?, info.ptr, info.len);
                },
            }

            var buf_copy = info.buf;
            py.PyBuffer_Release(&buf_copy);

            const self_ptr: *py.PyObject = @ptrCast(&obj);
            const result = switch (output) {
                .digest => xxhash_digest(self_ptr, null),
                .hexdigest => xxhash_hexdigest(self_ptr, null),
                .intdigest => xxhash_intdigest(self_ptr, null),
            };

            xxhash_free_state(&obj);
            return result;
        }
    }.call;
}

// ============================================================================
// MODULE DEFINITION
// ============================================================================

var module_methods = [_]py.PyMethodDef{
    .{ .ml_name = "xxh32_digest", .ml_meth = @ptrCast(&one_shot(.xxh32, .digest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh32_hexdigest", .ml_meth = @ptrCast(&one_shot(.xxh32, .hexdigest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh32_intdigest", .ml_meth = @ptrCast(&one_shot(.xxh32, .intdigest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh64_digest", .ml_meth = @ptrCast(&one_shot(.xxh64, .digest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh64_hexdigest", .ml_meth = @ptrCast(&one_shot(.xxh64, .hexdigest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh64_intdigest", .ml_meth = @ptrCast(&one_shot(.xxh64, .intdigest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh128_digest", .ml_meth = @ptrCast(&one_shot(.xxh3_128, .digest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh128_hexdigest", .ml_meth = @ptrCast(&one_shot(.xxh3_128, .hexdigest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh128_intdigest", .ml_meth = @ptrCast(&one_shot(.xxh3_128, .intdigest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh3_64_digest", .ml_meth = @ptrCast(&one_shot(.xxh3_64, .digest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh3_64_hexdigest", .ml_meth = @ptrCast(&one_shot(.xxh3_64, .hexdigest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh3_64_intdigest", .ml_meth = @ptrCast(&one_shot(.xxh3_64, .intdigest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh3_128_digest", .ml_meth = @ptrCast(&one_shot(.xxh3_128, .digest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh3_128_hexdigest", .ml_meth = @ptrCast(&one_shot(.xxh3_128, .hexdigest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = "xxh3_128_intdigest", .ml_meth = @ptrCast(&one_shot(.xxh3_128, .intdigest)), .ml_flags = py.METH_VARARGS, .ml_doc = null },
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var module_def = py.PyModuleDef{
    .m_base = std.mem.zeroes(py.PyModuleDef_Base),
    .m_name = "_xxhash",
    .m_doc = "xxhash native WASM extension using xxhash C library via zig cc",
    .m_size = -1,
    .m_methods = @constCast(&module_methods),
    .m_slots = null,
    .m_traverse = null,
    .m_clear = null,
    .m_free = null,
};

fn xxh32_new(_: ?*py.PyObject, args: ?*py.PyObject, _: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    return xxhash_create(.xxh32, args);
}
fn xxh64_new(_: ?*py.PyObject, args: ?*py.PyObject, _: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    return xxhash_create(.xxh64, args);
}
fn xxh3_64_new(_: ?*py.PyObject, args: ?*py.PyObject, _: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    return xxhash_create(.xxh3_64, args);
}
fn xxh3_128_new(_: ?*py.PyObject, args: ?*py.PyObject, _: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    return xxhash_create(.xxh3_128, args);
}

export fn PyInit__xxhash() ?*py.PyObject {
    xxh32_type = init_type("_xxhash.xxh32");
    xxh64_type = init_type("_xxhash.xxh64");
    xxh3_64_type = init_type("_xxhash.xxh3_64");
    xxh3_128_type = init_type("_xxhash.xxh3_128");

    xxh32_type.tp_new = @ptrCast(&xxh32_new);
    xxh64_type.tp_new = @ptrCast(&xxh64_new);
    xxh3_64_type.tp_new = @ptrCast(&xxh3_64_new);
    xxh3_128_type.tp_new = @ptrCast(&xxh3_128_new);

    if (py.PyType_Ready(&xxh32_type) < 0) return null;
    if (py.PyType_Ready(&xxh64_type) < 0) return null;
    if (py.PyType_Ready(&xxh3_64_type) < 0) return null;
    if (py.PyType_Ready(&xxh3_128_type) < 0) return null;

    const module = py.PyModule_Create(&module_def);
    if (module == null) return null;

    py.Py_INCREF(@ptrCast(&xxh32_type));
    _ = py.PyModule_AddObject(module, "xxh32", @ptrCast(&xxh32_type));

    py.Py_INCREF(@ptrCast(&xxh64_type));
    _ = py.PyModule_AddObject(module, "xxh64", @ptrCast(&xxh64_type));

    py.Py_INCREF(@ptrCast(&xxh3_64_type));
    _ = py.PyModule_AddObject(module, "xxh3_64", @ptrCast(&xxh3_64_type));

    py.Py_INCREF(@ptrCast(&xxh3_128_type));
    _ = py.PyModule_AddObject(module, "xxh3_128", @ptrCast(&xxh3_128_type));

    // xxh128 is an alias for xxh3_128
    py.Py_INCREF(@ptrCast(&xxh3_128_type));
    _ = py.PyModule_AddObject(module, "xxh128", @ptrCast(&xxh3_128_type));

    _ = py.PyModule_AddStringConstant(module, "XXHASH_VERSION", "0.8.2");

    return module;
}
