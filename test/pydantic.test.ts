// Pydantic + FastAPI tests using python-pydantic-core.wasm variant.
//
// pydantic_core is a Rust+PyO3 extension compiled to wasm32-wasip1
// and statically linked into the python-pydantic-core.wasm binary.

import { describe, it, expect } from "vitest";
import { runPython as run } from "./helpers";

describe("pydantic", () => {
  it("validates models with type coercion", async () => {
    const { text, status } = await run(`
from pydantic import BaseModel

class User(BaseModel):
    name: str
    age: int
    email: str = "none"

u = User(name="Alice", age="30", email="alice@example.com")
print(f"name={u.name}")
print(f"age={u.age}")
print(f"type_age={type(u.age).__name__}")
print(f"email={u.email}")
`);
    expect(text + " [status=" + status + "]").toContain("name=Alice");
    expect(text).toContain("age=30");
    expect(text).toContain("type_age=int");
    expect(text).toContain("email=alice@example.com");
  });

  it("rejects invalid data with validation errors", async () => {
    const { text, status } = await run(`
from pydantic import BaseModel, ValidationError

class Config(BaseModel):
    host: str
    port: int
    debug: bool = False

try:
    Config(host="localhost", port="not_a_number")
    print("ERROR: should have raised")
except ValidationError as e:
    print(f"errors={e.error_count()}")
    print(f"type={e.errors()[0]['type']}")
    print("validation_works=True")
`);
    expect(status).toBe(200);
    expect(text).toContain("validation_works=True");
  });

  it("serializes models to JSON", async () => {
    const { text, status } = await run(`
from pydantic import BaseModel
import json

class Item(BaseModel):
    name: str
    price: float
    tags: list[str] = []

item = Item(name="Widget", price=9.99, tags=["sale", "new"])
j = item.model_dump_json()
parsed = json.loads(j)
print(f"name={parsed['name']}")
print(f"price={parsed['price']}")
print(f"tags={parsed['tags']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("name=Widget");
    expect(text).toContain("price=9.99");
  });
});

describe("fastapi", () => {
  it("creates typed API with request validation", { timeout: 30000 }, async () => {
    const { text, status } = await run(`
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class Item(BaseModel):
    name: str
    price: float

@app.post("/items")
async def create_item(item: Item):
    return {"name": item.name, "price": item.price}

routes = [r.path for r in app.routes]
print(f"routes={routes}")
print(f"has_items={'items' in str(routes)}")
print(f"app_type={type(app).__name__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_items=True");
    expect(text).toContain("app_type=FastAPI");
  });
});
