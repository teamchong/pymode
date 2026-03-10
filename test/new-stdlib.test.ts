import { describe, it, expect } from "vitest";
import { runPython } from "./helpers";

/**
 * Hands-on tests for newly bundled stdlib modules: csv, pathlib, pprint.
 * Validates they actually work in PyMode's workerd runtime.
 */

// ---------------------------------------------------------------------------
// csv module
// ---------------------------------------------------------------------------
describe("csv module", () => {
  it("reads CSV with csv.reader", async () => {
    const result = await runPython(`
import csv
import io

data = "name,age,city\\nAlice,30,London\\nBob,25,Paris"
reader = csv.reader(io.StringIO(data))
header = next(reader)
rows = list(reader)
print(f"{header}|{len(rows)}|{rows[0]}")
`);
    expect(result.text).toBe("['name', 'age', 'city']|2|['Alice', '30', 'London']");
  });

  it("reads CSV with csv.DictReader", async () => {
    const result = await runPython(`
import csv
import io

data = "name,age\\nAlice,30\\nBob,25"
reader = csv.DictReader(io.StringIO(data))
rows = list(reader)
print(f"{rows[0]['name']}:{rows[0]['age']},{rows[1]['name']}:{rows[1]['age']}")
`);
    expect(result.text).toBe("Alice:30,Bob:25");
  });

  it("writes CSV with csv.writer", async () => {
    const result = await runPython(`
import csv
import io

out = io.StringIO()
writer = csv.writer(out)
writer.writerow(["x", "y", "z"])
writer.writerow([1, 2, 3])
lines = out.getvalue().strip().splitlines()
print(f"{lines[0]}|{lines[1]}")
`);
    expect(result.text).toBe("x,y,z|1,2,3");
  });

  it("handles quoting and escaping", async () => {
    const result = await runPython(`
import csv
import io

out = io.StringIO()
writer = csv.writer(out)
writer.writerow(["hello, world", 'say "hi"', "normal"])
line = out.getvalue().strip()
print(line)
`);
    expect(result.text).toBe('"hello, world","say ""hi""",normal');
  });

  it("uses DictWriter", async () => {
    const result = await runPython(`
import csv
import io

out = io.StringIO()
writer = csv.DictWriter(out, fieldnames=["name", "score"])
writer.writeheader()
writer.writerow({"name": "Alice", "score": 95})
writer.writerow({"name": "Bob", "score": 87})
lines = out.getvalue().strip().splitlines()
print(f"{len(lines)}|{lines[0]}|{lines[2]}")
`);
    expect(result.text).toBe("3|name,score|Bob,87");
  });
});

// ---------------------------------------------------------------------------
// pathlib module
// ---------------------------------------------------------------------------
describe("pathlib module", () => {
  it("parses path components", async () => {
    const result = await runPython(`
from pathlib import PurePosixPath

p = PurePosixPath("/usr/local/bin/python")
print(f"name={p.name},stem={p.stem},suffix={p.suffix},parent={p.parent}")
`);
    expect(result.text).toBe("name=python,stem=python,suffix=,parent=/usr/local/bin");
  });

  it("handles file extensions", async () => {
    const result = await runPython(`
from pathlib import PurePosixPath

p = PurePosixPath("archive.tar.gz")
print(f"name={p.name},stem={p.stem},suffix={p.suffix},suffixes={p.suffixes}")
`);
    expect(result.text).toBe("name=archive.tar.gz,stem=archive.tar,suffix=.gz,suffixes=['.tar', '.gz']");
  });

  it("joins paths", async () => {
    const result = await runPython(`
from pathlib import PurePosixPath

p = PurePosixPath("/home/user")
full = p / "documents" / "file.txt"
print(str(full))
`);
    expect(result.text).toBe("/home/user/documents/file.txt");
  });

  it("matches glob patterns", async () => {
    const result = await runPython(`
from pathlib import PurePosixPath

paths = [
    PurePosixPath("src/main.py"),
    PurePosixPath("src/utils.py"),
    PurePosixPath("src/data.json"),
    PurePosixPath("tests/test_main.py"),
]
py_files = [str(p) for p in paths if p.match("*.py")]
print(",".join(py_files))
`);
    expect(result.text).toBe("src/main.py,src/utils.py,tests/test_main.py");
  });

  it("resolves relative components", async () => {
    const result = await runPython(`
from pathlib import PurePosixPath

p = PurePosixPath("/usr/local/../bin/./python")
parts = p.parts
print(f"parts={parts}")
`);
    // PurePosixPath normalizes single dots away but preserves ..
    expect(result.text).toBe("parts=('/', 'usr', 'local', '..', 'bin', 'python')");
  });

  it("checks path properties", async () => {
    const result = await runPython(`
from pathlib import PurePosixPath

abs_p = PurePosixPath("/etc/hosts")
rel_p = PurePosixPath("src/main.py")
print(f"abs={abs_p.is_absolute()},rel={rel_p.is_absolute()},root={abs_p.root}")
`);
    expect(result.text).toBe("abs=True,rel=False,root=/");
  });
});

// ---------------------------------------------------------------------------
// pprint module
// ---------------------------------------------------------------------------
describe("pprint module", () => {
  it("formats nested dicts", async () => {
    const result = await runPython(`
import pprint

data = {"users": [{"name": "Alice", "age": 30}, {"name": "Bob", "age": 25}], "count": 2}
output = pprint.pformat(data, width=60)
# Verify it's multi-line formatted (not single-line like repr)
lines = output.strip().split("\\n")
print(f"lines={len(lines)},starts={output[:1]}")
`);
    const lines = result.text.split("\n");
    const parsed = Object.fromEntries(lines[0].split(",").map(p => p.split("=")));
    expect(parseInt(parsed["lines"])).toBeGreaterThan(1);
    expect(parsed["starts"]).toBe("{");
  });

  it("formats with pformat", async () => {
    const result = await runPython(`
import pprint

data = list(range(20))
output = pprint.pformat(data, width=40)
print(output)
`);
    // pprint wraps long lists across multiple lines
    expect(result.text).toContain("0");
    expect(result.text).toContain("19");
  });

  it("handles depth limiting", async () => {
    const result = await runPython(`
import pprint

data = {"a": {"b": {"c": {"d": "deep"}}}}
output = pprint.pformat(data, depth=2)
print(output)
`);
    expect(result.text).toContain("...");
  });

  it("formats sets and tuples", async () => {
    const result = await runPython(`
import pprint

data = {"tuple": (1, 2, 3), "list": [4, 5, 6]}
output = pprint.pformat(data)
print(output)
`);
    expect(result.text).toContain("(1, 2, 3)");
    expect(result.text).toContain("[4, 5, 6]");
  });
});
