// Zig replacement for CPython's Modules/_functoolsmodule.c
// Implements partial, reduce, cmp_to_key, and lru_cache.
//
// This module exports PyInit__functools so CPython loads it as a native extension.
// Based on metal0's functools.zig which implements reduce, partial, LruCache, and cmp_to_key.
//
// CPython's _functools C extension provides:
// - partial: partial function application object
// - reduce: apply function cumulatively to sequence items
// - cmp_to_key: convert old-style comparison function to key function
// - _lru_cache_wrapper: C accelerator for lru_cache decorator

const std = @import("std");
const c = @cImport({
    @cInclude("Python.h");
});

const allocator = std.heap.c_allocator;

// ============================================================================
// PARTIAL - Partial function application
// ============================================================================

const PartialObject = extern struct {
    ob_base: c.PyObject,
    fn_obj: ?*c.PyObject,
    args: ?*c.PyObject, // tuple of positional args
    kwargs: ?*c.PyObject, // dict of keyword args
};

fn partial_init(self_raw: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) c_int {
    const self: *PartialObject = @ptrCast(@alignCast(self_raw));

    const nargs = c.PyTuple_Size(args);
    if (nargs < 1) {
        c.PyErr_SetString(c.PyExc_TypeError, "partial() requires at least one argument");
        return -1;
    }

    // First arg is the function
    const fn_obj = c.PyTuple_GetItem(args, 0);
    if (fn_obj == null) return -1;
    if (c.PyCallable_Check(fn_obj) == 0) {
        c.PyErr_SetString(c.PyExc_TypeError, "the first argument must be callable");
        return -1;
    }

    c.Py_IncRef(fn_obj);
    self.fn_obj = fn_obj;

    // Remaining positional args
    const partial_args = c.PyTuple_GetSlice(args, 1, nargs);
    if (partial_args == null) return -1;
    self.args = partial_args;

    // Keyword args
    if (kwargs != null and c.PyDict_Size(kwargs) > 0) {
        const kw_copy = c.PyDict_Copy(kwargs);
        if (kw_copy == null) return -1;
        self.kwargs = kw_copy;
    } else {
        self.kwargs = null;
    }

    return 0;
}

fn partial_call(self_raw: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *PartialObject = @ptrCast(@alignCast(self_raw));

    // Combine partial args with call args
    const partial_len = c.PyTuple_Size(self.args.?);
    const call_len = if (args != null) c.PyTuple_Size(args) else 0;
    const total_len = partial_len + call_len;

    const combined_args = c.PyTuple_New(total_len);
    if (combined_args == null) return null;

    // Copy partial args
    var i: c.Py_ssize_t = 0;
    while (i < partial_len) : (i += 1) {
        const item = c.PyTuple_GetItem(self.args.?, i);
        c.Py_IncRef(item);
        _ = c.PyTuple_SetItem(combined_args, i, item);
    }

    // Copy call args
    var j: c.Py_ssize_t = 0;
    while (j < call_len) : (j += 1) {
        const item = c.PyTuple_GetItem(args, j);
        c.Py_IncRef(item);
        _ = c.PyTuple_SetItem(combined_args, partial_len + j, item);
    }

    // Merge keyword args: partial kwargs as base, call kwargs override
    var combined_kwargs: ?*c.PyObject = null;
    if (self.kwargs != null or kwargs != null) {
        if (self.kwargs) |pk| {
            combined_kwargs = c.PyDict_Copy(pk);
        } else {
            combined_kwargs = c.PyDict_New();
        }
        if (combined_kwargs == null) {
            c.Py_DecRef(combined_args);
            return null;
        }
        if (kwargs != null) {
            if (c.PyDict_Update(combined_kwargs, kwargs) < 0) {
                c.Py_DecRef(combined_args);
                c.Py_DecRef(combined_kwargs);
                return null;
            }
        }
    }

    const result = c.PyObject_Call(self.fn_obj.?, combined_args, combined_kwargs);
    c.Py_DecRef(combined_args);
    if (combined_kwargs) |ck| c.Py_DecRef(ck);
    return result;
}

fn partial_repr(self_raw: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *PartialObject = @ptrCast(@alignCast(self_raw));
    const fn_repr = c.PyObject_Repr(self.fn_obj.?);
    if (fn_repr == null) return null;
    defer c.Py_DecRef(fn_repr);

    const args_repr = c.PyObject_Repr(self.args.?);
    if (args_repr == null) return null;
    defer c.Py_DecRef(args_repr);

    if (self.kwargs) |kw| {
        const kw_repr = c.PyObject_Repr(kw);
        if (kw_repr == null) return null;
        defer c.Py_DecRef(kw_repr);
        return c.PyUnicode_FromFormat("functools.partial(%U, *%U, **%U)", fn_repr, args_repr, kw_repr);
    }

    return c.PyUnicode_FromFormat("functools.partial(%U, *%U)", fn_repr, args_repr);
}

fn partial_get_func(self_raw: ?*c.PyObject, _: ?*anyopaque) callconv(.c) ?*c.PyObject {
    const self: *PartialObject = @ptrCast(@alignCast(self_raw));
    if (self.fn_obj) |f| {
        c.Py_IncRef(f);
        return f;
    }
    c.Py_IncRef(c.Py_None());
    return c.Py_None();
}

fn partial_get_args(self_raw: ?*c.PyObject, _: ?*anyopaque) callconv(.c) ?*c.PyObject {
    const self: *PartialObject = @ptrCast(@alignCast(self_raw));
    if (self.args) |a| {
        c.Py_IncRef(a);
        return a;
    }
    return c.PyTuple_New(0);
}

fn partial_get_keywords(self_raw: ?*c.PyObject, _: ?*anyopaque) callconv(.c) ?*c.PyObject {
    const self: *PartialObject = @ptrCast(@alignCast(self_raw));
    if (self.kwargs) |k| {
        c.Py_IncRef(k);
        return k;
    }
    return c.PyDict_New();
}

fn partial_dealloc(self_raw: ?*c.PyObject) callconv(.c) void {
    const self: *PartialObject = @ptrCast(@alignCast(self_raw));
    if (self.fn_obj) |f| c.Py_DecRef(f);
    if (self.args) |a| c.Py_DecRef(a);
    if (self.kwargs) |k| c.Py_DecRef(k);
    c.PyObject_Free(self_raw);
}

const partial_getset = [_]c.PyGetSetDef{
    .{ .name = "func", .get = @ptrCast(&partial_get_func), .set = null, .doc = "Function object to use in future partial calls.", .closure = null },
    .{ .name = "args", .get = @ptrCast(&partial_get_args), .set = null, .doc = "Tuple of arguments to future partial calls.", .closure = null },
    .{ .name = "keywords", .get = @ptrCast(&partial_get_keywords), .set = null, .doc = "Dictionary of keyword arguments to future partial calls.", .closure = null },
    .{ .name = null, .get = null, .set = null, .doc = null, .closure = null },
};

var partial_type: c.PyTypeObject = blk: {
    var t: c.PyTypeObject = std.mem.zeroes(c.PyTypeObject);
    t.tp_name = "functools.partial";
    t.tp_basicsize = @sizeOf(PartialObject);
    t.tp_flags = c.Py_TPFLAGS_DEFAULT | c.Py_TPFLAGS_BASETYPE;
    t.tp_doc = "partial(func, *args, **keywords) - new function with partial application\nof the given arguments and keywords.";
    t.tp_init = @ptrCast(&partial_init);
    t.tp_call = @ptrCast(&partial_call);
    t.tp_repr = @ptrCast(&partial_repr);
    t.tp_dealloc = @ptrCast(&partial_dealloc);
    t.tp_getset = @constCast(&partial_getset);
    t.tp_new = c.PyType_GenericNew;
    break :blk t;
};

// ============================================================================
// REDUCE - Apply function cumulatively to sequence items
// ============================================================================

fn py_reduce(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var func: ?*c.PyObject = null;
    var seq: ?*c.PyObject = null;
    var initial: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "OO|O", &func, &seq, &initial) == 0) return null;

    const iter = c.PyObject_GetIter(seq.?);
    if (iter == null) return null;
    defer c.Py_DecRef(iter);

    var result: ?*c.PyObject = null;

    if (initial) |init| {
        c.Py_IncRef(init);
        result = init;
    } else {
        // Use first element as initial value
        result = c.PyIter_Next(iter);
        if (result == null) {
            if (c.PyErr_Occurred() != null) return null;
            c.PyErr_SetString(c.PyExc_TypeError, "reduce() of empty iterable with no initial value");
            return null;
        }
    }

    // Apply function to accumulator and each element
    while (true) {
        const item = c.PyIter_Next(iter);
        if (item == null) {
            if (c.PyErr_Occurred() != null) {
                if (result) |r| c.Py_DecRef(r);
                return null;
            }
            break;
        }

        const call_args = c.PyTuple_New(2);
        if (call_args == null) {
            c.Py_DecRef(item);
            if (result) |r| c.Py_DecRef(r);
            return null;
        }
        _ = c.PyTuple_SetItem(call_args, 0, result.?); // Steals reference
        _ = c.PyTuple_SetItem(call_args, 1, item); // Steals reference

        result = c.PyObject_Call(func.?, call_args, null);
        c.Py_DecRef(call_args);
        if (result == null) return null;
    }

    return result;
}

// ============================================================================
// CMP_TO_KEY - Convert comparison function to key function
// ============================================================================

const CmpToKeyObject = extern struct {
    ob_base: c.PyObject,
    cmp_func: ?*c.PyObject,
    obj: ?*c.PyObject,
};

fn cmp_to_key_richcompare(self_raw: ?*c.PyObject, other_raw: ?*c.PyObject, op: c_int) callconv(.c) ?*c.PyObject {
    const self: *CmpToKeyObject = @ptrCast(@alignCast(self_raw));
    const other: *CmpToKeyObject = @ptrCast(@alignCast(other_raw));

    const call_args = c.PyTuple_New(2);
    if (call_args == null) return null;
    c.Py_IncRef(self.obj.?);
    c.Py_IncRef(other.obj.?);
    _ = c.PyTuple_SetItem(call_args, 0, self.obj.?);
    _ = c.PyTuple_SetItem(call_args, 1, other.obj.?);

    const result = c.PyObject_Call(self.cmp_func.?, call_args, null);
    c.Py_DecRef(call_args);
    if (result == null) return null;

    const zero = c.PyLong_FromLong(0);
    if (zero == null) {
        c.Py_DecRef(result);
        return null;
    }
    defer c.Py_DecRef(zero);

    const cmp_val = c.PyObject_RichCompare(result, zero, op);
    c.Py_DecRef(result);
    return cmp_val;
}

fn cmp_to_key_dealloc(self_raw: ?*c.PyObject) callconv(.c) void {
    const self: *CmpToKeyObject = @ptrCast(@alignCast(self_raw));
    if (self.cmp_func) |f_val| c.Py_DecRef(f_val);
    if (self.obj) |o| c.Py_DecRef(o);
    c.PyObject_Free(self_raw);
}

fn cmp_to_key_hash(_: ?*c.PyObject) callconv(.c) c.Py_hash_t {
    c.PyErr_SetString(c.PyExc_TypeError, "unhashable type: 'cmp_to_key'");
    return -1;
}

var cmp_to_key_type: c.PyTypeObject = blk: {
    var t: c.PyTypeObject = std.mem.zeroes(c.PyTypeObject);
    t.tp_name = "functools.KeyWrapper";
    t.tp_basicsize = @sizeOf(CmpToKeyObject);
    t.tp_flags = c.Py_TPFLAGS_DEFAULT;
    t.tp_doc = "Key wrapper created by cmp_to_key for rich comparison ordering.";
    t.tp_dealloc = @ptrCast(&cmp_to_key_dealloc);
    t.tp_richcompare = @ptrCast(&cmp_to_key_richcompare);
    t.tp_hash = @ptrCast(&cmp_to_key_hash);
    t.tp_new = c.PyType_GenericNew;
    break :blk t;
};

// Factory callable that captures the cmp function and produces KeyWrapper instances
const CmpToKeyFactoryObject = extern struct {
    ob_base: c.PyObject,
    cmp_func: ?*c.PyObject,
};

fn cmp_to_key_factory_call(self_raw: ?*c.PyObject, args: ?*c.PyObject, _: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *CmpToKeyFactoryObject = @ptrCast(@alignCast(self_raw));
    var obj: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &obj) == 0) return null;

    const wrapper = c.PyType_GenericNew(&cmp_to_key_type, null, null);
    if (wrapper == null) return null;
    const key_obj: *CmpToKeyObject = @ptrCast(@alignCast(wrapper));

    c.Py_IncRef(self.cmp_func.?);
    key_obj.cmp_func = self.cmp_func;
    c.Py_IncRef(obj.?);
    key_obj.obj = obj;

    return wrapper;
}

fn cmp_to_key_factory_dealloc(self_raw: ?*c.PyObject) callconv(.c) void {
    const self: *CmpToKeyFactoryObject = @ptrCast(@alignCast(self_raw));
    if (self.cmp_func) |f_val| c.Py_DecRef(f_val);
    c.PyObject_Free(self_raw);
}

var cmp_to_key_factory_type: c.PyTypeObject = blk: {
    var t: c.PyTypeObject = std.mem.zeroes(c.PyTypeObject);
    t.tp_name = "functools.cmp_to_key";
    t.tp_basicsize = @sizeOf(CmpToKeyFactoryObject);
    t.tp_flags = c.Py_TPFLAGS_DEFAULT;
    t.tp_doc = "Convert a cmp= function into a key= function.";
    t.tp_call = @ptrCast(&cmp_to_key_factory_call);
    t.tp_dealloc = @ptrCast(&cmp_to_key_factory_dealloc);
    t.tp_new = c.PyType_GenericNew;
    break :blk t;
};

/// cmp_to_key(mycmp) -> key function
/// Convert a cmp= function into a key= function
fn py_cmp_to_key(_: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var cmp_func: ?*c.PyObject = null;
    var kwlist = [_:null]?[*:0]const u8{ "mycmp", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "O", @ptrCast(&kwlist), &cmp_func) == 0) return null;

    if (c.PyCallable_Check(cmp_func.?) == 0) {
        c.PyErr_SetString(c.PyExc_TypeError, "the comparison function must be callable");
        return null;
    }

    const wrapper_obj = c.PyType_GenericNew(&cmp_to_key_factory_type, null, null);
    if (wrapper_obj == null) return null;
    const factory: *CmpToKeyFactoryObject = @ptrCast(@alignCast(wrapper_obj));
    c.Py_IncRef(cmp_func.?);
    factory.cmp_func = cmp_func;

    return wrapper_obj;
}

// ============================================================================
// LRU_CACHE_WRAPPER - C accelerator for functools.lru_cache
// ============================================================================

const LruCacheObject = extern struct {
    ob_base: c.PyObject,
    func: ?*c.PyObject,
    cache: ?*c.PyObject, // dict
    maxsize: c.Py_ssize_t, // -1 means unbounded, 0 means disabled
    hits: c.Py_ssize_t,
    misses: c.Py_ssize_t,
    typed: c_int,
};

// _CacheInfo namedtuple type, created at module init via collections.namedtuple
var cache_info_type: ?*c.PyObject = null;

fn lru_cache_init(self_raw: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) c_int {
    const self: *LruCacheObject = @ptrCast(@alignCast(self_raw));
    var func: ?*c.PyObject = null;
    var maxsize_obj: ?*c.PyObject = null;
    var typed: c_int = 0;

    var kwlist = [_:null]?[*:0]const u8{ "user_function", "maxsize", "typed", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "O|Op", @ptrCast(&kwlist), &func, &maxsize_obj, &typed) == 0) return -1;

    if (c.PyCallable_Check(func.?) == 0) {
        c.PyErr_SetString(c.PyExc_TypeError, "the first argument must be callable");
        return -1;
    }

    c.Py_IncRef(func.?);
    self.func = func;

    if (maxsize_obj != null and maxsize_obj != @as(?*c.PyObject, c.Py_None())) {
        self.maxsize = c.PyLong_AsSsize_t(maxsize_obj.?);
    } else {
        self.maxsize = -1; // unbounded
    }

    self.cache = c.PyDict_New();
    if (self.cache == null) return -1;

    self.hits = 0;
    self.misses = 0;
    self.typed = typed;

    return 0;
}

fn lru_cache_call(self_raw: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *LruCacheObject = @ptrCast(@alignCast(self_raw));

    // Build cache key from args + kwargs
    var cache_key: ?*c.PyObject = null;
    if (kwargs != null and c.PyDict_Size(kwargs) > 0) {
        // Include sorted kwargs items in cache key for deterministic hashing
        const kw_items = c.PyDict_Items(kwargs);
        if (kw_items == null) return null;
        defer c.Py_DecRef(kw_items);
        const sorted_items = c.PySequence_List(kw_items);
        if (sorted_items == null) return null;
        defer c.Py_DecRef(sorted_items);
        _ = c.PyList_Sort(sorted_items);
        const kw_tuple = c.PyList_AsTuple(sorted_items);
        if (kw_tuple == null) return null;
        defer c.Py_DecRef(kw_tuple);

        cache_key = c.PyTuple_New(2);
        if (cache_key == null) return null;
        c.Py_IncRef(args);
        _ = c.PyTuple_SetItem(cache_key.?, 0, args);
        c.Py_IncRef(kw_tuple);
        _ = c.PyTuple_SetItem(cache_key.?, 1, kw_tuple);
    } else {
        c.Py_IncRef(args);
        cache_key = args;
    }
    defer c.Py_DecRef(cache_key.?);

    // Look up in cache
    const cached = c.PyDict_GetItem(self.cache.?, cache_key.?);
    if (cached != null) {
        self.hits += 1;
        c.Py_IncRef(cached);
        return cached;
    }

    // Cache miss - call the function
    self.misses += 1;
    const result = c.PyObject_Call(self.func.?, args, kwargs);
    if (result == null) return null;

    // Store in cache (with eviction if bounded)
    if (self.maxsize != 0) {
        if (self.maxsize > 0 and c.PyDict_Size(self.cache.?) >= self.maxsize) {
            // Evict oldest entry (first key in dict iteration order, preserved since Python 3.7)
            const keys = c.PyDict_Keys(self.cache.?);
            if (keys != null and c.PyList_Size(keys) > 0) {
                const oldest_key = c.PyList_GetItem(keys, 0);
                if (oldest_key != null) {
                    _ = c.PyDict_DelItem(self.cache.?, oldest_key);
                }
                c.Py_DecRef(keys);
            }
        }
        _ = c.PyDict_SetItem(self.cache.?, cache_key.?, result);
    }

    return result;
}

fn py_lru_cache_info(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *LruCacheObject = @ptrCast(@alignCast(self_raw));

    const maxsize_obj: ?*c.PyObject = if (self.maxsize < 0)
        blk: {
            c.Py_IncRef(c.Py_None());
            break :blk c.Py_None();
        }
    else
        c.PyLong_FromSsize_t(self.maxsize);

    // Build _CacheInfo namedtuple: _CacheInfo(hits, misses, maxsize, currsize)
    if (cache_info_type) |ci_type| {
        const info_args = c.PyTuple_New(4);
        if (info_args == null) return null;
        _ = c.PyTuple_SetItem(info_args, 0, c.PyLong_FromSsize_t(self.hits));
        _ = c.PyTuple_SetItem(info_args, 1, c.PyLong_FromSsize_t(self.misses));
        _ = c.PyTuple_SetItem(info_args, 2, maxsize_obj);
        _ = c.PyTuple_SetItem(info_args, 3, c.PyLong_FromSsize_t(c.PyDict_Size(self.cache.?)));
        const info = c.PyObject_Call(ci_type, info_args, null);
        c.Py_DecRef(info_args);
        return info;
    }

    // Fallback: plain tuple if _CacheInfo type was not initialized
    const info = c.PyTuple_New(4);
    if (info == null) return null;
    _ = c.PyTuple_SetItem(info, 0, c.PyLong_FromSsize_t(self.hits));
    _ = c.PyTuple_SetItem(info, 1, c.PyLong_FromSsize_t(self.misses));
    _ = c.PyTuple_SetItem(info, 2, maxsize_obj);
    _ = c.PyTuple_SetItem(info, 3, c.PyLong_FromSsize_t(c.PyDict_Size(self.cache.?)));
    return info;
}

fn py_lru_cache_clear(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    const self: *LruCacheObject = @ptrCast(@alignCast(self_raw));
    c.PyDict_Clear(self.cache.?);
    self.hits = 0;
    self.misses = 0;
    c.Py_IncRef(c.Py_None());
    return c.Py_None();
}

fn lru_cache_dealloc(self_raw: ?*c.PyObject) callconv(.c) void {
    const self: *LruCacheObject = @ptrCast(@alignCast(self_raw));
    if (self.func) |f_val| c.Py_DecRef(f_val);
    if (self.cache) |ca| c.Py_DecRef(ca);
    c.PyObject_Free(self_raw);
}

const lru_cache_methods = [_]c.PyMethodDef{
    .{ .ml_name = "cache_info", .ml_meth = @ptrCast(&py_lru_cache_info), .ml_flags = c.METH_NOARGS, .ml_doc = "Report cache statistics." },
    .{ .ml_name = "cache_clear", .ml_meth = @ptrCast(&py_lru_cache_clear), .ml_flags = c.METH_NOARGS, .ml_doc = "Clear the cache and cache statistics." },
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var lru_cache_type: c.PyTypeObject = blk: {
    var t: c.PyTypeObject = std.mem.zeroes(c.PyTypeObject);
    t.tp_name = "functools._lru_cache_wrapper";
    t.tp_basicsize = @sizeOf(LruCacheObject);
    t.tp_flags = c.Py_TPFLAGS_DEFAULT;
    t.tp_doc = "C accelerator for functools.lru_cache decorator.";
    t.tp_init = @ptrCast(&lru_cache_init);
    t.tp_call = @ptrCast(&lru_cache_call);
    t.tp_dealloc = @ptrCast(&lru_cache_dealloc);
    t.tp_methods = @constCast(&lru_cache_methods);
    t.tp_new = c.PyType_GenericNew;
    break :blk t;
};

// ============================================================================
// _CacheInfo namedtuple initialization
// ============================================================================

fn init_cache_info_type() void {
    // Create _CacheInfo = namedtuple('_CacheInfo', ['hits', 'misses', 'maxsize', 'currsize'])
    const collections = c.PyImport_ImportModule("collections");
    if (collections == null) {
        _ = c.PyErr_Clear();
        return;
    }
    defer c.Py_DecRef(collections);

    const namedtuple_fn = c.PyObject_GetAttrString(collections, "namedtuple");
    if (namedtuple_fn == null) {
        _ = c.PyErr_Clear();
        return;
    }
    defer c.Py_DecRef(namedtuple_fn);

    const nt_args = c.PyTuple_New(2);
    if (nt_args == null) {
        _ = c.PyErr_Clear();
        return;
    }
    _ = c.PyTuple_SetItem(nt_args, 0, c.PyUnicode_FromString("_CacheInfo"));

    const fields = c.PyList_New(4);
    if (fields == null) {
        c.Py_DecRef(nt_args);
        _ = c.PyErr_Clear();
        return;
    }
    _ = c.PyList_SetItem(fields, 0, c.PyUnicode_FromString("hits"));
    _ = c.PyList_SetItem(fields, 1, c.PyUnicode_FromString("misses"));
    _ = c.PyList_SetItem(fields, 2, c.PyUnicode_FromString("maxsize"));
    _ = c.PyList_SetItem(fields, 3, c.PyUnicode_FromString("currsize"));
    _ = c.PyTuple_SetItem(nt_args, 1, fields);

    cache_info_type = c.PyObject_Call(namedtuple_fn, nt_args, null);
    c.Py_DecRef(nt_args);
    if (cache_info_type == null) {
        _ = c.PyErr_Clear();
    }
}

// ============================================================================
// MODULE DEFINITION
// ============================================================================

const module_methods = [_]c.PyMethodDef{
    .{
        .ml_name = "reduce",
        .ml_meth = @ptrCast(&py_reduce),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "reduce(function, iterable[, initial]) -> value\n\nApply a function of two arguments cumulatively to the items of a sequence\nor iterable, from left to right, so as to reduce the iterable to a single\nvalue.",
    },
    .{
        .ml_name = "cmp_to_key",
        .ml_meth = @ptrCast(&py_cmp_to_key),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "cmp_to_key(mycmp) -> key function\n\nConvert a cmp= function into a key= function.",
    },
    // Sentinel
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var module_def = c.PyModuleDef{
    .m_base = c.PyModuleDef_HEAD_INIT,
    .m_name = "_functools",
    .m_doc = "Tools for working with functions and callable objects - Zig implementation replacing _functoolsmodule.c",
    .m_size = -1,
    .m_methods = @constCast(&module_methods),
    .m_slots = null,
    .m_traverse = null,
    .m_clear = null,
    .m_free = null,
};

/// CPython module init entry point.
export fn PyInit__functools() ?*c.PyObject {
    if (c.PyType_Ready(&partial_type) < 0) return null;
    if (c.PyType_Ready(&cmp_to_key_type) < 0) return null;
    if (c.PyType_Ready(&cmp_to_key_factory_type) < 0) return null;
    if (c.PyType_Ready(&lru_cache_type) < 0) return null;

    // Initialize _CacheInfo namedtuple type
    init_cache_info_type();

    const module = c.PyModule_Create(&module_def);
    if (module == null) return null;

    // Add partial type
    c.Py_IncRef(@ptrCast(&partial_type));
    if (c.PyModule_AddObject(module, "partial", @ptrCast(&partial_type)) < 0) {
        c.Py_DecRef(@ptrCast(&partial_type));
        c.Py_DecRef(module);
        return null;
    }

    // Add _lru_cache_wrapper type
    c.Py_IncRef(@ptrCast(&lru_cache_type));
    if (c.PyModule_AddObject(module, "_lru_cache_wrapper", @ptrCast(&lru_cache_type)) < 0) {
        c.Py_DecRef(@ptrCast(&lru_cache_type));
        c.Py_DecRef(module);
        return null;
    }

    // Add cmp_to_key as a callable attribute (the factory type)
    c.Py_IncRef(@ptrCast(&cmp_to_key_factory_type));
    if (c.PyModule_AddObject(module, "cmp_to_key", @ptrCast(&cmp_to_key_factory_type)) < 0) {
        c.Py_DecRef(@ptrCast(&cmp_to_key_factory_type));
        c.Py_DecRef(module);
        return null;
    }

    return module;
}
