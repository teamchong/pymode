// R2-backed filesystem tests — Python open()/read()/write() on /data/ paths
//
// Tests the full production path through PythonDO:
//   Python open('/data/hello.txt', 'w') → WASI fd_open(FD_DATA_PREOPEN, ...)
//   → WASI fd_write → writtenFiles map → flushDataFiles → R2 bucket
//
// Requires: wrangler dev running with FS_BUCKET binding (test/wrangler.toml)

import { describe, it, expect } from "vitest";
import { runPython } from "./helpers";

describe("R2 filesystem (/data)", () => {
  it("writes and reads a file in /data", async () => {
    const { text, status } = await runPython(`
import os
with open('/data/hello.txt', 'w') as f:
    f.write('hello from pymode')
with open('/data/hello.txt', 'r') as f:
    content = f.read()
print(f"content={content}")
`);
    if (status !== 200) console.log("fs write/read error:", text);
    expect(status).toBe(200);
    expect(text).toContain("content=hello from pymode");
  });

  it("writes binary data to /data", async () => {
    const { text, status } = await runPython(`
data = bytes(range(256))
with open('/data/binary.bin', 'wb') as f:
    f.write(data)
with open('/data/binary.bin', 'rb') as f:
    content = f.read()
print(f"len={len(content)}")
print(f"first={content[0]}")
print(f"last={content[255]}")
`);
    expect(status).toBe(200);
    expect(text).toContain("len=256");
    expect(text).toContain("first=0");
    expect(text).toContain("last=255");
  });

  it("creates directories in /data", async () => {
    const { text, status } = await runPython(`
import os
os.makedirs('/data/subdir/nested', exist_ok=True)
with open('/data/subdir/nested/file.txt', 'w') as f:
    f.write('nested content')
with open('/data/subdir/nested/file.txt', 'r') as f:
    print(f"content={f.read()}")
`);
    expect(status).toBe(200);
    expect(text).toContain("content=nested content");
  });

  it("lists files in /data with os.listdir", async () => {
    const { text, status } = await runPython(`
import os
os.makedirs('/data/listtest', exist_ok=True)
with open('/data/listtest/a.txt', 'w') as f:
    f.write('a')
with open('/data/listtest/b.txt', 'w') as f:
    f.write('b')
entries = sorted(os.listdir('/data/listtest'))
print(f"entries={entries}")
`);
    expect(status).toBe(200);
    expect(text).toContain("a.txt");
    expect(text).toContain("b.txt");
  });

  it("checks file existence with os.path.exists", async () => {
    const { text, status } = await runPython(`
import os
with open('/data/exists_test.txt', 'w') as f:
    f.write('test')
print(f"exists={os.path.exists('/data/exists_test.txt')}")
print(f"missing={os.path.exists('/data/no_such_file.txt')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("exists=True");
    expect(text).toContain("missing=False");
  });

  it("overwrites existing files", async () => {
    const { text, status } = await runPython(`
with open('/data/overwrite.txt', 'w') as f:
    f.write('original')
with open('/data/overwrite.txt', 'w') as f:
    f.write('updated')
with open('/data/overwrite.txt', 'r') as f:
    print(f"content={f.read()}")
`);
    expect(status).toBe(200);
    expect(text).toContain("content=updated");
  });

  it("gets file size with os.path.getsize", async () => {
    const { text, status } = await runPython(`
import os
with open('/data/size_test.txt', 'w') as f:
    f.write('12345')
size = os.path.getsize('/data/size_test.txt')
print(f"size={size}")
`);
    expect(status).toBe(200);
    expect(text).toContain("size=5");
  });

  it("/tmp is writable but separate from /data", async () => {
    const { text, status } = await runPython(`
import os
with open('/tmp/temp.txt', 'w') as f:
    f.write('temp data')
with open('/tmp/temp.txt', 'r') as f:
    print(f"tmp={f.read()}")
print(f"tmp_exists={os.path.exists('/tmp/temp.txt')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("tmp=temp data");
    expect(text).toContain("tmp_exists=True");
  });
});
