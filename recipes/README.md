# PyMode Build Recipes

Each JSON file defines how to compile a C extension package for wasm32-wasi.

## Recipe format

```json
{
  "name": "package-name",
  "version": "1.2.3",
  "pypi": "package-name",
  "type": "c|cython|rust|system",
  "sources": ["src/*.c"],
  "includes": ["src/"],
  "cflags": ["-DFOO=1"],
  "modules": {
    "package.module": "PyInit_module"
  },
  "python_packages": ["package/"],
  "depends": []
}
```

## Building

```bash
# Build a specific recipe
./scripts/build-recipe.sh numpy

# Build all recipes needed by a project
pymode build
```
