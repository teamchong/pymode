// Zig replacement for CPython's Modules/_hashopenssl.c
// Uses Zig's std.crypto instead of OpenSSL for hash computations.
//
// This module exports PyInit__hashlib so CPython loads it as a native extension.
// Based on metal0's hashlib.zig which implements incremental hashing via std.crypto.
//
// CPython's hashlib module loads _hashlib as the OpenSSL-backed C accelerator. It expects:
// - new(name, data=b"", **kwargs): create a new hash object by algorithm name
// - openssl_md5, openssl_sha1, openssl_sha256, etc.: direct constructors
// - HASH: type object for hash instances
// - compare_digest(a, b): constant-time comparison
// - pbkdf2_hmac(name, password, salt, iterations, dklen=None): key derivation
// - hmac_digest(key, msg, digest): single-shot HMAC
// - openssl_md_meth_names: frozenset of supported algorithm names

const std = @import("std");
const c = @cImport({
    @cInclude("Python.h");
});

const allocator = std.heap.c_allocator;

// Zig crypto imports
const Md5 = std.crypto.hash.Md5;
const Sha1 = std.crypto.hash.Sha1;
const Sha224 = std.crypto.hash.sha2.Sha224;
const Sha256 = std.crypto.hash.sha2.Sha256;
const Sha384 = std.crypto.hash.sha2.Sha384;
const Sha512 = std.crypto.hash.sha2.Sha512;
const Blake2s256 = std.crypto.hash.blake2.Blake2s256;
const Blake2b512 = std.crypto.hash.blake2.Blake2b512;
const HmacSha256 = std.crypto.auth.hmac.HmacSha256;

// ============================================================================
// HASH ALGORITHM ENUM
// ============================================================================

const HashAlgorithm = enum {
    md5,
    sha1,
    sha224,
    sha256,
    sha384,
    sha512,
    blake2s,
    blake2b,
};

// ============================================================================
// HASH OBJECT - maps to CPython's _hashlib.HASH
// ============================================================================

const HashObject = extern struct {
    ob_base: c.PyObject,
    algorithm: HashAlgorithm,
    // Hasher state stored as opaque bytes (union would cause alignment issues in extern struct)
    state_buf: [256]u8,
};

fn get_digest_size(algo: HashAlgorithm) usize {
    return switch (algo) {
        .md5 => Md5.digest_length,
        .sha1 => Sha1.digest_length,
        .sha224 => Sha224.digest_length,
        .sha256 => Sha256.digest_length,
        .sha384 => Sha384.digest_length,
        .sha512 => Sha512.digest_length,
        .blake2s => Blake2s256.digest_length,
        .blake2b => Blake2b512.digest_length,
    };
}

fn get_block_size(algo: HashAlgorithm) usize {
    return switch (algo) {
        .md5 => Md5.block_length,
        .sha1 => Sha1.block_length,
        .sha224 => Sha224.block_length,
        .sha256 => Sha256.block_length,
        .sha384 => Sha384.block_length,
        .sha512 => Sha512.block_length,
        .blake2s => Blake2s256.block_length,
        .blake2b => Blake2b512.block_length,
    };
}

fn get_name_str(algo: HashAlgorithm) [*:0]const u8 {
    return switch (algo) {
        .md5 => "md5",
        .sha1 => "sha1",
        .sha224 => "sha224",
        .sha256 => "sha256",
        .sha384 => "sha384",
        .sha512 => "sha512",
        .blake2s => "blake2s",
        .blake2b => "blake2b",
    };
}

fn init_hasher_state(algo: HashAlgorithm, buf: *[256]u8) void {
    switch (algo) {
        .md5 => {
            const h = Md5.init(.{});
            @memcpy(buf[0..@sizeOf(Md5)], std.mem.asBytes(&h));
        },
        .sha1 => {
            const h = Sha1.init(.{});
            @memcpy(buf[0..@sizeOf(Sha1)], std.mem.asBytes(&h));
        },
        .sha224 => {
            const h = Sha224.init(.{});
            @memcpy(buf[0..@sizeOf(Sha224)], std.mem.asBytes(&h));
        },
        .sha256 => {
            const h = Sha256.init(.{});
            @memcpy(buf[0..@sizeOf(Sha256)], std.mem.asBytes(&h));
        },
        .sha384 => {
            const h = Sha384.init(.{});
            @memcpy(buf[0..@sizeOf(Sha384)], std.mem.asBytes(&h));
        },
        .sha512 => {
            const h = Sha512.init(.{});
            @memcpy(buf[0..@sizeOf(Sha512)], std.mem.asBytes(&h));
        },
        .blake2s => {
            const h = Blake2s256.init(.{});
            @memcpy(buf[0..@sizeOf(Blake2s256)], std.mem.asBytes(&h));
        },
        .blake2b => {
            const h = Blake2b512.init(.{});
            @memcpy(buf[0..@sizeOf(Blake2b512)], std.mem.asBytes(&h));
        },
    }
}

fn update_hasher(algo: HashAlgorithm, buf: *[256]u8, data: []const u8) void {
    switch (algo) {
        .md5 => {
            const h: *Md5 = @ptrCast(@alignCast(buf));
            h.update(data);
        },
        .sha1 => {
            const h: *Sha1 = @ptrCast(@alignCast(buf));
            h.update(data);
        },
        .sha224 => {
            const h: *Sha224 = @ptrCast(@alignCast(buf));
            h.update(data);
        },
        .sha256 => {
            const h: *Sha256 = @ptrCast(@alignCast(buf));
            h.update(data);
        },
        .sha384 => {
            const h: *Sha384 = @ptrCast(@alignCast(buf));
            h.update(data);
        },
        .sha512 => {
            const h: *Sha512 = @ptrCast(@alignCast(buf));
            h.update(data);
        },
        .blake2s => {
            const h: *Blake2s256 = @ptrCast(@alignCast(buf));
            h.update(data);
        },
        .blake2b => {
            const h: *Blake2b512 = @ptrCast(@alignCast(buf));
            h.update(data);
        },
    }
}

fn finalize_hasher(algo: HashAlgorithm, buf: *[256]u8, out: []u8) void {
    // Copy state so we don't consume the original hasher
    var tmp: [256]u8 = undefined;
    @memcpy(&tmp, buf);

    switch (algo) {
        .md5 => {
            const h: *Md5 = @ptrCast(@alignCast(&tmp));
            h.final(out[0..Md5.digest_length]);
        },
        .sha1 => {
            const h: *Sha1 = @ptrCast(@alignCast(&tmp));
            h.final(out[0..Sha1.digest_length]);
        },
        .sha224 => {
            const h: *Sha224 = @ptrCast(@alignCast(&tmp));
            h.final(out[0..Sha224.digest_length]);
        },
        .sha256 => {
            const h: *Sha256 = @ptrCast(@alignCast(&tmp));
            h.final(out[0..Sha256.digest_length]);
        },
        .sha384 => {
            const h: *Sha384 = @ptrCast(@alignCast(&tmp));
            h.final(out[0..Sha384.digest_length]);
        },
        .sha512 => {
            const h: *Sha512 = @ptrCast(@alignCast(&tmp));
            h.final(out[0..Sha512.digest_length]);
        },
        .blake2s => {
            const h: *Blake2s256 = @ptrCast(@alignCast(&tmp));
            h.final(out[0..Blake2s256.digest_length]);
        },
        .blake2b => {
            const h: *Blake2b512 = @ptrCast(@alignCast(&tmp));
            h.final(out[0..Blake2b512.digest_length]);
        },
    }
}

fn parse_algorithm_name(name_ptr: [*]const u8, name_len: usize) ?HashAlgorithm {
    const name = name_ptr[0..name_len];
    if (std.mem.eql(u8, name, "md5")) return .md5;
    if (std.mem.eql(u8, name, "sha1")) return .sha1;
    if (std.mem.eql(u8, name, "sha224")) return .sha224;
    if (std.mem.eql(u8, name, "sha256")) return .sha256;
    if (std.mem.eql(u8, name, "sha384")) return .sha384;
    if (std.mem.eql(u8, name, "sha512")) return .sha512;
    if (std.mem.eql(u8, name, "blake2s")) return .blake2s;
    if (std.mem.eql(u8, name, "blake2b")) return .blake2b;
    return null;
}

// ============================================================================
// HASH OBJECT METHODS
// ============================================================================

fn hash_init(self_raw: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) c_int {
    const self: *HashObject = @ptrCast(@alignCast(self_raw));

    var name_obj: ?*c.PyObject = null;
    var data_obj: ?*c.PyObject = null;

    var kwlist = [_:null]?[*:0]const u8{ "name", "data", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "O|O", @ptrCast(&kwlist), &name_obj, &data_obj) == 0) return -1;

    // Get algorithm name
    var name_len: c.Py_ssize_t = undefined;
    const name_ptr = c.PyUnicode_AsUTF8AndSize(name_obj.?, &name_len);
    if (name_ptr == null) return -1;

    const algo = parse_algorithm_name(name_ptr, @intCast(name_len)) orelse {
        c.PyErr_SetString(c.PyExc_ValueError, "unsupported hash type");
        return -1;
    };

    self.algorithm = algo;
    init_hasher_state(algo, &self.state_buf);

    // If initial data provided, update
    if (data_obj) |data| {
        if (data != @as(?*c.PyObject, c.Py_None())) {
            var view: c.Py_buffer = undefined;
            if (c.PyObject_GetBuffer(data, &view, c.PyBUF_SIMPLE) == 0) {
                const ptr: [*]const u8 = @ptrCast(view.buf);
                update_hasher(algo, &self.state_buf, ptr[0..@intCast(view.len)]);
                c.PyBuffer_Release(&view);
            } else {
                return -1;
            }
        }
    }

    return 0;
}

fn hash_update(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *HashObject = @ptrCast(@alignCast(self_raw));
    var data_obj: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &data_obj) == 0) return null;

    var view: c.Py_buffer = undefined;
    if (c.PyObject_GetBuffer(data_obj.?, &view, c.PyBUF_SIMPLE) != 0) return null;
    defer c.PyBuffer_Release(&view);

    const ptr: [*]const u8 = @ptrCast(view.buf);
    update_hasher(self.algorithm, &self.state_buf, ptr[0..@intCast(view.len)]);

    c.Py_IncRef(c.Py_None());
    return c.Py_None();
}

fn hash_digest(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *HashObject = @ptrCast(@alignCast(self_raw));
    const digest_size = get_digest_size(self.algorithm);
    var digest_buf: [64]u8 = undefined; // max digest is 64 bytes (sha512/blake2b)

    finalize_hasher(self.algorithm, &self.state_buf, digest_buf[0..digest_size]);

    return c.PyBytes_FromStringAndSize(@ptrCast(&digest_buf), @intCast(digest_size));
}

fn hash_hexdigest(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *HashObject = @ptrCast(@alignCast(self_raw));
    const digest_size = get_digest_size(self.algorithm);
    var digest_buf: [64]u8 = undefined;

    finalize_hasher(self.algorithm, &self.state_buf, digest_buf[0..digest_size]);

    const hex_chars = "0123456789abcdef";
    var hex_buf: [128]u8 = undefined;
    for (digest_buf[0..digest_size], 0..) |byte, i| {
        hex_buf[i * 2] = hex_chars[byte >> 4];
        hex_buf[i * 2 + 1] = hex_chars[byte & 0x0f];
    }

    return c.PyUnicode_FromStringAndSize(@ptrCast(&hex_buf), @intCast(digest_size * 2));
}

fn hash_copy(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *HashObject = @ptrCast(@alignCast(self_raw));

    const new_obj: *HashObject = @ptrCast(@alignCast(c.PyObject_New(@ptrCast(&hash_type))));
    if (@as(?*c.PyObject, @ptrCast(new_obj)) == null) return null;

    new_obj.algorithm = self.algorithm;
    @memcpy(&new_obj.state_buf, &self.state_buf);

    return @ptrCast(new_obj);
}

fn hash_get_digest_size(self_raw: ?*c.PyObject, _: ?*anyopaque) callconv(.c) ?*c.PyObject {
    const self: *HashObject = @ptrCast(@alignCast(self_raw));
    return c.PyLong_FromSize_t(get_digest_size(self.algorithm));
}

fn hash_get_block_size(self_raw: ?*c.PyObject, _: ?*anyopaque) callconv(.c) ?*c.PyObject {
    const self: *HashObject = @ptrCast(@alignCast(self_raw));
    return c.PyLong_FromSize_t(get_block_size(self.algorithm));
}

fn hash_get_name(self_raw: ?*c.PyObject, _: ?*anyopaque) callconv(.c) ?*c.PyObject {
    const self: *HashObject = @ptrCast(@alignCast(self_raw));
    return c.PyUnicode_FromString(get_name_str(self.algorithm));
}

fn hash_dealloc(self_raw: ?*c.PyObject) callconv(.c) void {
    c.PyObject_Free(self_raw);
}

const hash_methods = [_]c.PyMethodDef{
    .{
        .ml_name = "update",
        .ml_meth = @ptrCast(&hash_update),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "Update this hash object's state with the provided string.",
    },
    .{
        .ml_name = "digest",
        .ml_meth = @ptrCast(&hash_digest),
        .ml_flags = c.METH_NOARGS,
        .ml_doc = "Return the digest value as a bytes object.",
    },
    .{
        .ml_name = "hexdigest",
        .ml_meth = @ptrCast(&hash_hexdigest),
        .ml_flags = c.METH_NOARGS,
        .ml_doc = "Return the digest value as a string of hexadecimal digits.",
    },
    .{
        .ml_name = "copy",
        .ml_meth = @ptrCast(&hash_copy),
        .ml_flags = c.METH_NOARGS,
        .ml_doc = "Return a copy of the hash object.",
    },
    // Sentinel
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

const hash_getset = [_]c.PyGetSetDef{
    .{
        .name = "digest_size",
        .get = @ptrCast(&hash_get_digest_size),
        .set = null,
        .doc = "The size of the resulting hash in bytes.",
        .closure = null,
    },
    .{
        .name = "block_size",
        .get = @ptrCast(&hash_get_block_size),
        .set = null,
        .doc = "The internal block size of the hash algorithm in bytes.",
        .closure = null,
    },
    .{
        .name = "name",
        .get = @ptrCast(&hash_get_name),
        .set = null,
        .doc = "Algorithm name of this hash.",
        .closure = null,
    },
    // Sentinel
    .{ .name = null, .get = null, .set = null, .doc = null, .closure = null },
};

var hash_type: c.PyTypeObject = blk: {
    var t: c.PyTypeObject = std.mem.zeroes(c.PyTypeObject);
    t.tp_name = "_hashlib.HASH";
    t.tp_basicsize = @sizeOf(HashObject);
    t.tp_flags = c.Py_TPFLAGS_DEFAULT;
    t.tp_doc = "A hash object. Use update() to feed data, digest()/hexdigest() to get the hash.";
    t.tp_init = @ptrCast(&hash_init);
    t.tp_dealloc = @ptrCast(&hash_dealloc);
    t.tp_methods = @constCast(&hash_methods);
    t.tp_getset = @constCast(&hash_getset);
    t.tp_new = c.PyType_GenericNew;
    break :blk t;
};

// ============================================================================
// MODULE-LEVEL FUNCTIONS
// ============================================================================

/// _hashlib.new(name, data=b"") -> HASH object
fn py_new(_: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var name_obj: ?*c.PyObject = null;
    var data_obj: ?*c.PyObject = null;

    var kwlist = [_:null]?[*:0]const u8{ "name", "data", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "s|O", @ptrCast(&kwlist), &name_obj, &data_obj) == 0) {
        // Try again treating name as a string object
        _ = c.PyErr_Clear();
        if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "O|O", @ptrCast(&kwlist), &name_obj, &data_obj) == 0) return null;
    }

    // Create hash object via type call
    const hash_obj = c.PyObject_CallObject(@ptrCast(&hash_type), args);
    if (hash_obj == null) {
        // If calling the type failed, try constructing manually
        _ = c.PyErr_Clear();
        return create_hash_from_args(name_obj, data_obj);
    }
    return hash_obj;
}

fn create_hash_from_args(name_obj: ?*c.PyObject, data_obj: ?*c.PyObject) ?*c.PyObject {
    var name_len: c.Py_ssize_t = undefined;
    const name_ptr = c.PyUnicode_AsUTF8AndSize(name_obj.?, &name_len);
    if (name_ptr == null) return null;

    const algo = parse_algorithm_name(name_ptr, @intCast(name_len)) orelse {
        c.PyErr_SetString(c.PyExc_ValueError, "unsupported hash type");
        return null;
    };

    const obj_raw = c.PyType_GenericNew(&hash_type, null, null);
    if (obj_raw == null) return null;
    const self: *HashObject = @ptrCast(@alignCast(obj_raw));

    self.algorithm = algo;
    init_hasher_state(algo, &self.state_buf);

    // If initial data provided, update
    if (data_obj) |data| {
        if (data != @as(?*c.PyObject, c.Py_None())) {
            var view: c.Py_buffer = undefined;
            if (c.PyObject_GetBuffer(data, &view, c.PyBUF_SIMPLE) == 0) {
                const ptr: [*]const u8 = @ptrCast(view.buf);
                update_hasher(algo, &self.state_buf, ptr[0..@intCast(view.len)]);
                c.PyBuffer_Release(&view);
            } else {
                _ = c.PyErr_Clear();
            }
        }
    }

    return obj_raw;
}

/// Helper to create a hash with a specific algorithm
fn make_openssl_hash(algo: HashAlgorithm, _: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) ?*c.PyObject {
    var data_obj: ?*c.PyObject = null;

    var kwlist = [_:null]?[*:0]const u8{ "string", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "|O", @ptrCast(&kwlist), &data_obj) == 0) return null;

    const obj_raw = c.PyType_GenericNew(&hash_type, null, null);
    if (obj_raw == null) return null;
    const self: *HashObject = @ptrCast(@alignCast(obj_raw));

    self.algorithm = algo;
    init_hasher_state(algo, &self.state_buf);

    if (data_obj) |data| {
        if (data != @as(?*c.PyObject, c.Py_None())) {
            var view: c.Py_buffer = undefined;
            if (c.PyObject_GetBuffer(data, &view, c.PyBUF_SIMPLE) == 0) {
                const ptr: [*]const u8 = @ptrCast(view.buf);
                update_hasher(algo, &self.state_buf, ptr[0..@intCast(view.len)]);
                c.PyBuffer_Release(&view);
            } else {
                _ = c.PyErr_Clear();
            }
        }
    }

    return obj_raw;
}

fn py_openssl_md5(self: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    return make_openssl_hash(.md5, self, args, kwargs);
}
fn py_openssl_sha1(self: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    return make_openssl_hash(.sha1, self, args, kwargs);
}
fn py_openssl_sha224(self: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    return make_openssl_hash(.sha224, self, args, kwargs);
}
fn py_openssl_sha256(self: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    return make_openssl_hash(.sha256, self, args, kwargs);
}
fn py_openssl_sha384(self: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    return make_openssl_hash(.sha384, self, args, kwargs);
}
fn py_openssl_sha512(self: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    return make_openssl_hash(.sha512, self, args, kwargs);
}

/// compare_digest(a, b) -> bool
/// Constant-time comparison to prevent timing attacks
fn py_compare_digest(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var a_obj: ?*c.PyObject = null;
    var b_obj: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "OO", &a_obj, &b_obj) == 0) return null;

    // Handle bytes objects
    if (c.PyBytes_Check(a_obj.?) != 0 and c.PyBytes_Check(b_obj.?) != 0) {
        const a_len = c.PyBytes_Size(a_obj.?);
        const b_len = c.PyBytes_Size(b_obj.?);
        const a_ptr: [*]const u8 = @ptrCast(c.PyBytes_AsString(a_obj.?));
        const b_ptr: [*]const u8 = @ptrCast(c.PyBytes_AsString(b_obj.?));

        if (a_len != b_len) {
            c.Py_IncRef(c.Py_False());
            return c.Py_False();
        }

        // Constant-time comparison
        var result: u8 = 0;
        const len: usize = @intCast(a_len);
        for (0..len) |i| {
            result |= a_ptr[i] ^ b_ptr[i];
        }

        if (result == 0) {
            c.Py_IncRef(c.Py_True());
            return c.Py_True();
        } else {
            c.Py_IncRef(c.Py_False());
            return c.Py_False();
        }
    }

    // Handle string objects
    if (c.PyUnicode_Check(a_obj.?) != 0 and c.PyUnicode_Check(b_obj.?) != 0) {
        var a_len: c.Py_ssize_t = undefined;
        var b_len: c.Py_ssize_t = undefined;
        const a_ptr = c.PyUnicode_AsUTF8AndSize(a_obj.?, &a_len);
        const b_ptr = c.PyUnicode_AsUTF8AndSize(b_obj.?, &b_len);

        if (a_ptr == null or b_ptr == null) return null;
        if (a_len != b_len) {
            c.Py_IncRef(c.Py_False());
            return c.Py_False();
        }

        var result: u8 = 0;
        const len: usize = @intCast(a_len);
        for (0..len) |i| {
            result |= a_ptr[i] ^ b_ptr[i];
        }

        if (result == 0) {
            c.Py_IncRef(c.Py_True());
            return c.Py_True();
        } else {
            c.Py_IncRef(c.Py_False());
            return c.Py_False();
        }
    }

    c.PyErr_SetString(c.PyExc_TypeError, "unsupported operand type(s) for compare_digest");
    return null;
}

/// pbkdf2_hmac(hash_name, password, salt, iterations, dklen=None) -> bytes
fn py_pbkdf2_hmac(_: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var hash_name: ?[*:0]const u8 = null;
    var password: c.Py_buffer = undefined;
    var salt: c.Py_buffer = undefined;
    var iterations: c_long = 0;
    var dklen_obj: ?*c.PyObject = null;

    var kwlist = [_:null]?[*:0]const u8{ "hash_name", "password", "salt", "iterations", "dklen", null };
    if (c.PyArg_ParseTupleAndKeywords(
        args,
        kwargs,
        "sy*y*l|O",
        @ptrCast(&kwlist),
        &hash_name,
        &password,
        &salt,
        &iterations,
        &dklen_obj,
    ) == 0) return null;
    defer c.PyBuffer_Release(&password);
    defer c.PyBuffer_Release(&salt);

    if (iterations < 1) {
        c.PyErr_SetString(c.PyExc_ValueError, "iterations must be positive");
        return null;
    }

    // Only support sha256 for PBKDF2 currently (most common)
    const name_str = std.mem.span(hash_name.?);
    if (!std.mem.eql(u8, name_str, "sha256")) {
        c.PyErr_SetString(c.PyExc_ValueError, "unsupported hash type for pbkdf2_hmac (only sha256 supported)");
        return null;
    }

    const dk_size: usize = if (dklen_obj != null and dklen_obj != @as(?*c.PyObject, c.Py_None()))
        @intCast(c.PyLong_AsSize_t(dklen_obj.?))
    else
        Sha256.digest_length;

    const pw_ptr: [*]const u8 = @ptrCast(password.buf);
    const pw_len: usize = @intCast(password.len);
    const salt_ptr: [*]const u8 = @ptrCast(salt.buf);
    const salt_len: usize = @intCast(salt.len);

    // PBKDF2-HMAC-SHA256 implementation
    var result_buf = allocator.alloc(u8, dk_size) catch {
        c.PyErr_SetString(c.PyExc_MemoryError, "out of memory");
        return null;
    };
    defer allocator.free(result_buf);

    // First iteration: HMAC(password, salt || INT(1))
    var hmac = HmacSha256.init(pw_ptr[0..pw_len]);
    hmac.update(salt_ptr[0..salt_len]);
    const block_be: [4]u8 = .{ 0, 0, 0, 1 };
    hmac.update(&block_be);
    var u_buf: [32]u8 = undefined;
    hmac.final(&u_buf);

    var f_buf = u_buf;

    // Remaining iterations
    var iter: c_long = 1;
    while (iter < iterations) : (iter += 1) {
        var hmac2 = HmacSha256.init(pw_ptr[0..pw_len]);
        hmac2.update(&u_buf);
        hmac2.final(&u_buf);
        for (0..32) |j| {
            f_buf[j] ^= u_buf[j];
        }
    }

    const copy_len = @min(dk_size, 32);
    @memcpy(result_buf[0..copy_len], f_buf[0..copy_len]);

    return c.PyBytes_FromStringAndSize(@ptrCast(result_buf.ptr), @intCast(dk_size));
}

/// hmac_digest(key, msg, digest) -> bytes
fn py_hmac_digest(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var key: c.Py_buffer = undefined;
    var msg: c.Py_buffer = undefined;
    var digest_name: ?[*:0]const u8 = null;

    if (c.PyArg_ParseTuple(args, "y*y*s", &key, &msg, &digest_name) == 0) return null;
    defer c.PyBuffer_Release(&key);
    defer c.PyBuffer_Release(&msg);

    const name = std.mem.span(digest_name.?);
    if (!std.mem.eql(u8, name, "sha256")) {
        c.PyErr_SetString(c.PyExc_ValueError, "unsupported digest for hmac (only sha256 supported)");
        return null;
    }

    const key_ptr: [*]const u8 = @ptrCast(key.buf);
    const key_len: usize = @intCast(key.len);
    const msg_ptr: [*]const u8 = @ptrCast(msg.buf);
    const msg_len: usize = @intCast(msg.len);

    var hmac = HmacSha256.init(key_ptr[0..key_len]);
    hmac.update(msg_ptr[0..msg_len]);
    var digest_buf: [32]u8 = undefined;
    hmac.final(&digest_buf);

    return c.PyBytes_FromStringAndSize(@ptrCast(&digest_buf), 32);
}

/// get_fips_mode() -> int (always 0, FIPS not supported)
fn py_get_fips_mode(_: ?*c.PyObject, _: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    return c.PyLong_FromLong(0);
}

// ============================================================================
// MODULE DEFINITION
// ============================================================================

const module_methods = [_]c.PyMethodDef{
    .{
        .ml_name = "new",
        .ml_meth = @ptrCast(&py_new),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "new(name, data=b'') -> hash object\n\nReturn a new hash object using the named algorithm.",
    },
    .{
        .ml_name = "openssl_md5",
        .ml_meth = @ptrCast(&py_openssl_md5),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Returns a md5 hash object.",
    },
    .{
        .ml_name = "openssl_sha1",
        .ml_meth = @ptrCast(&py_openssl_sha1),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Returns a sha1 hash object.",
    },
    .{
        .ml_name = "openssl_sha224",
        .ml_meth = @ptrCast(&py_openssl_sha224),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Returns a sha224 hash object.",
    },
    .{
        .ml_name = "openssl_sha256",
        .ml_meth = @ptrCast(&py_openssl_sha256),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Returns a sha256 hash object.",
    },
    .{
        .ml_name = "openssl_sha384",
        .ml_meth = @ptrCast(&py_openssl_sha384),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Returns a sha384 hash object.",
    },
    .{
        .ml_name = "openssl_sha512",
        .ml_meth = @ptrCast(&py_openssl_sha512),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Returns a sha512 hash object.",
    },
    .{
        .ml_name = "compare_digest",
        .ml_meth = @ptrCast(&py_compare_digest),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "compare_digest(a, b) -> bool\n\nReturn 'a == b' using constant-time comparison.",
    },
    .{
        .ml_name = "pbkdf2_hmac",
        .ml_meth = @ptrCast(&py_pbkdf2_hmac),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "pbkdf2_hmac(hash_name, password, salt, iterations, dklen=None) -> key",
    },
    .{
        .ml_name = "hmac_digest",
        .ml_meth = @ptrCast(&py_hmac_digest),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "hmac_digest(key, msg, digest) -> bytes",
    },
    .{
        .ml_name = "get_fips_mode",
        .ml_meth = @ptrCast(&py_get_fips_mode),
        .ml_flags = c.METH_NOARGS,
        .ml_doc = "get_fips_mode() -> int\n\nReturn the FIPS mode (0 = not FIPS).",
    },
    // Sentinel
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var module_def = c.PyModuleDef{
    .m_base = c.PyModuleDef_HEAD_INIT,
    .m_name = "_hashlib",
    .m_doc = "hashlib accelerator - Zig implementation replacing OpenSSL-backed _hashopenssl.c",
    .m_size = -1,
    .m_methods = @constCast(&module_methods),
    .m_slots = null,
    .m_traverse = null,
    .m_clear = null,
    .m_free = null,
};

/// CPython module init entry point.
/// Called when Python executes `import _hashlib`.
export fn PyInit__hashlib() ?*c.PyObject {
    if (c.PyType_Ready(&hash_type) < 0) return null;

    const module = c.PyModule_Create(&module_def);
    if (module == null) return null;

    // Add HASH type
    c.Py_IncRef(@ptrCast(&hash_type));
    if (c.PyModule_AddObject(module, "HASH", @ptrCast(&hash_type)) < 0) {
        c.Py_DecRef(@ptrCast(&hash_type));
        c.Py_DecRef(module);
        return null;
    }

    // Add openssl_md_meth_names as a frozenset
    const names_tuple = c.PyTuple_New(8);
    if (names_tuple == null) {
        c.Py_DecRef(module);
        return null;
    }
    const algo_names = [_][*:0]const u8{ "md5", "sha1", "sha224", "sha256", "sha384", "sha512", "blake2s", "blake2b" };
    for (algo_names, 0..) |name, i| {
        _ = c.PyTuple_SetItem(names_tuple, @intCast(i), c.PyUnicode_FromString(name));
    }
    const frozen = c.PyFrozenSet_New(names_tuple);
    c.Py_DecRef(names_tuple);
    if (frozen != null) {
        _ = c.PyModule_AddObject(module, "openssl_md_meth_names", frozen);
    }

    return module;
}
