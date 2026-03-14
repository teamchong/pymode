///! zerobuf — Zig-side library for reading/writing zerobuf binary layout.
///!
///! Both JS and Zig agree on the same memory layout:
///!   - Tagged values: 16-byte slots (1 byte tag + padding + payload)
///!   - Objects: 8-byte header (capacity u32 + count u32) + entries (24 bytes each)
///!   - Arrays: 8-byte header (capacity u32 + length u32) + value slots
///!   - Strings: 4-byte header (byteLength u32) + UTF-8 bytes
///!   - Handles: 4-byte pointer cell for indirection (survives realloc)

const std = @import("std");

// ---------------------------------------------------------------------------
// Memory layout constants — must match src/types.ts
// ---------------------------------------------------------------------------

pub const VALUE_SLOT: u32 = 16;
pub const STRING_HEADER: u32 = 4;
pub const ARRAY_HEADER: u32 = 8;
pub const OBJECT_HEADER: u32 = 8;
pub const OBJECT_ENTRY: u32 = 8 + VALUE_SLOT; // 24 bytes: keyPtr(4) + keyLen(4) + value(16)

pub const Tag = enum(u8) {
    null = 0,
    bool = 1,
    i32 = 2,
    f64 = 3,
    string = 4,
    array = 5,
    object = 6,
    bigint = 7,
    bytes = 8,
};

// ---------------------------------------------------------------------------
// Value — a tagged value read from a 16-byte slot
// ---------------------------------------------------------------------------

pub const Value = union(enum) {
    null,
    bool: bool,
    i32: i32,
    f64: f64,
    string: []const u8,
    array: ArrayReader,
    object: ObjectReader,
    bigint: i64,
    bytes: []const u8,
};

// ---------------------------------------------------------------------------
// Memory view — reads from a byte slice (WASM linear memory)
// ---------------------------------------------------------------------------

fn readU32(mem: []const u8, offset: u32) u32 {
    const bytes = mem[offset..][0..4];
    return std.mem.readInt(u32, bytes, .little);
}

fn readI32(mem: []const u8, offset: u32) i32 {
    const bytes = mem[offset..][0..4];
    return std.mem.readInt(i32, bytes, .little);
}

fn readI64(mem: []const u8, offset: u32) i64 {
    const bytes = mem[offset..][0..8];
    return std.mem.readInt(i64, bytes, .little);
}

fn readF64(mem: []const u8, offset: u32) f64 {
    const bytes = mem[offset..][0..8];
    return @bitCast(std.mem.readInt(u64, bytes, .little));
}

fn writeU32(mem: []u8, offset: u32, value: u32) void {
    const bytes = mem[offset..][0..4];
    std.mem.writeInt(u32, bytes, value, .little);
}

fn writeI32(mem: []u8, offset: u32, value: i32) void {
    const bytes = mem[offset..][0..4];
    std.mem.writeInt(i32, bytes, value, .little);
}

fn writeI64(mem: []u8, offset: u32, value: i64) void {
    const bytes = mem[offset..][0..8];
    std.mem.writeInt(i64, bytes, value, .little);
}

fn writeF64(mem: []u8, offset: u32, value: f64) void {
    const bytes = mem[offset..][0..8];
    std.mem.writeInt(u64, bytes, @bitCast(value), .little);
}

fn writeU8(mem: []u8, offset: u32, value: u8) void {
    mem[offset] = value;
}

// ---------------------------------------------------------------------------
// Dereference a handle — read data pointer from handle cell
// ---------------------------------------------------------------------------

fn deref(mem: []const u8, handle_ptr: u32) u32 {
    return readU32(mem, handle_ptr);
}

// ---------------------------------------------------------------------------
// Read a tagged value at a 16-byte slot offset
// ---------------------------------------------------------------------------

pub fn readValue(mem: []const u8, offset: u32) Value {
    const tag: Tag = @enumFromInt(mem[offset]);
    return switch (tag) {
        .null => .null,
        .bool => .{ .bool = readU32(mem, offset + 4) != 0 },
        .i32 => .{ .i32 = readI32(mem, offset + 4) },
        .f64 => .{ .f64 = readF64(mem, offset + 8) },
        .bigint => .{ .bigint = readI64(mem, offset + 8) },
        .string => .{ .string = readString(mem, readU32(mem, offset + 4)) },
        .bytes => .{ .bytes = readBytesSlice(mem, readU32(mem, offset + 4)) },
        .array => .{ .array = ArrayReader.init(mem, readU32(mem, offset + 4)) },
        .object => .{ .object = ObjectReader.init(mem, readU32(mem, offset + 4)) },
    };
}

// ---------------------------------------------------------------------------
// Write a tagged value at a 16-byte slot offset
// ---------------------------------------------------------------------------

pub fn writeNull(mem: []u8, offset: u32) void {
    writeU8(mem, offset, @intFromEnum(Tag.null));
}

pub fn writeBool(mem: []u8, offset: u32, value: bool) void {
    writeU8(mem, offset, @intFromEnum(Tag.bool));
    writeU32(mem, offset + 4, if (value) 1 else 0);
}

pub fn writeI32Val(mem: []u8, offset: u32, value: i32) void {
    writeU8(mem, offset, @intFromEnum(Tag.i32));
    writeI32(mem, offset + 4, value);
}

pub fn writeF64Val(mem: []u8, offset: u32, value: f64) void {
    writeU8(mem, offset, @intFromEnum(Tag.f64));
    writeF64(mem, offset + 8, value);
}

pub fn writeBigInt(mem: []u8, offset: u32, value: i64) void {
    writeU8(mem, offset, @intFromEnum(Tag.bigint));
    writeI64(mem, offset + 8, value);
}

pub fn writeBytesRef(mem: []u8, offset: u32, bytes_ptr: u32) void {
    writeU8(mem, offset, @intFromEnum(Tag.bytes));
    writeU32(mem, offset + 4, bytes_ptr);
}

pub fn writeStringRef(mem: []u8, offset: u32, string_ptr: u32) void {
    writeU8(mem, offset, @intFromEnum(Tag.string));
    writeU32(mem, offset + 4, string_ptr);
}

pub fn writeArrayRef(mem: []u8, offset: u32, handle_ptr: u32) void {
    writeU8(mem, offset, @intFromEnum(Tag.array));
    writeU32(mem, offset + 4, handle_ptr);
}

pub fn writeObjectRef(mem: []u8, offset: u32, handle_ptr: u32) void {
    writeU8(mem, offset, @intFromEnum(Tag.object));
    writeU32(mem, offset + 4, handle_ptr);
}

// ---------------------------------------------------------------------------
// Read a string from its header pointer
// ---------------------------------------------------------------------------

pub fn readString(mem: []const u8, ptr: u32) []const u8 {
    const byte_len = readU32(mem, ptr);
    const start = ptr + STRING_HEADER;
    return mem[start .. start + byte_len];
}

/// Read raw bytes from a bytes header pointer. Same layout as string (length-prefixed).
pub fn readBytesSlice(mem: []const u8, ptr: u32) []const u8 {
    const byte_len = readU32(mem, ptr);
    const start = ptr + STRING_HEADER;
    return mem[start .. start + byte_len];
}

// ---------------------------------------------------------------------------
// ArrayReader — reads elements from an array in WASM memory
// ---------------------------------------------------------------------------

pub const ArrayReader = struct {
    mem: []const u8,
    handle_ptr: u32,

    pub fn init(mem: []const u8, handle_ptr: u32) ArrayReader {
        return .{ .mem = mem, .handle_ptr = handle_ptr };
    }

    fn dataPtr(self: ArrayReader) u32 {
        return deref(self.mem, self.handle_ptr);
    }

    pub fn len(self: ArrayReader) u32 {
        return readU32(self.mem, self.dataPtr() + 4);
    }

    pub fn capacity(self: ArrayReader) u32 {
        return readU32(self.mem, self.dataPtr());
    }

    pub fn get(self: ArrayReader, index: u32) Value {
        const dp = self.dataPtr();
        const length = readU32(self.mem, dp + 4);
        if (index >= length) return .null;
        return readValue(self.mem, dp + ARRAY_HEADER + index * VALUE_SLOT);
    }
};

// ---------------------------------------------------------------------------
// ObjectReader — reads properties from an object in WASM memory
// ---------------------------------------------------------------------------

pub const ObjectReader = struct {
    mem: []const u8,
    handle_ptr: u32,

    pub fn init(mem: []const u8, handle_ptr: u32) ObjectReader {
        return .{ .mem = mem, .handle_ptr = handle_ptr };
    }

    fn dataPtr(self: ObjectReader) u32 {
        return deref(self.mem, self.handle_ptr);
    }

    pub fn count(self: ObjectReader) u32 {
        return readU32(self.mem, self.dataPtr() + 4);
    }

    /// Find a property by key name. Returns the entry offset or null.
    pub fn findEntry(self: ObjectReader, key: []const u8) ?u32 {
        const dp = self.dataPtr();
        const cnt = readU32(self.mem, dp + 4);

        for (0..cnt) |i| {
            const entry_offset = dp + OBJECT_HEADER + @as(u32, @intCast(i)) * OBJECT_ENTRY;
            const key_ptr = readU32(self.mem, entry_offset);
            const key_len = readU32(self.mem, entry_offset + 4);

            if (key_len != key.len) continue;

            const stored = self.mem[key_ptr .. key_ptr + key_len];
            if (std.mem.eql(u8, stored, key)) return entry_offset;
        }
        return null;
    }

    /// Get a property value by key. Returns null if not found.
    pub fn get(self: ObjectReader, key: []const u8) Value {
        const entry = self.findEntry(key) orelse return .null;
        return readValue(self.mem, entry + 8);
    }

    /// Get f64 property. Returns null if not found or wrong type.
    pub fn getF64(self: ObjectReader, key: []const u8) ?f64 {
        return switch (self.get(key)) {
            .f64 => |v| v,
            .i32 => |v| @floatFromInt(v),
            else => null,
        };
    }

    /// Get i32 property. Returns null if not found or wrong type.
    pub fn getI32(self: ObjectReader, key: []const u8) ?i32 {
        return switch (self.get(key)) {
            .i32 => |v| v,
            else => null,
        };
    }

    /// Get bool property. Returns null if not found or wrong type.
    pub fn getBool(self: ObjectReader, key: []const u8) ?bool {
        return switch (self.get(key)) {
            .bool => |v| v,
            else => null,
        };
    }

    /// Get string property. Returns null if not found or wrong type.
    pub fn getString(self: ObjectReader, key: []const u8) ?[]const u8 {
        return switch (self.get(key)) {
            .string => |v| v,
            else => null,
        };
    }

    /// Get bigint (i64) property. Returns null if not found or wrong type.
    pub fn getI64(self: ObjectReader, key: []const u8) ?i64 {
        return switch (self.get(key)) {
            .bigint => |v| v,
            .i32 => |v| @as(i64, v),
            else => null,
        };
    }

    /// Get bytes property. Returns null if not found or wrong type.
    pub fn getBytes(self: ObjectReader, key: []const u8) ?[]const u8 {
        return switch (self.get(key)) {
            .bytes => |v| v,
            else => null,
        };
    }

    /// Get the i-th key name.
    pub fn keyAt(self: ObjectReader, index: u32) ?[]const u8 {
        const dp = self.dataPtr();
        const cnt = readU32(self.mem, dp + 4);
        if (index >= cnt) return null;
        const entry_offset = dp + OBJECT_HEADER + index * OBJECT_ENTRY;
        const key_ptr = readU32(self.mem, entry_offset);
        const key_len = readU32(self.mem, entry_offset + 4);
        return self.mem[key_ptr .. key_ptr + key_len];
    }
};

// ---------------------------------------------------------------------------
// ObjectWriter — writes properties into an object in WASM memory (mutable)
// ---------------------------------------------------------------------------

pub const ObjectWriter = struct {
    mem: []u8,
    handle_ptr: u32,

    pub fn init(mem: []u8, handle_ptr: u32) ObjectWriter {
        return .{ .mem = mem, .handle_ptr = handle_ptr };
    }

    fn dataPtr(self: ObjectWriter) u32 {
        return deref(self.mem, self.handle_ptr);
    }

    /// Find entry offset for a key, or null if not found.
    pub fn findEntry(self: ObjectWriter, key: []const u8) ?u32 {
        const reader = ObjectReader{ .mem = self.mem, .handle_ptr = self.handle_ptr };
        return reader.findEntry(key);
    }

    /// Set f64 value for an existing key. Returns false if key not found.
    pub fn setF64(self: ObjectWriter, key: []const u8, value: f64) bool {
        const entry = self.findEntry(key) orelse return false;
        writeF64Val(self.mem, entry + 8, value);
        return true;
    }

    /// Set i32 value for an existing key. Returns false if key not found.
    pub fn setI32(self: ObjectWriter, key: []const u8, value: i32) bool {
        const entry = self.findEntry(key) orelse return false;
        writeI32Val(self.mem, entry + 8, value);
        return true;
    }

    /// Set bool value for an existing key. Returns false if key not found.
    pub fn setBool(self: ObjectWriter, key: []const u8, value: bool) bool {
        const entry = self.findEntry(key) orelse return false;
        writeBool(self.mem, entry + 8, value);
        return true;
    }

    /// Set i64 value for an existing key. Returns false if key not found.
    pub fn setI64(self: ObjectWriter, key: []const u8, value: i64) bool {
        const entry = self.findEntry(key) orelse return false;
        writeBigInt(self.mem, entry + 8, value);
        return true;
    }

    /// Set null for an existing key. Returns false if key not found.
    pub fn setNull(self: ObjectWriter, key: []const u8) bool {
        const entry = self.findEntry(key) orelse return false;
        writeNull(self.mem, entry + 8);
        return true;
    }
};

// ---------------------------------------------------------------------------
// C ABI exports — usable from Go (cgo), Rust (extern "C"), Python (ctypes),
// or any language with C FFI. Also usable from WASM via linked object.
//
// All functions take a memory pointer + length as the first two args,
// so callers control which memory region is accessed.
// ---------------------------------------------------------------------------

/// Get the tag byte at a value slot offset.
pub export fn zerobuf_tag(mem: [*]const u8, offset: u32) u8 {
    return mem[offset];
}

/// Read an i32 from a tagged value slot. Returns 0 if wrong type.
pub export fn zerobuf_read_i32(mem: [*]const u8, offset: u32) i32 {
    if (mem[offset] != @intFromEnum(Tag.i32)) return 0;
    return readI32(mem[0..offset + VALUE_SLOT], offset + 4);
}

/// Read an f64 from a tagged value slot. Returns 0 if wrong type.
pub export fn zerobuf_read_f64(mem: [*]const u8, offset: u32) f64 {
    if (mem[offset] != @intFromEnum(Tag.f64)) return 0;
    return readF64(mem[0..offset + VALUE_SLOT], offset + 8);
}

/// Read an i64 (bigint) from a tagged value slot. Returns 0 if wrong type.
pub export fn zerobuf_read_i64(mem: [*]const u8, offset: u32) i64 {
    if (mem[offset] != @intFromEnum(Tag.bigint)) return 0;
    return readI64(mem[0..offset + VALUE_SLOT], offset + 8);
}

/// Read a bool from a tagged value slot. Returns 0 if wrong type.
pub export fn zerobuf_read_bool(mem: [*]const u8, offset: u32) u32 {
    if (mem[offset] != @intFromEnum(Tag.bool)) return 0;
    return readU32(mem[0..offset + VALUE_SLOT], offset + 4);
}

/// Write an i32 tagged value.
pub export fn zerobuf_write_i32(mem: [*]u8, offset: u32, value: i32) void {
    writeI32Val(mem[0..offset + VALUE_SLOT], offset, value);
}

/// Write an f64 tagged value.
pub export fn zerobuf_write_f64(mem: [*]u8, offset: u32, value: f64) void {
    writeF64Val(mem[0..offset + VALUE_SLOT], offset, value);
}

/// Write an i64 (bigint) tagged value.
pub export fn zerobuf_write_i64(mem: [*]u8, offset: u32, value: i64) void {
    writeBigInt(mem[0..offset + VALUE_SLOT], offset, value);
}

/// Write a bool tagged value.
pub export fn zerobuf_write_bool(mem: [*]u8, offset: u32, value: u32) void {
    writeBool(mem[0..offset + VALUE_SLOT], offset, value != 0);
}

/// Write a null tagged value.
pub export fn zerobuf_write_null(mem: [*]u8, offset: u32) void {
    writeNull(mem[0..offset + VALUE_SLOT], offset);
}

/// Read string/bytes length from a header pointer.
pub export fn zerobuf_read_len(mem: [*]const u8, header_ptr: u32) u32 {
    return readU32(mem[0..header_ptr + 4], header_ptr);
}

/// Read string/bytes data pointer (header_ptr + 4).
pub export fn zerobuf_read_data_ptr(header_ptr: u32) u32 {
    return header_ptr + STRING_HEADER;
}

/// Dereference a handle — returns the data pointer stored in a handle cell.
pub export fn zerobuf_deref(mem: [*]const u8, handle_ptr: u32) u32 {
    return readU32(mem[0..handle_ptr + 4], handle_ptr);
}

/// Get array length from a handle pointer.
pub export fn zerobuf_array_len(mem: [*]const u8, handle_ptr: u32) u32 {
    const data_ptr = readU32(mem[0..handle_ptr + 4], handle_ptr);
    return readU32(mem[0..data_ptr + 8], data_ptr + 4);
}

/// Get array element offset (for reading with zerobuf_read_* functions).
pub export fn zerobuf_array_element_offset(mem: [*]const u8, handle_ptr: u32, index: u32) u32 {
    const data_ptr = readU32(mem[0..handle_ptr + 4], handle_ptr);
    return data_ptr + ARRAY_HEADER + index * VALUE_SLOT;
}

/// Get object property count from a handle pointer.
pub export fn zerobuf_object_count(mem: [*]const u8, handle_ptr: u32) u32 {
    const data_ptr = readU32(mem[0..handle_ptr + 4], handle_ptr);
    return readU32(mem[0..data_ptr + 8], data_ptr + 4);
}

/// Find an object property by key. Returns the value slot offset, or 0xFFFFFFFF if not found.
pub export fn zerobuf_object_find(mem: [*]const u8, mem_len: u32, handle_ptr: u32, key: [*]const u8, key_len: u32) u32 {
    const slice = mem[0..mem_len];
    const obj = ObjectReader.init(slice, handle_ptr);
    const entry = obj.findEntry(key[0..key_len]) orelse return 0xFFFFFFFF;
    return entry + 8; // value slot starts 8 bytes into the entry
}

/// Read f64 from an object property by key. Returns 0 if not found.
pub export fn zerobuf_object_get_f64(mem: [*]const u8, mem_len: u32, handle_ptr: u32, key: [*]const u8, key_len: u32) f64 {
    const slice = mem[0..mem_len];
    const obj = ObjectReader.init(slice, handle_ptr);
    return obj.getF64(key[0..key_len]) orelse 0;
}

/// Read i32 from an object property by key. Returns 0 if not found.
pub export fn zerobuf_object_get_i32(mem: [*]const u8, mem_len: u32, handle_ptr: u32, key: [*]const u8, key_len: u32) i32 {
    const slice = mem[0..mem_len];
    const obj = ObjectReader.init(slice, handle_ptr);
    return obj.getI32(key[0..key_len]) orelse 0;
}

/// Read i64 from an object property by key. Returns 0 if not found.
pub export fn zerobuf_object_get_i64(mem: [*]const u8, mem_len: u32, handle_ptr: u32, key: [*]const u8, key_len: u32) i64 {
    const slice = mem[0..mem_len];
    const obj = ObjectReader.init(slice, handle_ptr);
    return obj.getI64(key[0..key_len]) orelse 0;
}

/// Read string pointer + length from an object property by key.
/// Returns the string data pointer, writes length to out_len. Returns 0 if not found.
pub export fn zerobuf_object_get_string(mem: [*]const u8, mem_len: u32, handle_ptr: u32, key: [*]const u8, key_len: u32, out_len: *u32) u32 {
    const slice = mem[0..mem_len];
    const obj = ObjectReader.init(slice, handle_ptr);
    const str = obj.getString(key[0..key_len]) orelse {
        out_len.* = 0;
        return 0;
    };
    out_len.* = @intCast(str.len);
    return @intCast(@intFromPtr(str.ptr) - @intFromPtr(mem));
}

/// Write f64 to an object property by key. Returns 1 on success, 0 if key not found.
pub export fn zerobuf_object_set_f64(mem: [*]u8, mem_len: u32, handle_ptr: u32, key: [*]const u8, key_len: u32, value: f64) u32 {
    const slice = mem[0..mem_len];
    var writer = ObjectWriter.init(slice, handle_ptr);
    return if (writer.setF64(key[0..key_len], value)) 1 else 0;
}

/// Write i32 to an object property by key. Returns 1 on success, 0 if key not found.
pub export fn zerobuf_object_set_i32(mem: [*]u8, mem_len: u32, handle_ptr: u32, key: [*]const u8, key_len: u32, value: i32) u32 {
    const slice = mem[0..mem_len];
    var writer = ObjectWriter.init(slice, handle_ptr);
    return if (writer.setI32(key[0..key_len], value)) 1 else 0;
}

/// Write i64 to an object property by key. Returns 1 on success, 0 if key not found.
pub export fn zerobuf_object_set_i64(mem: [*]u8, mem_len: u32, handle_ptr: u32, key: [*]const u8, key_len: u32, value: i64) u32 {
    const slice = mem[0..mem_len];
    var writer = ObjectWriter.init(slice, handle_ptr);
    return if (writer.setI64(key[0..key_len], value)) 1 else 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "read/write f64 value" {
    var mem: [32]u8 = undefined;
    @memset(&mem, 0);

    writeF64Val(&mem, 0, 3.14);
    const val = readValue(&mem, 0);
    try std.testing.expectApproxEqAbs(@as(f64, 3.14), val.f64, 0.001);
}

test "read/write i32 value" {
    var mem: [32]u8 = undefined;
    @memset(&mem, 0);

    writeI32Val(&mem, 0, 42);
    const val = readValue(&mem, 0);
    try std.testing.expectEqual(@as(i32, 42), val.i32);
}

test "read/write bool value" {
    var mem: [32]u8 = undefined;
    @memset(&mem, 0);

    writeBool(&mem, 0, true);
    const val = readValue(&mem, 0);
    try std.testing.expect(val.bool);
}

test "read/write null value" {
    var mem: [32]u8 = undefined;
    @memset(&mem, 0);

    writeNull(&mem, 0);
    const val = readValue(&mem, 0);
    try std.testing.expectEqual(Value.null, val);
}

test "read string" {
    // Layout: string header at offset 0 = [5, 0, 0, 0] + "hello"
    var mem: [32]u8 = undefined;
    @memset(&mem, 0);

    // Write string header: length = 5
    writeU32(&mem, 0, 5);
    // Write string bytes
    @memcpy(mem[4..9], "hello");

    const s = readString(&mem, 0);
    try std.testing.expectEqualStrings("hello", s);
}

test "read object property" {
    // Build a minimal object in memory:
    // Handle at offset 0: points to data at offset 4
    // Data at offset 4: capacity=4, count=1
    // Entry at offset 12: keyPtr, keyLen, value (16-byte slot)
    // Key "x" at offset 36
    var mem: [64]u8 = undefined;
    @memset(&mem, 0);

    const handle_ptr: u32 = 0;
    const data_ptr: u32 = 4;
    const entry_start: u32 = data_ptr + OBJECT_HEADER; // 12
    const key_data: u32 = entry_start + OBJECT_ENTRY; // 36

    // Handle → data
    writeU32(&mem, handle_ptr, data_ptr);
    // Data header: capacity=4, count=1
    writeU32(&mem, data_ptr, 4);
    writeU32(&mem, data_ptr + 4, 1);
    // Entry: keyPtr, keyLen
    writeU32(&mem, entry_start, key_data);
    writeU32(&mem, entry_start + 4, 1); // "x" is 1 byte
    // Entry value: f64 = 3.14
    writeF64Val(&mem, entry_start + 8, 3.14);
    // Key bytes
    mem[key_data] = 'x';

    const obj = ObjectReader.init(&mem, handle_ptr);
    try std.testing.expectEqual(@as(u32, 1), obj.count());

    const val = obj.getF64("x") orelse unreachable;
    try std.testing.expectApproxEqAbs(@as(f64, 3.14), val, 0.001);
    try std.testing.expectEqual(@as(?[]const u8, null), obj.getString("y"));
}

test "write object property" {
    var mem: [64]u8 = undefined;
    @memset(&mem, 0);

    const handle_ptr: u32 = 0;
    const data_ptr: u32 = 4;
    const entry_start: u32 = data_ptr + OBJECT_HEADER;
    const key_data: u32 = entry_start + OBJECT_ENTRY;

    writeU32(&mem, handle_ptr, data_ptr);
    writeU32(&mem, data_ptr, 4);
    writeU32(&mem, data_ptr + 4, 1);
    writeU32(&mem, entry_start, key_data);
    writeU32(&mem, entry_start + 4, 1);
    writeF64Val(&mem, entry_start + 8, 1.0);
    mem[key_data] = 'x';

    var writer = ObjectWriter.init(&mem, handle_ptr);
    try std.testing.expect(writer.setF64("x", 99.0));

    const reader = ObjectReader.init(&mem, handle_ptr);
    const val = reader.getF64("x") orelse unreachable;
    try std.testing.expectApproxEqAbs(@as(f64, 99.0), val, 0.001);
}

test "read/write bigint (i64) value" {
    var mem: [32]u8 = undefined;
    @memset(&mem, 0);

    writeBigInt(&mem, 0, 9223372036854775807);
    const val = readValue(&mem, 0);
    try std.testing.expectEqual(@as(i64, 9223372036854775807), val.bigint);
}

test "read/write negative bigint" {
    var mem: [32]u8 = undefined;
    @memset(&mem, 0);

    writeBigInt(&mem, 0, -9223372036854775808);
    const val = readValue(&mem, 0);
    try std.testing.expectEqual(@as(i64, -9223372036854775808), val.bigint);
}

test "read bytes" {
    var mem: [32]u8 = undefined;
    @memset(&mem, 0);

    // Write bytes header at offset 0: length = 3, then [0xDE, 0xAD, 0xBE]
    writeU32(&mem, 0, 3);
    mem[4] = 0xDE;
    mem[5] = 0xAD;
    mem[6] = 0xBE;

    const b = readBytesSlice(&mem, 0);
    try std.testing.expectEqual(@as(usize, 3), b.len);
    try std.testing.expectEqual(@as(u8, 0xDE), b[0]);
    try std.testing.expectEqual(@as(u8, 0xAD), b[1]);
    try std.testing.expectEqual(@as(u8, 0xBE), b[2]);
}

test "read array elements" {
    // Handle at 0 → data at 4
    // Data: capacity=4, length=3, then 3 value slots
    var mem: [128]u8 = undefined;
    @memset(&mem, 0);

    const handle_ptr: u32 = 0;
    const data_ptr: u32 = 4;

    writeU32(&mem, handle_ptr, data_ptr);
    writeU32(&mem, data_ptr, 4); // capacity
    writeU32(&mem, data_ptr + 4, 3); // length

    // Write 3 i32 values
    writeI32Val(&mem, data_ptr + ARRAY_HEADER + 0 * VALUE_SLOT, 10);
    writeI32Val(&mem, data_ptr + ARRAY_HEADER + 1 * VALUE_SLOT, 20);
    writeI32Val(&mem, data_ptr + ARRAY_HEADER + 2 * VALUE_SLOT, 30);

    const arr = ArrayReader.init(&mem, handle_ptr);
    try std.testing.expectEqual(@as(u32, 3), arr.len());
    try std.testing.expectEqual(@as(i32, 10), arr.get(0).i32);
    try std.testing.expectEqual(@as(i32, 20), arr.get(1).i32);
    try std.testing.expectEqual(@as(i32, 30), arr.get(2).i32);
    try std.testing.expectEqual(Value.null, arr.get(3)); // out of bounds
}

test "C ABI: read/write f64 via exports" {
    var mem: [32]u8 = undefined;
    @memset(&mem, 0);

    zerobuf_write_f64(&mem, 0, 3.14);
    try std.testing.expectEqual(@as(u8, @intFromEnum(Tag.f64)), zerobuf_tag(&mem, 0));
    try std.testing.expectApproxEqAbs(@as(f64, 3.14), zerobuf_read_f64(&mem, 0), 0.001);
}

test "C ABI: read/write i64 via exports" {
    var mem: [32]u8 = undefined;
    @memset(&mem, 0);

    zerobuf_write_i64(&mem, 0, 9223372036854775807);
    try std.testing.expectEqual(@as(i64, 9223372036854775807), zerobuf_read_i64(&mem, 0));
}

test "C ABI: object get/set via exports" {
    var mem: [64]u8 = undefined;
    @memset(&mem, 0);

    const handle_ptr: u32 = 0;
    const data_ptr: u32 = 4;
    const entry_start: u32 = data_ptr + OBJECT_HEADER;
    const key_data: u32 = entry_start + OBJECT_ENTRY;

    writeU32(&mem, handle_ptr, data_ptr);
    writeU32(&mem, data_ptr, 4);
    writeU32(&mem, data_ptr + 4, 1);
    writeU32(&mem, entry_start, key_data);
    writeU32(&mem, entry_start + 4, 1);
    writeF64Val(&mem, entry_start + 8, 1.0);
    mem[key_data] = 'x';

    // Read via C ABI
    const val = zerobuf_object_get_f64(&mem, 64, handle_ptr, "x", 1);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), val, 0.001);

    // Write via C ABI
    const ok = zerobuf_object_set_f64(&mem, 64, handle_ptr, "x", 1, 42.0);
    try std.testing.expectEqual(@as(u32, 1), ok);

    // Verify
    try std.testing.expectApproxEqAbs(@as(f64, 42.0), zerobuf_object_get_f64(&mem, 64, handle_ptr, "x", 1), 0.001);

    // Not found
    try std.testing.expectEqual(@as(u32, 0), zerobuf_object_set_f64(&mem, 64, handle_ptr, "y", 1, 0));
}
