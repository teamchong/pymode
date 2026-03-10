import { describe, it, expect } from "vitest";
import { runPython } from "./helpers";

/**
 * Tests for packages installed via pymode-install.py.
 * Validates that PyPI packages bundled into site-packages.zip
 * actually import and work inside the workerd runtime.
 *
 * Before running: python3 scripts/pymode-install.py jinja2 markupsafe click pyyaml --no-deps
 */

describe("zip mount", () => {
  it("has site-packages.zip on sys.path and zipimport works", async () => {
    const r = await runPython(`
import sys
import os
import zipimport

zip_path = "/stdlib/site-packages.zip"
print(f"exists={os.path.exists(zip_path)}")
print(f"in_path={zip_path in sys.path}")

# Try loading yaml directly from zipimporter
zi = zipimport.zipimporter(zip_path)
mod = zi.load_module("yaml")
print(f"loaded={mod.__name__}")
`);
    expect(r.text).toContain("exists=True");
    expect(r.text).toContain("in_path=True");
    expect(r.text).toContain("loaded=yaml");
  });
});

describe("jinja2", () => {
  it("renders a template", async () => {
    const r = await runPython(`
import jinja2
env = jinja2.Environment()
t = env.from_string("Hello {{ name }}!")
print(t.render(name="PyMode"))
`);
    expect(r.text).toBe("Hello PyMode!");
  });

  it("renders with loops and conditionals", async () => {
    const r = await runPython(`
import jinja2
env = jinja2.Environment()
t = env.from_string("{% for item in items %}{% if item > 2 %}{{ item }},{% endif %}{% endfor %}")
print(t.render(items=[1, 2, 3, 4, 5]))
`);
    expect(r.text).toBe("3,4,5,");
  });

  it("renders with filters", async () => {
    const r = await runPython(`
import jinja2
env = jinja2.Environment()
t = env.from_string("{{ name|upper }} is {{ age }} years old")
print(t.render(name="alice", age=30))
`);
    expect(r.text).toBe("ALICE is 30 years old");
  });
});

describe("click", () => {
  it("imports and has core types", async () => {
    const r = await runPython(`
import click
print(f"has_command={hasattr(click, 'command')}")
print(f"has_group={hasattr(click, 'group')}")
print(f"has_option={hasattr(click, 'option')}")
`);
    expect(r.text).toContain("has_command=True");
    expect(r.text).toContain("has_group=True");
    expect(r.text).toContain("has_option=True");
  });
});

describe("pyyaml", () => {
  it("parses YAML", async () => {
    const r = await runPython(`
import yaml
data = yaml.safe_load("""
name: PyMode
version: 1.0
features:
  - wasm
  - workers
  - kv
""")
print(f"name={data['name']},features={len(data['features'])}")
`);
    expect(r.text).toBe("name=PyMode,features=3");
  });

  it("dumps YAML", async () => {
    const r = await runPython(`
import yaml
data = {"key": "value", "list": [1, 2, 3]}
output = yaml.safe_dump(data, default_flow_style=True).strip()
print(output)
`);
    expect(r.text).toContain("key: value");
  });
});

describe("markupsafe", () => {
  it("escapes HTML", async () => {
    const r = await runPython(`
from markupsafe import Markup, escape
result = escape("<script>alert('xss')</script>")
print(result)
`);
    expect(r.text).toContain("&lt;script&gt;");
  });
});
