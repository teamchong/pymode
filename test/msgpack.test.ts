// msgpack tests — validates msgpack pack/unpack with the native _cmsgpack C extension.

import { describe, it, expect } from "vitest";
import { runPython as run } from "./helpers";

describe("msgpack: native _cmsgpack module", () => {
  it("imports msgpack successfully", async () => {
    const { text, status } = await run(`
import msgpack
print(msgpack.__version__)
`);
    expect(status).toBe(200);
    expect(text).toBe("1.1.2");
  });

  it("packs and unpacks basic types", async () => {
    const { text, status } = await run(`
import msgpack
import json

data = {"int": 42, "str": "hello", "list": [1, 2, 3], "bool": True, "none": None, "float": 3.14}
packed = msgpack.packb(data)
unpacked = msgpack.unpackb(packed)

# Compare values (msgpack may use different key types)
result = {
    "int": unpacked["int"] if isinstance(unpacked.get("int"), int) else unpacked[b"int"],
    "str_match": unpacked.get("str") == "hello" or unpacked.get(b"str") == b"hello",
    "list_len": len(unpacked.get("list") or unpacked.get(b"list")),
    "packed_type": type(packed).__name__,
    "packed_size": len(packed),
}
print(json.dumps(result))
`);
    expect(status).toBe(200);
    const result = JSON.parse(text);
    expect(result.int).toBe(42);
    expect(result.str_match).toBe(true);
    expect(result.list_len).toBe(3);
    expect(result.packed_type).toBe("bytes");
    expect(result.packed_size).toBeGreaterThan(0);
    expect(result.packed_size).toBeLessThan(100);
  });

  it("handles nested structures", async () => {
    const { text, status } = await run(`
import msgpack
import json

data = {"users": [{"name": "Alice", "scores": [95, 87, 92]}, {"name": "Bob", "scores": [88, 91, 85]}]}
packed = msgpack.packb(data, use_bin_type=True)
unpacked = msgpack.unpackb(packed, raw=False)
print(json.dumps(unpacked))
`);
    expect(status).toBe(200);
    const result = JSON.parse(text);
    expect(result.users).toHaveLength(2);
    expect(result.users[0].name).toBe("Alice");
    expect(result.users[1].scores).toEqual([88, 91, 85]);
  });

  it("handles binary data", async () => {
    const { text, status } = await run(`
import msgpack
import json

data = b"\\x00\\x01\\x02\\xff"
packed = msgpack.packb(data, use_bin_type=True)
unpacked = msgpack.unpackb(packed, raw=False)
print(json.dumps({"match": unpacked == data, "len": len(unpacked)}))
`);
    expect(status).toBe(200);
    const result = JSON.parse(text);
    expect(result.match).toBe(true);
    expect(result.len).toBe(4);
  });

  it("Packer and Unpacker streaming API", async () => {
    const { text, status } = await run(`
import msgpack
import json

packer = msgpack.Packer(use_bin_type=True)
chunks = []
for item in [1, "two", [3], {"four": 4}]:
    chunks.append(packer.pack(item))
combined = b"".join(chunks)

unpacker = msgpack.Unpacker(raw=False)
unpacker.feed(combined)
results = list(unpacker)
print(json.dumps(results))
`);
    expect(status).toBe(200);
    const results = JSON.parse(text);
    expect(results).toEqual([1, "two", [3], { four: 4 }]);
  });

  it("handles large data efficiently", async () => {
    const { text, status } = await run(`
import msgpack
import json

data = list(range(10000))
packed = msgpack.packb(data)
unpacked = msgpack.unpackb(packed)
print(json.dumps({"match": unpacked == data, "packed_size": len(packed)}))
`);
    expect(status).toBe(200);
    const result = JSON.parse(text);
    expect(result.match).toBe(true);
    expect(result.packed_size).toBeLessThan(50000);
  });

  it("ExtType round-trip", async () => {
    const { text, status } = await run(`
import msgpack
import json

ext = msgpack.ExtType(42, b"custom_data")
packed = msgpack.packb(ext, use_bin_type=True)
unpacked = msgpack.unpackb(packed, raw=False)
print(json.dumps({
    "code": unpacked.code,
    "data_len": len(unpacked.data),
}))
`);
    expect(status).toBe(200);
    const result = JSON.parse(text);
    expect(result.code).toBe(42);
    expect(result.data_len).toBe(11);
  });

  it("ormsgpack polyfill uses native msgpack underneath", async () => {
    const { text, status } = await run(`
import ormsgpack
import json

data = {"key": "value", "number": 42}
packed = ormsgpack.packb(data)
unpacked = ormsgpack.unpackb(packed)
print(json.dumps({"match": unpacked == data, "type": type(packed).__name__}))
`);
    expect(status).toBe(200);
    const result = JSON.parse(text);
    expect(result.match).toBe(true);
    expect(result.type).toBe("bytes");
  });
});
