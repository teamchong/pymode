"""ormsgpack polyfill — delegates to msgpack (native _cmsgpack)."""
import msgpack

def packb(obj, **kwargs):
    return msgpack.packb(obj, use_bin_type=True, **kwargs)

def unpackb(data, **kwargs):
    return msgpack.unpackb(data, raw=False, **kwargs)
