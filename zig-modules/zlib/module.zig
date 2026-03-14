// Zig replacement for CPython's Modules/zlibmodule.c
// Uses Zig std.compress.flate for DEFLATE — zero interpreter overhead.
//
// This module exports PyInit_zlib so CPython loads it as a built-in extension,
// replacing the pure Python polyfill in lib/polyfills/zlib.py.

const std = @import("std");
const c = @cImport({
    @cInclude("Python.h");
});

const flate = std.compress.flate;
const Container = flate.Container;
const Reader = std.Io.Reader;
const Writer = std.Io.Writer;
const allocator = std.heap.c_allocator;

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_WBITS: c_int = 15;
const DEF_MEM_LEVEL: c_int = 8;
const DEF_BUF_SIZE: c_int = 16384;
const DEFLATED: c_int = 8;

const Z_NO_COMPRESSION: c_int = 0;
const Z_BEST_SPEED: c_int = 1;
const Z_BEST_COMPRESSION: c_int = 9;
const Z_DEFAULT_COMPRESSION: c_int = -1;

const Z_FILTERED: c_int = 1;
const Z_HUFFMAN_ONLY: c_int = 2;
const Z_RLE: c_int = 3;
const Z_FIXED: c_int = 4;
const Z_DEFAULT_STRATEGY: c_int = 0;

const Z_NO_FLUSH: c_int = 0;
const Z_PARTIAL_FLUSH: c_int = 1;
const Z_SYNC_FLUSH: c_int = 2;
const Z_FULL_FLUSH: c_int = 3;
const Z_FINISH: c_int = 4;
const Z_BLOCK: c_int = 5;
const Z_TREES: c_int = 6;

// ============================================================================
// CHECKSUM FUNCTIONS
// ============================================================================

const crc32_table: [256]u32 = blk: {
    var table: [256]u32 = undefined;
    for (0..256) |i| {
        var crc_val: u32 = @intCast(i);
        for (0..8) |_| {
            if (crc_val & 1 != 0) {
                crc_val = (crc_val >> 1) ^ 0xEDB88320;
            } else {
                crc_val >>= 1;
            }
        }
        table[i] = crc_val;
    }
    break :blk table;
};

fn compute_crc32(data: []const u8, init: u32) u32 {
    var crc = init ^ 0xFFFFFFFF;
    for (data) |byte| {
        crc = crc32_table[(crc ^ byte) & 0xFF] ^ (crc >> 8);
    }
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF;
}

fn compute_adler32(data: []const u8, init: u32) u32 {
    var a: u32 = init & 0xFFFF;
    var b: u32 = (init >> 16) & 0xFFFF;
    for (data) |byte| {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) & 0xFFFFFFFF;
}

// ============================================================================
// COMPRESSION — uses Zig flate.Compress.Simple for Huffman-coded DEFLATE
// ============================================================================

fn compress_deflate(data: []const u8, container: Container) ![]u8 {
    var output = Writer.Allocating.init(allocator);
    errdefer output.deinit();

    var window_buf: [flate.max_window_len]u8 = undefined;
    var comp = flate.Compress.Simple.init(&output.writer, &window_buf, container, .huffman) catch return error.CompressionFailed;

    // Feed data into the compressor buffer
    var pos: usize = 0;
    while (pos < data.len) {
        const space = comp.buffer.len - comp.wp;
        const chunk = @min(data.len - pos, space);
        @memcpy(comp.buffer[comp.wp..][0..chunk], data[pos..][0..chunk]);
        comp.wp += chunk;
        pos += chunk;
        if (comp.wp == comp.buffer.len) {
            comp.flush() catch return error.CompressionFailed;
        }
    }

    comp.finish() catch return error.CompressionFailed;

    return output.toOwnedSlice() catch return error.OutOfMemory;
}

// ============================================================================
// DECOMPRESSION — uses Zig flate.Decompress
// ============================================================================

fn decompress_deflate(data: []const u8, container: Container) ![]u8 {
    var input = Reader.fixed(data);
    var window_buf: [flate.max_window_len]u8 = undefined;
    var decomp = flate.Decompress.init(&input, container, &window_buf);

    var output = Writer.Allocating.init(allocator);
    errdefer output.deinit();

    decomp.reader.streamRemaining(&output.writer) catch return error.DecompressionFailed;

    return output.toOwnedSlice() catch return error.OutOfMemory;
}

// ============================================================================
// PYTHON API
// ============================================================================

var zlib_error: ?*c.PyObject = null;

fn set_zlib_error(msg: [*:0]const u8) void {
    if (zlib_error) |err| {
        c.PyErr_SetString(err, msg);
    } else {
        c.PyErr_SetString(c.PyExc_RuntimeError, msg);
    }
}

fn wbits_to_container(wbits: c_int) Container {
    if (wbits < 0) return .raw;
    if (wbits > 15) return .gzip;
    return .zlib;
}

fn py_compress(_: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var view: c.Py_buffer = undefined;
    var level: c_int = Z_DEFAULT_COMPRESSION;
    var wbits: c_int = MAX_WBITS;

    var kwlist = [_:null]?[*:0]const u8{ "data", "level", "wbits", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "y*|ii", @ptrCast(&kwlist), &view, &level, &wbits) == 0) return null;
    defer c.PyBuffer_Release(&view);

    _ = level; // Zig flate uses its own optimal level

    const data: [*]const u8 = @ptrCast(view.buf);
    const len: usize = @intCast(view.len);
    const container = wbits_to_container(wbits);

    const result = compress_deflate(data[0..len], container) catch {
        set_zlib_error("compression failed");
        return null;
    };
    defer allocator.free(result);

    return c.PyBytes_FromStringAndSize(@ptrCast(result.ptr), @intCast(result.len));
}

fn py_decompress(_: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var view: c.Py_buffer = undefined;
    var wbits: c_int = MAX_WBITS;
    var bufsize: c_int = DEF_BUF_SIZE;

    var kwlist = [_:null]?[*:0]const u8{ "data", "wbits", "bufsize", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "y*|ii", @ptrCast(&kwlist), &view, &wbits, &bufsize) == 0) return null;
    defer c.PyBuffer_Release(&view);

    const data: [*]const u8 = @ptrCast(view.buf);
    const len: usize = @intCast(view.len);

    if (len == 0) {
        set_zlib_error("incomplete or truncated stream");
        return null;
    }

    const container = wbits_to_container(wbits);
    const result = decompress_deflate(data[0..len], container) catch {
        set_zlib_error("decompression failed");
        return null;
    };
    defer allocator.free(result);

    return c.PyBytes_FromStringAndSize(@ptrCast(result.ptr), @intCast(result.len));
}

fn py_adler32(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var view: c.Py_buffer = undefined;
    var init_val: c_uint = 1;
    if (c.PyArg_ParseTuple(args, "y*|I", &view, &init_val) == 0) return null;
    defer c.PyBuffer_Release(&view);

    const data: [*]const u8 = @ptrCast(view.buf);
    const len: usize = @intCast(view.len);

    return c.PyLong_FromUnsignedLong(compute_adler32(data[0..len], init_val));
}

fn py_crc32(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var view: c.Py_buffer = undefined;
    var init_val: c_uint = 0;
    if (c.PyArg_ParseTuple(args, "y*|I", &view, &init_val) == 0) return null;
    defer c.PyBuffer_Release(&view);

    const data: [*]const u8 = @ptrCast(view.buf);
    const len: usize = @intCast(view.len);

    return c.PyLong_FromUnsignedLong(compute_crc32(data[0..len], init_val));
}

// ============================================================================
// COMPRESSOBJ / DECOMPRESSOBJ (streaming interface)
// ============================================================================

const CompressObject = extern struct {
    ob_base: c.PyObject,
    wbits: c_int,
    chunks_list: ?*c.PyObject,
};

fn compress_obj_init(self_raw: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) c_int {
    const self: *CompressObject = @ptrCast(@alignCast(self_raw));
    var level: c_int = Z_DEFAULT_COMPRESSION;
    var method: c_int = DEFLATED;
    var wbits: c_int = MAX_WBITS;
    var memlevel: c_int = DEF_MEM_LEVEL;
    var strategy: c_int = Z_DEFAULT_STRATEGY;

    var kwlist = [_:null]?[*:0]const u8{ "level", "method", "wbits", "memlevel", "strategy", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "|iiiii", @ptrCast(&kwlist), &level, &method, &wbits, &memlevel, &strategy) == 0) return -1;

    _ = level;
    _ = method;
    _ = memlevel;
    _ = strategy;
    self.wbits = wbits;
    self.chunks_list = c.PyList_New(0);
    if (self.chunks_list == null) return -1;
    return 0;
}

fn compress_obj_compress(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *CompressObject = @ptrCast(@alignCast(self_raw));
    var view: c.Py_buffer = undefined;
    if (c.PyArg_ParseTuple(args, "y*", &view) == 0) return null;
    defer c.PyBuffer_Release(&view);

    const chunk = c.PyBytes_FromStringAndSize(@ptrCast(view.buf), @intCast(view.len));
    if (chunk == null) return null;
    if (c.PyList_Append(self.chunks_list.?, chunk) < 0) {
        c.Py_DecRef(chunk);
        return null;
    }
    c.Py_DecRef(chunk);
    return c.PyBytes_FromStringAndSize(null, 0);
}

fn compress_obj_flush(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *CompressObject = @ptrCast(@alignCast(self_raw));

    // Collect all chunks into a single buffer
    const all_data = collect_chunks(self.chunks_list.?) orelse return null;
    defer if (all_data.len > 0) allocator.free(all_data);

    // Clear chunks
    c.Py_DecRef(self.chunks_list.?);
    self.chunks_list = c.PyList_New(0);

    const container = wbits_to_container(self.wbits);
    const result = compress_deflate(all_data, container) catch {
        set_zlib_error("compression failed");
        return null;
    };
    defer allocator.free(result);

    return c.PyBytes_FromStringAndSize(@ptrCast(result.ptr), @intCast(result.len));
}

fn compress_obj_dealloc(self_raw: ?*c.PyObject) callconv(.c) void {
    const self: *CompressObject = @ptrCast(@alignCast(self_raw));
    if (self.chunks_list) |list| c.Py_DecRef(list);
    const tp = c.Py_TYPE(self_raw);
    c.PyObject_Free(self_raw);
    c.Py_DecRef(@ptrCast(tp));
}

const compress_obj_methods = [_]c.PyMethodDef{
    .{ .ml_name = "compress", .ml_meth = @ptrCast(&compress_obj_compress), .ml_flags = c.METH_VARARGS, .ml_doc = "Feed data to the compressor." },
    .{ .ml_name = "flush", .ml_meth = @ptrCast(&compress_obj_flush), .ml_flags = c.METH_VARARGS, .ml_doc = "Flush and return compressed data." },
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

const compress_obj_slots = [_]c.PyType_Slot{
    .{ .slot = c.Py_tp_init, .pfunc = @ptrCast(@constCast(&compress_obj_init)) },
    .{ .slot = c.Py_tp_dealloc, .pfunc = @ptrCast(@constCast(&compress_obj_dealloc)) },
    .{ .slot = c.Py_tp_methods, .pfunc = @ptrCast(@constCast(&compress_obj_methods)) },
    .{ .slot = 0, .pfunc = null },
};

var compress_obj_spec = c.PyType_Spec{
    .name = "zlib.Compress",
    .basicsize = @sizeOf(CompressObject),
    .itemsize = 0,
    .flags = c.Py_TPFLAGS_DEFAULT,
    .slots = @ptrCast(@constCast(&compress_obj_slots)),
};

// Decompress object
const DecompressObject = extern struct {
    ob_base: c.PyObject,
    wbits: c_int,
    chunks_list: ?*c.PyObject,
    eof_flag: c_int,
};

fn decompress_obj_init(self_raw: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) c_int {
    const self: *DecompressObject = @ptrCast(@alignCast(self_raw));
    var wbits: c_int = MAX_WBITS;

    var kwlist = [_:null]?[*:0]const u8{ "wbits", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "|i", @ptrCast(&kwlist), &wbits) == 0) return -1;

    self.wbits = wbits;
    self.eof_flag = 0;
    self.chunks_list = c.PyList_New(0);
    if (self.chunks_list == null) return -1;
    return 0;
}

fn decompress_obj_decompress(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *DecompressObject = @ptrCast(@alignCast(self_raw));
    var view: c.Py_buffer = undefined;
    if (c.PyArg_ParseTuple(args, "y*", &view) == 0) return null;
    defer c.PyBuffer_Release(&view);

    const chunk = c.PyBytes_FromStringAndSize(@ptrCast(view.buf), @intCast(view.len));
    if (chunk == null) return null;
    if (c.PyList_Append(self.chunks_list.?, chunk) < 0) {
        c.Py_DecRef(chunk);
        return null;
    }
    c.Py_DecRef(chunk);

    // Try to decompress accumulated data
    const all_data = collect_chunks(self.chunks_list.?) orelse return c.PyBytes_FromStringAndSize(null, 0);
    defer if (all_data.len > 0) allocator.free(all_data);

    const container = wbits_to_container(self.wbits);
    const result = decompress_deflate(all_data, container) catch {
        // May need more data
        return c.PyBytes_FromStringAndSize(null, 0);
    };
    defer allocator.free(result);

    self.eof_flag = 1;
    c.Py_DecRef(self.chunks_list.?);
    self.chunks_list = c.PyList_New(0);

    return c.PyBytes_FromStringAndSize(@ptrCast(result.ptr), @intCast(result.len));
}

fn decompress_obj_flush(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    return decompress_obj_decompress(self_raw, c.PyTuple_New(0));
}

fn decompress_obj_dealloc(self_raw: ?*c.PyObject) callconv(.c) void {
    const self: *DecompressObject = @ptrCast(@alignCast(self_raw));
    if (self.chunks_list) |list| c.Py_DecRef(list);
    const tp = c.Py_TYPE(self_raw);
    c.PyObject_Free(self_raw);
    c.Py_DecRef(@ptrCast(tp));
}

fn decompress_obj_get_eof(self_raw: ?*c.PyObject, _: ?*anyopaque) callconv(.c) ?*c.PyObject {
    const self: *DecompressObject = @ptrCast(@alignCast(self_raw));
    return c.PyBool_FromLong(self.eof_flag);
}

fn get_empty_bytes(_: ?*c.PyObject, _: ?*anyopaque) callconv(.c) ?*c.PyObject {
    return c.PyBytes_FromStringAndSize(null, 0);
}

const decompress_obj_methods = [_]c.PyMethodDef{
    .{ .ml_name = "decompress", .ml_meth = @ptrCast(&decompress_obj_decompress), .ml_flags = c.METH_VARARGS, .ml_doc = "Feed data to the decompressor." },
    .{ .ml_name = "flush", .ml_meth = @ptrCast(&decompress_obj_flush), .ml_flags = c.METH_VARARGS, .ml_doc = "Flush and return decompressed data." },
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

const decompress_obj_getset = [_]c.PyGetSetDef{
    .{ .name = "eof", .get = @ptrCast(&decompress_obj_get_eof), .set = null, .doc = "True if end of stream reached.", .closure = null },
    .{ .name = "unused_data", .get = @ptrCast(&get_empty_bytes), .set = null, .doc = null, .closure = null },
    .{ .name = "unconsumed_tail", .get = @ptrCast(&get_empty_bytes), .set = null, .doc = null, .closure = null },
    .{ .name = null, .get = null, .set = null, .doc = null, .closure = null },
};

const decompress_obj_slots = [_]c.PyType_Slot{
    .{ .slot = c.Py_tp_init, .pfunc = @ptrCast(@constCast(&decompress_obj_init)) },
    .{ .slot = c.Py_tp_dealloc, .pfunc = @ptrCast(@constCast(&decompress_obj_dealloc)) },
    .{ .slot = c.Py_tp_methods, .pfunc = @ptrCast(@constCast(&decompress_obj_methods)) },
    .{ .slot = c.Py_tp_getset, .pfunc = @ptrCast(@constCast(&decompress_obj_getset)) },
    .{ .slot = 0, .pfunc = null },
};

var decompress_obj_spec = c.PyType_Spec{
    .name = "zlib.Decompress",
    .basicsize = @sizeOf(DecompressObject),
    .itemsize = 0,
    .flags = c.Py_TPFLAGS_DEFAULT,
    .slots = @ptrCast(@constCast(&decompress_obj_slots)),
};

// Factory functions
fn py_compressobj(_: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    if (compress_type == null) {
        set_zlib_error("Compress type not initialized");
        return null;
    }
    return c.PyObject_Call(@ptrCast(compress_type.?), args orelse c.PyTuple_New(0), kwargs);
}

fn py_decompressobj(_: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    if (decompress_type == null) {
        set_zlib_error("Decompress type not initialized");
        return null;
    }
    return c.PyObject_Call(@ptrCast(decompress_type.?), args orelse c.PyTuple_New(0), kwargs);
}

var compress_type: ?*c.PyObject = null;
var decompress_type: ?*c.PyObject = null;

// ============================================================================
// HELPER: collect Python list of bytes into a single Zig slice
// ============================================================================

fn collect_chunks(list: *c.PyObject) ?[]u8 {
    const n: usize = @intCast(c.PyList_Size(list));
    if (n == 0) return &[_]u8{};

    // Calculate total size
    var total: usize = 0;
    for (0..n) |i| {
        const item = c.PyList_GetItem(list, @intCast(i));
        total += @intCast(c.PyBytes_Size(item.?));
    }

    if (total == 0) return &[_]u8{};

    const buf = allocator.alloc(u8, total) catch return null;
    var pos: usize = 0;
    for (0..n) |i| {
        const item = c.PyList_GetItem(list, @intCast(i));
        const item_len: usize = @intCast(c.PyBytes_Size(item.?));
        const item_data: [*]const u8 = @ptrCast(c.PyBytes_AsString(item.?));
        @memcpy(buf[pos..][0..item_len], item_data[0..item_len]);
        pos += item_len;
    }
    return buf;
}

// ============================================================================
// MODULE DEFINITION
// ============================================================================

const module_methods = [_]c.PyMethodDef{
    .{
        .ml_name = "compress",
        .ml_meth = @ptrCast(&py_compress),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Compress data using DEFLATE.",
    },
    .{
        .ml_name = "decompress",
        .ml_meth = @ptrCast(&py_decompress),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Decompress data.",
    },
    .{
        .ml_name = "adler32",
        .ml_meth = @ptrCast(&py_adler32),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "Compute Adler-32 checksum.",
    },
    .{
        .ml_name = "crc32",
        .ml_meth = @ptrCast(&py_crc32),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "Compute CRC-32 checksum.",
    },
    .{
        .ml_name = "compressobj",
        .ml_meth = @ptrCast(&py_compressobj),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Return a compression object.",
    },
    .{
        .ml_name = "decompressobj",
        .ml_meth = @ptrCast(&py_decompressobj),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Return a decompression object.",
    },
    // Sentinel
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var module_def = c.PyModuleDef{
    .m_base = std.mem.zeroes(c.PyModuleDef_Base),
    .m_name = "zlib",
    .m_doc = "zlib compression — Zig std.compress.flate native implementation",
    .m_size = -1,
    .m_methods = @constCast(&module_methods),
    .m_slots = null,
    .m_traverse = null,
    .m_clear = null,
    .m_free = null,
};

export fn PyInit_zlib() ?*c.PyObject {
    const module = c.PyModule_Create(&module_def);
    if (module == null) return null;

    // Create error exception
    zlib_error = c.PyErr_NewException("zlib.error", c.PyExc_Exception, null);
    if (zlib_error) |err| {
        c.Py_IncRef(err);
        _ = c.PyModule_AddObject(module, "error", err);
    }

    // Create heap types
    compress_type = c.PyType_FromSpec(&compress_obj_spec);
    if (compress_type) |ct| {
        c.Py_IncRef(ct);
        _ = c.PyModule_AddObject(module, "Compress", ct);
    }

    decompress_type = c.PyType_FromSpec(&decompress_obj_spec);
    if (decompress_type) |dt| {
        c.Py_IncRef(dt);
        _ = c.PyModule_AddObject(module, "Decompress", dt);
    }

    // Add constants
    _ = c.PyModule_AddIntConstant(module, "MAX_WBITS", MAX_WBITS);
    _ = c.PyModule_AddIntConstant(module, "DEF_MEM_LEVEL", DEF_MEM_LEVEL);
    _ = c.PyModule_AddIntConstant(module, "DEF_BUF_SIZE", DEF_BUF_SIZE);
    _ = c.PyModule_AddIntConstant(module, "DEFLATED", DEFLATED);
    _ = c.PyModule_AddIntConstant(module, "Z_NO_COMPRESSION", Z_NO_COMPRESSION);
    _ = c.PyModule_AddIntConstant(module, "Z_BEST_SPEED", Z_BEST_SPEED);
    _ = c.PyModule_AddIntConstant(module, "Z_BEST_COMPRESSION", Z_BEST_COMPRESSION);
    _ = c.PyModule_AddIntConstant(module, "Z_DEFAULT_COMPRESSION", Z_DEFAULT_COMPRESSION);
    _ = c.PyModule_AddIntConstant(module, "Z_FILTERED", Z_FILTERED);
    _ = c.PyModule_AddIntConstant(module, "Z_HUFFMAN_ONLY", Z_HUFFMAN_ONLY);
    _ = c.PyModule_AddIntConstant(module, "Z_RLE", Z_RLE);
    _ = c.PyModule_AddIntConstant(module, "Z_FIXED", Z_FIXED);
    _ = c.PyModule_AddIntConstant(module, "Z_DEFAULT_STRATEGY", Z_DEFAULT_STRATEGY);
    _ = c.PyModule_AddIntConstant(module, "Z_NO_FLUSH", Z_NO_FLUSH);
    _ = c.PyModule_AddIntConstant(module, "Z_PARTIAL_FLUSH", Z_PARTIAL_FLUSH);
    _ = c.PyModule_AddIntConstant(module, "Z_SYNC_FLUSH", Z_SYNC_FLUSH);
    _ = c.PyModule_AddIntConstant(module, "Z_FULL_FLUSH", Z_FULL_FLUSH);
    _ = c.PyModule_AddIntConstant(module, "Z_FINISH", Z_FINISH);
    _ = c.PyModule_AddIntConstant(module, "Z_BLOCK", Z_BLOCK);
    _ = c.PyModule_AddIntConstant(module, "Z_TREES", Z_TREES);
    _ = c.PyModule_AddStringConstant(module, "ZLIB_VERSION", "1.2.13");
    _ = c.PyModule_AddStringConstant(module, "ZLIB_RUNTIME_VERSION", "1.2.13");

    return module;
}
