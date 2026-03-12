"""ormsgpack polyfill — delegates to msgpack (native _cmsgpack)."""
import msgpack

# Option flags (match ormsgpack's Rust API)
OPT_NON_STR_KEYS = 1
OPT_SERIALIZE_NUMPY = 2
OPT_PASSTHROUGH_DATETIME = 4
OPT_PASSTHROUGH_DATACLASS = 8
OPT_PASSTHROUGH_ENUM = 16
OPT_PASSTHROUGH_UUID = 32
OPT_REPLACE_SURROGATES = 64
OPT_SORT_KEYS = 128

MsgpackEncodeError = ValueError
MsgpackDecodeError = ValueError

def packb(obj, *, default=None, option=None, **kwargs):
    return msgpack.packb(obj, use_bin_type=True, default=default, **kwargs)

def unpackb(data, *, option=None, **kwargs):
    return msgpack.unpackb(data, raw=False, **kwargs)
