"""Zero-copy binary data exchange with JS via shared WASM linear memory.

Both Python and JS operate on the same memory layout — no JSON serialization,
no copying. JS writes request data using the zerobuf npm package's defineSchema,
Python reads it directly at the same offsets. Python writes response data,
JS reads it back.

Layout constants (must match zerobuf npm package):
    VALUE_SLOT = 16    # bytes per tagged value
    STRING_HEADER = 4  # u32 byte length prefix
    ARRAY_HEADER = 8   # capacity u32 + length u32
    OBJECT_HEADER = 8  # capacity u32 + count u32
    OBJECT_ENTRY = 24  # keyPtr u32 + keyLen u32 + value (16 bytes)

Tag values:
    0=null, 1=bool, 2=i32, 3=f64, 4=string, 5=array, 6=object, 7=bigint, 8=bytes

Usage with schema (fixed-layout, field at base + index * VALUE_SLOT):

    from pymode.zerobuf import Schema

    # Define schema matching JS: defineSchema(["method", "path", "body"])
    RequestSchema = Schema(["method", "path", "body"])

    # Read request written by JS at a known base offset
    method = RequestSchema.read(base_ptr, "method")   # str
    path = RequestSchema.read(base_ptr, "path")        # str

    # Write response
    ResponseSchema = Schema(["status", "contentType", "body"])
    ResponseSchema.write_i32(resp_ptr, "status", 200)
    ResponseSchema.write_string_at(resp_ptr, "contentType", "text/plain")

Low-level access:

    import _zerobuf
    val = _zerobuf.read_f64(offset)
    _zerobuf.write_i32(offset, 42)
    name = _zerobuf.object_get_string(handle_ptr, "name")
"""

import _zerobuf

# Re-export constants
VALUE_SLOT = _zerobuf.VALUE_SLOT
STRING_HEADER = _zerobuf.STRING_HEADER
ARRAY_HEADER = _zerobuf.ARRAY_HEADER
OBJECT_HEADER = _zerobuf.OBJECT_HEADER
OBJECT_ENTRY = _zerobuf.OBJECT_ENTRY

TAG_NULL = _zerobuf.TAG_NULL
TAG_BOOL = _zerobuf.TAG_BOOL
TAG_I32 = _zerobuf.TAG_I32
TAG_F64 = _zerobuf.TAG_F64
TAG_STRING = _zerobuf.TAG_STRING
TAG_ARRAY = _zerobuf.TAG_ARRAY
TAG_OBJECT = _zerobuf.TAG_OBJECT
TAG_BIGINT = _zerobuf.TAG_BIGINT
TAG_BYTES = _zerobuf.TAG_BYTES

# Re-export low-level functions
tag = _zerobuf.tag
read_i32 = _zerobuf.read_i32
read_f64 = _zerobuf.read_f64
read_i64 = _zerobuf.read_i64
read_bool = _zerobuf.read_bool
read_string = _zerobuf.read_string
read_bytes = _zerobuf.read_bytes
read_len = _zerobuf.read_len
deref = _zerobuf.deref
write_i32 = _zerobuf.write_i32
write_f64 = _zerobuf.write_f64
write_i64 = _zerobuf.write_i64
write_bool = _zerobuf.write_bool
write_null = _zerobuf.write_null
array_len = _zerobuf.array_len
array_element_offset = _zerobuf.array_element_offset
object_count = _zerobuf.object_count
object_find = _zerobuf.object_find
object_get_f64 = _zerobuf.object_get_f64
object_get_i32 = _zerobuf.object_get_i32
object_get_i64 = _zerobuf.object_get_i64
object_get_string = _zerobuf.object_get_string
object_set_f64 = _zerobuf.object_set_f64
object_set_i32 = _zerobuf.object_set_i32
object_set_i64 = _zerobuf.object_set_i64
write_string_at = _zerobuf.write_string_at
write_string_slot = _zerobuf.write_string_slot
schema_read_field = _zerobuf.schema_read_field

NOT_FOUND = 0xFFFFFFFF


class Schema:
    """Fixed-layout schema matching JS defineSchema().

    Fields are at base + index * VALUE_SLOT (16 bytes each).
    Field order must match the JS defineSchema field list exactly.
    """

    __slots__ = ("_fields",)

    def __init__(self, fields):
        self._fields = {name: i for i, name in enumerate(fields)}

    def offset(self, base, field):
        return base + self._fields[field] * VALUE_SLOT

    def read(self, base, field):
        return _zerobuf.schema_read_field(base, self._fields[field])

    def read_f64(self, base, field):
        return _zerobuf.read_f64(self.offset(base, field))

    def read_i32(self, base, field):
        return _zerobuf.read_i32(self.offset(base, field))

    def read_i64(self, base, field):
        return _zerobuf.read_i64(self.offset(base, field))

    def read_bool(self, base, field):
        return _zerobuf.read_bool(self.offset(base, field))

    def read_string(self, base, field):
        return _zerobuf.read_string(self.offset(base, field))

    def read_bytes(self, base, field):
        return _zerobuf.read_bytes(self.offset(base, field))

    def write_f64(self, base, field, value):
        _zerobuf.write_f64(self.offset(base, field), value)

    def write_i32(self, base, field, value):
        _zerobuf.write_i32(self.offset(base, field), value)

    def write_i64(self, base, field, value):
        _zerobuf.write_i64(self.offset(base, field), value)

    def write_bool(self, base, field, value):
        _zerobuf.write_bool(self.offset(base, field), value)

    def write_null(self, base, field):
        _zerobuf.write_null(self.offset(base, field))

    def write_string(self, base, field, value, pool_addr):
        """Write a string field. Returns bytes written to pool."""
        written = _zerobuf.write_string_at(pool_addr, value)
        _zerobuf.write_string_slot(self.offset(base, field), pool_addr)
        return written
