// Zig replacement for CPython's Modules/_collectionsmodule.c
// Implements deque and defaultdict using Zig data structures.
//
// This module exports PyInit__collections so CPython loads it as a native extension.
// Based on metal0's collections/deque.zig and collections/defaultdict.zig.
//
// CPython's _collections C extension provides:
// - deque: double-ended queue with O(1) append/pop on both ends
// - defaultdict: dict subclass with default factory
// - _deque_iterator / _deque_reverse_iterator: iterator types
// - _count_elements: helper for Counter
// - _tuplegetter: descriptor for namedtuple fields

const std = @import("std");
const c = @cImport({
    @cInclude("Python.h");
});

const allocator = std.heap.c_allocator;

// ============================================================================
// DEQUE - Double-ended queue
// ============================================================================

// Internal node for the deque linked list
const DequeNode = struct {
    value: *c.PyObject,
    prev: ?*DequeNode,
    next: ?*DequeNode,
};

const DequeObject = extern struct {
    ob_base: c.PyObject,
    head: ?*anyopaque, // *DequeNode
    tail: ?*anyopaque, // *DequeNode
    len: c.Py_ssize_t,
    maxlen: c.Py_ssize_t, // -1 means unbounded
};

fn deque_init(self_raw: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.C) c_int {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    var iterable: ?*c.PyObject = null;
    var maxlen_obj: ?*c.PyObject = null;

    var kwlist = [_:null]?[*:0]const u8{ "iterable", "maxlen", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "|OO", @ptrCast(&kwlist), &iterable, &maxlen_obj) == 0) return -1;

    self.head = null;
    self.tail = null;
    self.len = 0;
    self.maxlen = -1;

    if (maxlen_obj != null and maxlen_obj != @as(?*c.PyObject, c.Py_None)) {
        self.maxlen = c.PyLong_AsSsize_t(maxlen_obj.?);
        if (self.maxlen < 0) {
            c.PyErr_SetString(c.PyExc_ValueError, "maxlen must be non-negative");
            return -1;
        }
    }

    // Populate from iterable
    if (iterable != null and iterable != @as(?*c.PyObject, c.Py_None)) {
        const iter = c.PyObject_GetIter(iterable.?);
        if (iter == null) return -1;
        defer c.Py_DecRef(iter);

        while (true) {
            const item = c.PyIter_Next(iter);
            if (item == null) {
                if (c.PyErr_Occurred() != null) return -1;
                break;
            }
            if (deque_append_right(self, item) != 0) {
                c.Py_DecRef(item);
                return -1;
            }
        }
    }

    return 0;
}

fn deque_append_right(self: *DequeObject, value: *c.PyObject) c_int {
    const node = allocator.create(DequeNode) catch {
        c.PyErr_SetString(c.PyExc_MemoryError, "out of memory");
        return -1;
    };
    c.Py_IncRef(value);
    node.* = .{ .value = value, .prev = @ptrCast(@alignCast(self.tail)), .next = null };

    if (self.tail) |tail_raw| {
        const tail: *DequeNode = @ptrCast(@alignCast(tail_raw));
        tail.next = node;
    } else {
        self.head = node;
    }
    self.tail = node;
    self.len += 1;

    // Enforce maxlen
    if (self.maxlen >= 0) {
        while (self.len > self.maxlen) {
            _ = deque_popleft_internal(self);
        }
    }

    return 0;
}

fn deque_append_left(self: *DequeObject, value: *c.PyObject) c_int {
    const node = allocator.create(DequeNode) catch {
        c.PyErr_SetString(c.PyExc_MemoryError, "out of memory");
        return -1;
    };
    c.Py_IncRef(value);
    node.* = .{ .value = value, .prev = null, .next = @ptrCast(@alignCast(self.head)) };

    if (self.head) |head_raw| {
        const head: *DequeNode = @ptrCast(@alignCast(head_raw));
        head.prev = node;
    } else {
        self.tail = node;
    }
    self.head = node;
    self.len += 1;

    // Enforce maxlen
    if (self.maxlen >= 0) {
        while (self.len > self.maxlen) {
            _ = deque_popright_internal(self);
        }
    }

    return 0;
}

fn deque_popleft_internal(self: *DequeObject) ?*c.PyObject {
    const head_raw = self.head orelse return null;
    const head: *DequeNode = @ptrCast(@alignCast(head_raw));
    const value = head.value;

    if (head.next) |next| {
        next.prev = null;
        self.head = next;
    } else {
        self.head = null;
        self.tail = null;
    }

    allocator.destroy(head);
    self.len -= 1;
    return value; // Caller owns the reference
}

fn deque_popright_internal(self: *DequeObject) ?*c.PyObject {
    const tail_raw = self.tail orelse return null;
    const tail: *DequeNode = @ptrCast(@alignCast(tail_raw));
    const value = tail.value;

    if (tail.prev) |prev| {
        prev.next = null;
        self.tail = prev;
    } else {
        self.head = null;
        self.tail = null;
    }

    allocator.destroy(tail);
    self.len -= 1;
    return value; // Caller owns the reference
}

fn deque_clear_internal(self: *DequeObject) void {
    while (self.head != null) {
        const val = deque_popleft_internal(self);
        if (val) |v| c.Py_DecRef(v);
    }
}

// Python-facing methods

fn py_deque_append(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    var value: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &value) == 0) return null;
    if (deque_append_right(self, value.?) != 0) return null;
    c.Py_IncRef(c.Py_None);
    return c.Py_None;
}

fn py_deque_appendleft(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    var value: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &value) == 0) return null;
    if (deque_append_left(self, value.?) != 0) return null;
    c.Py_IncRef(c.Py_None);
    return c.Py_None;
}

fn py_deque_pop(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    const val = deque_popright_internal(self) orelse {
        c.PyErr_SetString(c.PyExc_IndexError, "pop from an empty deque");
        return null;
    };
    return val; // Already has a reference
}

fn py_deque_popleft(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    const val = deque_popleft_internal(self) orelse {
        c.PyErr_SetString(c.PyExc_IndexError, "pop from an empty deque");
        return null;
    };
    return val;
}

fn py_deque_extend(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    var iterable: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &iterable) == 0) return null;

    const iter = c.PyObject_GetIter(iterable.?);
    if (iter == null) return null;
    defer c.Py_DecRef(iter);

    while (true) {
        const item = c.PyIter_Next(iter);
        if (item == null) {
            if (c.PyErr_Occurred() != null) return null;
            break;
        }
        if (deque_append_right(self, item) != 0) {
            c.Py_DecRef(item);
            return null;
        }
        c.Py_DecRef(item); // deque_append_right already incref'd
    }

    c.Py_IncRef(c.Py_None);
    return c.Py_None;
}

fn py_deque_extendleft(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    var iterable: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &iterable) == 0) return null;

    const iter = c.PyObject_GetIter(iterable.?);
    if (iter == null) return null;
    defer c.Py_DecRef(iter);

    while (true) {
        const item = c.PyIter_Next(iter);
        if (item == null) {
            if (c.PyErr_Occurred() != null) return null;
            break;
        }
        if (deque_append_left(self, item) != 0) {
            c.Py_DecRef(item);
            return null;
        }
        c.Py_DecRef(item);
    }

    c.Py_IncRef(c.Py_None);
    return c.Py_None;
}

fn py_deque_rotate(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    var n: c.Py_ssize_t = 1;
    if (c.PyArg_ParseTuple(args, "|n", &n) == 0) return null;

    if (self.len <= 1 or n == 0) {
        c.Py_IncRef(c.Py_None);
        return c.Py_None;
    }

    // Normalize n
    const len_i: c.Py_ssize_t = self.len;
    n = @mod(n, len_i);
    if (n == 0) {
        c.Py_IncRef(c.Py_None);
        return c.Py_None;
    }

    if (n > 0) {
        var i: c.Py_ssize_t = 0;
        while (i < n) : (i += 1) {
            const val = deque_popright_internal(self) orelse break;
            if (deque_append_left(self, val) != 0) {
                c.Py_DecRef(val);
                return null;
            }
            c.Py_DecRef(val); // append_left incref'd
        }
    } else {
        var i: c.Py_ssize_t = 0;
        while (i < -n) : (i += 1) {
            const val = deque_popleft_internal(self) orelse break;
            if (deque_append_right(self, val) != 0) {
                c.Py_DecRef(val);
                return null;
            }
            c.Py_DecRef(val);
        }
    }

    c.Py_IncRef(c.Py_None);
    return c.Py_None;
}

fn py_deque_clear(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    deque_clear_internal(self);
    c.Py_IncRef(c.Py_None);
    return c.Py_None;
}

fn py_deque_copy(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));

    const new_obj = c.PyType_GenericNew(&deque_type, null, null);
    if (new_obj == null) return null;
    const new_deque: *DequeObject = @ptrCast(@alignCast(new_obj));
    new_deque.head = null;
    new_deque.tail = null;
    new_deque.len = 0;
    new_deque.maxlen = self.maxlen;

    var node_raw = self.head;
    while (node_raw) |nr| {
        const node: *DequeNode = @ptrCast(@alignCast(nr));
        if (deque_append_right(new_deque, node.value) != 0) {
            deque_clear_internal(new_deque);
            c.Py_DecRef(new_obj);
            return null;
        }
        node_raw = node.next;
    }

    return new_obj;
}

fn py_deque_count(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    var value: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &value) == 0) return null;

    var count: c.Py_ssize_t = 0;
    var node_raw = self.head;
    while (node_raw) |nr| {
        const node: *DequeNode = @ptrCast(@alignCast(nr));
        const cmp = c.PyObject_RichCompareBool(node.value, value.?, c.Py_EQ);
        if (cmp < 0) return null;
        if (cmp == 1) count += 1;
        node_raw = node.next;
    }

    return c.PyLong_FromSsize_t(count);
}

fn py_deque_reverse(self_raw: ?*c.PyObject, _: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));

    var node_raw = self.head;
    while (node_raw) |nr| {
        const node: *DequeNode = @ptrCast(@alignCast(nr));
        const tmp = node.prev;
        node.prev = node.next;
        node.next = tmp;
        node_raw = node.prev; // Was next
    }
    const tmp = self.head;
    self.head = self.tail;
    self.tail = tmp;

    c.Py_IncRef(c.Py_None);
    return c.Py_None;
}

fn deque_len(self_raw: ?*c.PyObject) callconv(.C) c.Py_ssize_t {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    return self.len;
}

fn deque_getitem(self_raw: ?*c.PyObject, index: c.Py_ssize_t) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));

    var actual_idx = index;
    if (actual_idx < 0) actual_idx += self.len;
    if (actual_idx < 0 or actual_idx >= self.len) {
        c.PyErr_SetString(c.PyExc_IndexError, "deque index out of range");
        return null;
    }

    var node_raw = self.head;
    var i: c.Py_ssize_t = 0;
    while (node_raw) |nr| {
        const node: *DequeNode = @ptrCast(@alignCast(nr));
        if (i == actual_idx) {
            c.Py_IncRef(node.value);
            return node.value;
        }
        node_raw = node.next;
        i += 1;
    }

    c.PyErr_SetString(c.PyExc_IndexError, "deque index out of range");
    return null;
}

fn py_deque_index(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    var value: ?*c.PyObject = null;
    var start: c.Py_ssize_t = 0;
    var stop: c.Py_ssize_t = std.math.maxInt(c.Py_ssize_t);
    if (c.PyArg_ParseTuple(args, "O|nn", &value, &start, &stop) == 0) return null;

    if (start < 0) start += self.len;
    if (start < 0) start = 0;
    if (stop < 0) stop += self.len;
    if (stop > self.len) stop = self.len;

    var node_raw = self.head;
    var i: c.Py_ssize_t = 0;
    while (node_raw) |nr| {
        const node: *DequeNode = @ptrCast(@alignCast(nr));
        if (i >= start and i < stop) {
            const cmp = c.PyObject_RichCompareBool(node.value, value.?, c.Py_EQ);
            if (cmp < 0) return null;
            if (cmp == 1) return c.PyLong_FromSsize_t(i);
        }
        if (i >= stop) break;
        node_raw = node.next;
        i += 1;
    }

    c.PyErr_SetString(c.PyExc_ValueError, "deque.index(x): x not in deque");
    return null;
}

fn py_deque_remove(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    var value: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &value) == 0) return null;

    var node_raw = self.head;
    while (node_raw) |nr| {
        const node: *DequeNode = @ptrCast(@alignCast(nr));
        const cmp = c.PyObject_RichCompareBool(node.value, value.?, c.Py_EQ);
        if (cmp < 0) return null;
        if (cmp == 1) {
            // Unlink node
            if (node.prev) |prev| {
                prev.next = node.next;
            } else {
                self.head = node.next;
            }
            if (node.next) |next| {
                next.prev = node.prev;
            } else {
                self.tail = node.prev;
            }
            c.Py_DecRef(node.value);
            allocator.destroy(node);
            self.len -= 1;

            c.Py_IncRef(c.Py_None);
            return c.Py_None;
        }
        node_raw = node.next;
    }

    c.PyErr_SetString(c.PyExc_ValueError, "deque.remove(x): x not in deque");
    return null;
}

fn deque_bool(self_raw: ?*c.PyObject) callconv(.C) c_int {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    return if (self.len > 0) 1 else 0;
}

fn deque_iter(self_raw: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    // Build a list and return its iterator - this matches CPython's behavior
    // of providing a snapshot iterator that is not invalidated by mutations
    const list = c.PyList_New(self.len);
    if (list == null) return null;

    var node_raw = self.head;
    var i: c.Py_ssize_t = 0;
    while (node_raw) |nr| {
        const node: *DequeNode = @ptrCast(@alignCast(nr));
        c.Py_IncRef(node.value);
        _ = c.PyList_SetItem(list, i, node.value);
        node_raw = node.next;
        i += 1;
    }

    const iter = c.PyObject_GetIter(list);
    c.Py_DecRef(list);
    return iter;
}

fn deque_repr(self_raw: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));

    // Build list repr
    const list = c.PyList_New(self.len);
    if (list == null) return null;
    defer c.Py_DecRef(list);

    var node_raw = self.head;
    var i: c.Py_ssize_t = 0;
    while (node_raw) |nr| {
        const node: *DequeNode = @ptrCast(@alignCast(nr));
        c.Py_IncRef(node.value);
        _ = c.PyList_SetItem(list, i, node.value);
        node_raw = node.next;
        i += 1;
    }

    const list_repr = c.PyObject_Repr(list);
    if (list_repr == null) return null;
    defer c.Py_DecRef(list_repr);

    if (self.maxlen >= 0) {
        return c.PyUnicode_FromFormat("deque(%U, maxlen=%zd)", list_repr, self.maxlen);
    } else {
        return c.PyUnicode_FromFormat("deque(%U)", list_repr);
    }
}

fn deque_dealloc(self_raw: ?*c.PyObject) callconv(.C) void {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    deque_clear_internal(self);
    c.PyObject_Free(self_raw);
}

fn py_deque_maxlen_get(self_raw: ?*c.PyObject, _: ?*anyopaque) callconv(.C) ?*c.PyObject {
    const self: *DequeObject = @ptrCast(@alignCast(self_raw));
    if (self.maxlen < 0) {
        c.Py_IncRef(c.Py_None);
        return c.Py_None;
    }
    return c.PyLong_FromSsize_t(self.maxlen);
}

const deque_methods = [_]c.PyMethodDef{
    .{ .ml_name = "append", .ml_meth = @ptrCast(&py_deque_append), .ml_flags = c.METH_VARARGS, .ml_doc = "Add an element to the right side of the deque." },
    .{ .ml_name = "appendleft", .ml_meth = @ptrCast(&py_deque_appendleft), .ml_flags = c.METH_VARARGS, .ml_doc = "Add an element to the left side of the deque." },
    .{ .ml_name = "pop", .ml_meth = @ptrCast(&py_deque_pop), .ml_flags = c.METH_NOARGS, .ml_doc = "Remove and return an element from the right side of the deque." },
    .{ .ml_name = "popleft", .ml_meth = @ptrCast(&py_deque_popleft), .ml_flags = c.METH_NOARGS, .ml_doc = "Remove and return an element from the left side of the deque." },
    .{ .ml_name = "extend", .ml_meth = @ptrCast(&py_deque_extend), .ml_flags = c.METH_VARARGS, .ml_doc = "Extend the right side of the deque with elements from the iterable." },
    .{ .ml_name = "extendleft", .ml_meth = @ptrCast(&py_deque_extendleft), .ml_flags = c.METH_VARARGS, .ml_doc = "Extend the left side of the deque with elements from the iterable." },
    .{ .ml_name = "rotate", .ml_meth = @ptrCast(&py_deque_rotate), .ml_flags = c.METH_VARARGS, .ml_doc = "Rotate the deque n steps to the right (default n=1)." },
    .{ .ml_name = "clear", .ml_meth = @ptrCast(&py_deque_clear), .ml_flags = c.METH_NOARGS, .ml_doc = "Remove all elements from the deque." },
    .{ .ml_name = "copy", .ml_meth = @ptrCast(&py_deque_copy), .ml_flags = c.METH_NOARGS, .ml_doc = "Return a shallow copy of a deque." },
    .{ .ml_name = "count", .ml_meth = @ptrCast(&py_deque_count), .ml_flags = c.METH_VARARGS, .ml_doc = "D.count(value) -> integer -- return number of occurrences of value" },
    .{ .ml_name = "index", .ml_meth = @ptrCast(&py_deque_index), .ml_flags = c.METH_VARARGS, .ml_doc = "D.index(value, [start, [stop]]) -> integer -- return first index of value." },
    .{ .ml_name = "remove", .ml_meth = @ptrCast(&py_deque_remove), .ml_flags = c.METH_VARARGS, .ml_doc = "D.remove(value) -- remove first occurrence of value." },
    .{ .ml_name = "reverse", .ml_meth = @ptrCast(&py_deque_reverse), .ml_flags = c.METH_NOARGS, .ml_doc = "D.reverse() -- reverse *IN PLACE*" },
    // Sentinel
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

const deque_getset = [_]c.PyGetSetDef{
    .{ .name = "maxlen", .get = @ptrCast(&py_deque_maxlen_get), .set = null, .doc = "Maximum size of a deque or None if unbounded.", .closure = null },
    .{ .name = null, .get = null, .set = null, .doc = null, .closure = null },
};

var deque_as_sequence: c.PySequenceMethods = blk: {
    var s = std.mem.zeroes(c.PySequenceMethods);
    s.sq_length = @ptrCast(&deque_len);
    s.sq_item = @ptrCast(&deque_getitem);
    break :blk s;
};

var deque_as_number: c.PyNumberMethods = blk: {
    var n = std.mem.zeroes(c.PyNumberMethods);
    n.nb_bool = @ptrCast(&deque_bool);
    break :blk n;
};

var deque_type: c.PyTypeObject = blk: {
    var t: c.PyTypeObject = std.mem.zeroes(c.PyTypeObject);
    t.tp_name = "collections.deque";
    t.tp_basicsize = @sizeOf(DequeObject);
    t.tp_flags = c.Py_TPFLAGS_DEFAULT | c.Py_TPFLAGS_BASETYPE;
    t.tp_doc = "deque([iterable[, maxlen]]) --> deque object\n\nA list-like sequence optimized for data accesses near its endpoints.";
    t.tp_init = @ptrCast(&deque_init);
    t.tp_dealloc = @ptrCast(&deque_dealloc);
    t.tp_repr = @ptrCast(&deque_repr);
    t.tp_iter = @ptrCast(&deque_iter);
    t.tp_methods = @constCast(&deque_methods);
    t.tp_getset = @constCast(&deque_getset);
    t.tp_as_sequence = &deque_as_sequence;
    t.tp_as_number = &deque_as_number;
    t.tp_new = c.PyType_GenericNew;
    break :blk t;
};

// ============================================================================
// DEFAULTDICT - dict subclass with default factory for missing keys
// ============================================================================

const DefaultDictObject = extern struct {
    ob_base: c.PyObject, // PyDictObject base (inherits from dict)
    default_factory: ?*c.PyObject,
};

fn defaultdict_init(self_raw: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.C) c_int {
    // Extract first positional arg as default_factory, pass rest to dict.__init__
    var factory: ?*c.PyObject = null;

    const nargs = if (args != null) c.PyTuple_Size(args) else 0;
    if (nargs > 0) {
        factory = c.PyTuple_GetItem(args, 0);
        if (factory != null and factory == c.Py_None) {
            factory = null;
        }
    }

    // Store factory as an attribute on the instance
    if (factory) |f| {
        c.Py_IncRef(f);
        _ = c.PyObject_SetAttrString(self_raw, "_default_factory_attr", f);
    }

    // Call dict.__init__ with remaining positional args and kwargs
    if (nargs > 1) {
        const remaining = c.PyTuple_GetSlice(args, 1, nargs);
        if (remaining == null) return -1;
        defer c.Py_DecRef(remaining);
        if (c.PyDict_Type.tp_init.?(self_raw, remaining, kwargs) != 0) return -1;
    } else if (kwargs != null) {
        const empty_tuple = c.PyTuple_New(0);
        if (empty_tuple == null) return -1;
        defer c.Py_DecRef(empty_tuple);
        if (c.PyDict_Type.tp_init.?(self_raw, empty_tuple, kwargs) != 0) return -1;
    }

    return 0;
}

fn defaultdict_missing(self_raw: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    var key: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &key) == 0) return null;

    const factory = c.PyObject_GetAttrString(self_raw, "_default_factory_attr");
    if (factory == null or factory == c.Py_None) {
        _ = c.PyErr_Clear();
        c.PyErr_SetObject(c.PyExc_KeyError, key.?);
        return null;
    }
    defer c.Py_DecRef(factory);

    const value = c.PyObject_CallNoArgs(factory);
    if (value == null) return null;

    if (c.PyDict_SetItem(self_raw, key.?, value) < 0) {
        c.Py_DecRef(value);
        return null;
    }

    return value;
}

fn defaultdict_repr(self_raw: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const factory = c.PyObject_GetAttrString(self_raw, "_default_factory_attr");
    const factory_repr = if (factory != null) c.PyObject_Repr(factory) else c.PyUnicode_FromString("None");
    if (factory) |f| c.Py_DecRef(f);
    if (factory_repr == null) return null;
    defer c.Py_DecRef(factory_repr);

    const dict_repr = c.PyDict_Type.tp_repr.?(self_raw);
    if (dict_repr == null) return null;
    defer c.Py_DecRef(dict_repr);

    return c.PyUnicode_FromFormat("defaultdict(%U, %U)", factory_repr, dict_repr);
}

const defaultdict_methods = [_]c.PyMethodDef{
    .{ .ml_name = "__missing__", .ml_meth = @ptrCast(&defaultdict_missing), .ml_flags = c.METH_VARARGS, .ml_doc = "Called by __getitem__ for missing key; creates default value via default_factory." },
    // Sentinel
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var defaultdict_type: c.PyTypeObject = blk: {
    var t: c.PyTypeObject = std.mem.zeroes(c.PyTypeObject);
    t.tp_name = "collections.defaultdict";
    t.tp_basicsize = @sizeOf(c.PyObject); // Inherits dict size
    t.tp_flags = c.Py_TPFLAGS_DEFAULT | c.Py_TPFLAGS_BASETYPE;
    t.tp_doc = "defaultdict(default_factory[, ...]) --> dict with default factory\n\nThe default factory is called without arguments to produce a new value when a key is not present.";
    t.tp_init = @ptrCast(&defaultdict_init);
    t.tp_repr = @ptrCast(&defaultdict_repr);
    t.tp_methods = @constCast(&defaultdict_methods);
    t.tp_base = &c.PyDict_Type;
    t.tp_new = c.PyType_GenericNew;
    break :blk t;
};

// ============================================================================
// _count_elements helper (used internally by collections.Counter)
// ============================================================================

fn py_count_elements(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    var mapping: ?*c.PyObject = null;
    var iterable: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "OO", &mapping, &iterable) == 0) return null;

    const iter = c.PyObject_GetIter(iterable.?);
    if (iter == null) return null;
    defer c.Py_DecRef(iter);

    while (true) {
        const elem = c.PyIter_Next(iter);
        if (elem == null) {
            if (c.PyErr_Occurred() != null) return null;
            break;
        }
        defer c.Py_DecRef(elem);

        // Get current count
        var count = c.PyObject_GetItem(mapping.?, elem);
        if (count == null) {
            _ = c.PyErr_Clear();
            count = c.PyLong_FromLong(0);
        }
        if (count == null) return null;

        // Increment
        const one = c.PyLong_FromLong(1);
        if (one == null) {
            c.Py_DecRef(count);
            return null;
        }
        const new_count = c.PyNumber_Add(count, one);
        c.Py_DecRef(count);
        c.Py_DecRef(one);
        if (new_count == null) return null;

        // Store back
        if (c.PyObject_SetItem(mapping.?, elem, new_count) < 0) {
            c.Py_DecRef(new_count);
            return null;
        }
        c.Py_DecRef(new_count);
    }

    c.Py_IncRef(c.Py_None);
    return c.Py_None;
}

// ============================================================================
// MODULE DEFINITION
// ============================================================================

const module_methods = [_]c.PyMethodDef{
    .{
        .ml_name = "_count_elements",
        .ml_meth = @ptrCast(&py_count_elements),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "_count_elements(mapping, iterable) -> None\n\nCount elements in iterable, updating mapping.",
    },
    // Sentinel
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var module_def = c.PyModuleDef{
    .m_base = c.PyModuleDef_HEAD_INIT,
    .m_name = "_collections",
    .m_doc = "High-performance container datatypes - Zig implementation replacing _collectionsmodule.c",
    .m_size = -1,
    .m_methods = @constCast(&module_methods),
    .m_slots = null,
    .m_traverse = null,
    .m_clear = null,
    .m_free = null,
};

/// CPython module init entry point.
export fn PyInit__collections() ?*c.PyObject {
    if (c.PyType_Ready(&deque_type) < 0) return null;
    if (c.PyType_Ready(&defaultdict_type) < 0) return null;

    const module = c.PyModule_Create(&module_def);
    if (module == null) return null;

    // Add deque type
    c.Py_IncRef(@ptrCast(&deque_type));
    if (c.PyModule_AddObject(module, "deque", @ptrCast(&deque_type)) < 0) {
        c.Py_DecRef(@ptrCast(&deque_type));
        c.Py_DecRef(module);
        return null;
    }

    // Add defaultdict type
    c.Py_IncRef(@ptrCast(&defaultdict_type));
    if (c.PyModule_AddObject(module, "defaultdict", @ptrCast(&defaultdict_type)) < 0) {
        c.Py_DecRef(@ptrCast(&defaultdict_type));
        c.Py_DecRef(module);
        return null;
    }

    return module;
}
